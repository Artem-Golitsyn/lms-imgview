import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResolvedMention } from "./mentions.js";

const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif|bmp|avif|tiff?)$/iu;
const GENERATED_PREVIEW = /\.e\d+\.q\d+\.jpe?g$/iu;

export interface ImageLibrary {
  imagesDirectory: string;
  /** Chat folder. LM Studio renders a markdown image only when the file is here. */
  workDirectory: string | null;
}

export function imagesDirectoryMissingMessage(directory: string): string {
  return `Images directory not found: ${directory}`;
}

export class ImagesDirectoryMissingError extends Error {
  constructor(directory: string) {
    super(directory);
    this.name = "ImagesDirectoryMissingError";
  }
}

interface NameIndex {
  expiresAt: number;
  /** Lowercase file name to absolute paths. */
  byName: Map<string, string[]>;
}

const indexes = new Map<string, NameIndex>();

/**
 * Finds a file in the library and returns markdown for the chat image and the original path.
 * Returns `null` when the image is not in the directory.
 */
export function createImageResolver(
  library: ImageLibrary,
  warn: (message: string) => void,
): (ref: string) => Promise<ResolvedMention | null> {
  const memo = new Map<string, ResolvedMention>();
  return async (ref) => {
    let original: string | null;
    try {
      original = await findImage(library, ref);
    } catch (error) {
      if (error instanceof ImagesDirectoryMissingError) {
        warn(imagesDirectoryMissingMessage(error.message));
      } else {
        warn(`Could not read the images directory: ${messageOf(error)}`);
      }
      return null;
    }
    if (!original) return null;
    const cached = memo.get(original);
    if (cached) return cached;
    try {
      const src = await publishToChat(library.workDirectory, original, path.extname(original));
      const resolved = {
        id: original,
        markdown: imageMarkdown(path.basename(original), src, original),
      };
      memo.set(original, resolved);
      return resolved;
    } catch (error) {
      warn(`Could not build a preview for ${path.basename(original)}: ${messageOf(error)}`);
      return null;
    }
  };
}

export function imageMarkdown(displayName: string, imageSrc: string, originalPath: string): string {
  const label = displayName.replace(/[[\]\r\n]/g, "");
  return `![${label}](${imageSrc})\n\n${originalReference(label, originalPath)}`;
}

/**
 * LM Studio's chat markdown drops any `file:` address, so the link uses the absolute path.
 * A drive path such as `C:\...` contains a colon and is dropped the same way, so it is shown as text.
 */
function originalReference(label: string, originalPath: string): string {
  if (!isChatLinkPath(originalPath)) return `\`${originalPath.replace(/`/g, "")}\``;
  return `[${label}](<${originalPath.replace(/[<>]/g, "")}>)`;
}

function isChatLinkPath(filePath: string): boolean {
  return filePath.startsWith("/") && !filePath.includes(":");
}

async function findImage(library: ImageLibrary, ref: string): Promise<string | null> {
  const root = await existingDirectory(library.imagesDirectory);
  const direct = directCandidates(root, ref);
  for (const candidate of direct) {
    const hit = await fileInside(root, candidate);
    if (hit) return hit;
  }

  const baseName = path.basename(ref.trim());
  if (!IMAGE_NAME.test(baseName)) return null;
  let matches = (await nameIndex(root)).get(baseName.toLowerCase());
  if (!matches?.length) {
    indexes.delete(root);
    matches = (await nameIndex(root)).get(baseName.toLowerCase());
  }
  if (!matches?.length) return null;
  return matches.find((file) => path.basename(file) === baseName) ?? matches[0] ?? null;
}

function directCandidates(root: string, ref: string): string[] {
  const trimmed = ref.trim();
  const candidates: string[] = [];
  if (trimmed.startsWith("file:")) {
    try {
      candidates.push(fileURLToPath(trimmed));
    } catch {
      // Not a file URL. The value is handled as a normal path below.
    }
  }
  if (path.isAbsolute(trimmed)) candidates.push(trimmed);
  candidates.push(path.resolve(root, trimmed));
  return candidates;
}

async function existingDirectory(directory: string): Promise<string> {
  let real: string;
  try {
    real = await realpath(directory);
  } catch {
    throw new ImagesDirectoryMissingError(directory);
  }
  const info = await stat(real);
  if (!info.isDirectory()) throw new ImagesDirectoryMissingError(directory);
  return real;
}

async function fileInside(root: string, candidate: string): Promise<string | null> {
  const resolved = path.resolve(candidate);
  if (!isInside(root, resolved)) return null;
  let real: string;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return null;
    real = await realpath(resolved);
  } catch {
    return null;
  }
  if (!isInside(root, real)) return null;
  if (!IMAGE_NAME.test(real) || GENERATED_PREVIEW.test(path.basename(real))) return null;
  return real;
}

async function nameIndex(root: string): Promise<Map<string, string[]>> {
  const cached = indexes.get(root);
  if (cached && cached.expiresAt > Date.now()) return cached.byName;

  const byName = new Map<string, string[]>();
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_NAME.test(entry.name) || GENERATED_PREVIEW.test(entry.name)) continue;
    const full = path.join(entry.parentPath, entry.name);
    const list = byName.get(entry.name.toLowerCase()) ?? [];
    list.push(full);
    byName.set(entry.name.toLowerCase(), list);
  }
  indexes.set(root, { expiresAt: Date.now() + 5_000, byName });
  return byName;
}

/**
 * Each message gets its own copy. A stable name is reused by the chat and the
 * picture in a later post does not appear.
 */
async function publishToChat(workDirectory: string | null, sourcePath: string, extension: string): Promise<string> {
  if (!workDirectory) return pathToFileURL(sourcePath).href;
  await mkdir(workDirectory, { recursive: true });
  const suffix = extension.startsWith(".") ? extension : `.${extension}`;
  const name = await unusedChatName(workDirectory, suffix);
  await copyFile(sourcePath, path.join(workDirectory, name));
  return name;
}

async function unusedChatName(workDirectory: string, suffix: string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `lms-imgview-${randomBytes(6).toString("hex")}${suffix}`;
    const existing = await stat(path.join(workDirectory, name)).catch(() => null);
    if (!existing) return name;
  }
  return `lms-imgview-${randomBytes(6).toString("hex")}${suffix}`;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
