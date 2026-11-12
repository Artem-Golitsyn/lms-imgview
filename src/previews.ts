import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Jimp } from "jimp";
import type { ResolvedMention } from "./mentions.js";

const IMAGE_NAME = /\.(?:png|jpe?g|webp|gif|bmp|avif|tiff?)$/iu;
const GENERATED_PREVIEW = /\.e\d+\.q\d+\.jpe?g$/iu;

export interface ImageLibrary {
  imagesDirectory: string;
  previewDirectory: string;
  maxPreviewEdge: number;
  previewQuality: number;
  /** When false, the original file is copied into the chat and no JPEG is written. */
  makePreview: boolean;
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
      const source = library.makePreview ? await ensurePreview(library, original) : original;
      const extension = library.makePreview ? ".jpg" : path.extname(original);
      const src = await publishToChat(library.workDirectory, source, extension);
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

/** Link under the picture. The address is a file URL of the original. */
function originalReference(label: string, originalPath: string): string {
  return `[${label}](<${fileHref(originalPath)}>)`;
}

function fileHref(filePath: string): string {
  const drive = /^([A-Za-z]):[\\/](.*)$/.exec(filePath);
  if (drive && process.platform !== "win32") {
    const rest = drive[2]
      .replace(/\\/g, "/")
      .split("/")
      .filter((segment) => segment.length > 0)
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    return `file:///${drive[1]}:/${rest}`;
  }
  return pathToFileURL(filePath).href;
}

async function findImage(library: ImageLibrary, ref: string): Promise<string | null> {
  const root = await existingDirectory(library.imagesDirectory);
  const previewRoot = previewDirectoryOf(library);
  const direct = directCandidates(root, ref);
  for (const candidate of direct) {
    const hit = await fileInside(root, previewRoot, candidate);
    if (hit) return hit;
  }

  const baseName = path.basename(ref.trim());
  if (!IMAGE_NAME.test(baseName)) return null;
  let matches = (await nameIndex(root, previewRoot)).get(baseName.toLowerCase());
  if (!matches?.length) {
    indexes.delete(indexKey(root, previewRoot));
    matches = (await nameIndex(root, previewRoot)).get(baseName.toLowerCase());
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

async function fileInside(root: string, previewRoot: string, candidate: string): Promise<string | null> {
  const resolved = path.resolve(candidate);
  if (!isInside(root, resolved) || isInside(previewRoot, resolved)) return null;
  let real: string;
  try {
    const info = await stat(resolved);
    if (!info.isFile()) return null;
    real = await realpath(resolved);
  } catch {
    return null;
  }
  if (!isInside(root, real) || isInside(previewRoot, real)) return null;
  if (!IMAGE_NAME.test(real) || GENERATED_PREVIEW.test(path.basename(real))) return null;
  return real;
}

async function nameIndex(root: string, previewRoot: string): Promise<Map<string, string[]>> {
  const key = indexKey(root, previewRoot);
  const cached = indexes.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.byName;

  const byName = new Map<string, string[]>();
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_NAME.test(entry.name) || GENERATED_PREVIEW.test(entry.name)) continue;
    const full = path.join(entry.parentPath, entry.name);
    if (isInside(previewRoot, full)) continue;
    const list = byName.get(entry.name.toLowerCase()) ?? [];
    list.push(full);
    byName.set(entry.name.toLowerCase(), list);
  }
  indexes.set(key, { expiresAt: Date.now() + 5_000, byName });
  return byName;
}

function previewDirectoryOf(library: ImageLibrary): string {
  const configured = library.previewDirectory.trim();
  return path.resolve(configured || path.join(library.imagesDirectory, ".preview"));
}

function indexKey(root: string, previewRoot: string): string {
  return `${root}\0${previewRoot}`;
}

async function ensurePreview(library: ImageLibrary, original: string): Promise<string> {
  const root = await existingDirectory(library.imagesDirectory);
  const relative = isInside(root, original) ? path.relative(root, original) : path.basename(original);
  const parsed = path.parse(relative);
  const dest = path.join(
    previewDirectoryOf(library),
    parsed.dir,
    `${parsed.name}.e${library.maxPreviewEdge}.q${library.previewQuality}.jpg`,
  );
  const sourceStat = await stat(original);
  const destStat = await stat(dest).catch(() => null);
  if (destStat?.isFile() && destStat.size > 0 && destStat.mtimeMs >= sourceStat.mtimeMs) return dest;

  const image = await Jimp.read(await readFile(original));
  const edge = library.maxPreviewEdge;
  if (image.width > edge || image.height > edge) {
    const scale = Math.min(edge / image.width, edge / image.height);
    image.resize({
      w: Math.max(1, Math.round(image.width * scale)),
      h: Math.max(1, Math.round(image.height * scale)),
    });
  }
  const bytes = await image.getBuffer("image/jpeg", { quality: library.previewQuality });
  await mkdir(path.dirname(dest), { recursive: true });
  const temporary = `${dest}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, dest);
  return dest;
}

async function publishToChat(workDirectory: string | null, sourcePath: string, extension: string): Promise<string> {
  if (!workDirectory) return pathToFileURL(sourcePath).href;
  await mkdir(workDirectory, { recursive: true });
  const suffix = extension.startsWith(".") ? extension : `.${extension}`;
  const name = `lms-imgview-${createHash("sha256").update(sourcePath).digest("hex").slice(0, 12)}${suffix}`;
  await copyFile(sourcePath, path.join(workDirectory, name));
  return name;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
