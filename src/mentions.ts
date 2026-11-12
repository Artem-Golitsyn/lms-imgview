/**
 * Finds generator lines such as "File: name.png" or "Файл: name.png"
 * and replaces those mentions.
 */

const EXTENSION_RE = /\.(?:png|jpe?g|webp|gif|bmp|avif|tiff?)$/iu;

/** \x60 is a backtick. A fresh RegExp per call keeps lastIndex from racing across tasks. */
function mentionPattern(): RegExp {
  return /(?<![\p{L}\p{N}_])(?:\*{1,2}|_{1,2})?(?:Файл|File)(?:\*{1,2}|_{1,2})?\s*:\s*(?:\*{1,2}|_{1,2})?\s*(?:"([^"\n]+)"|'([^'\n]+)'|\x60([^\x60\n]+)\x60|\[([^\]\n]+)\]|([^\n]*?\.(?:png|jpe?g|webp|gif|bmp|avif|tiff?)))/giu;
}

export interface Mention {
  /** Index where the File: mention starts in the source string. */
  start: number;
  /** Index just after the mention. */
  end: number;
  /** Image name or path, without quotes or brackets. */
  ref: string;
}

export function hasMention(text: string): boolean {
  return findMentions(text).length > 0;
}

export function findMentions(text: string): Mention[] {
  const mentions: Mention[] = [];
  for (const region of codeRegions(text)) {
    if (region.code) continue;
    for (const match of region.value.matchAll(mentionPattern())) {
      const raw = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "";
      const ref = cleanRef(raw);
      if (!EXTENSION_RE.test(ref)) continue;
      const localStart = match.index ?? 0;
      const bounds = includeWrappingBackticks(
        region.value,
        localStart,
        localStart + match[0].length,
      );
      let start = region.start + bounds.start;
      const end = region.start + bounds.end;
      const previousEnd = mentions.at(-1)?.end ?? 0;
      if (start < previousEnd) start = previousEnd;
      if (end <= start) continue;
      mentions.push({ start, end, ref });
    }
  }
  return mentions;
}

export interface ResolvedMention {
  /** Stable file id, so the same picture is not shown twice. */
  id: string;
  markdown: string;
}

/**
 * Replaces mentions of existing images with markdown.
 * A repeat of the same file in this reply is removed: the picture is already shown.
 * Names that were not found stay as they are.
 */
export async function replaceMentions(
  text: string,
  resolve: (ref: string) => Promise<ResolvedMention | null>,
  shown: Set<string>,
): Promise<string> {
  const mentions = findMentions(text);
  if (mentions.length === 0) return text;

  let result = "";
  let cursor = 0;
  for (const mention of mentions) {
    result += text.slice(cursor, mention.start);
    const resolved = await resolve(mention.ref);
    if (!resolved) {
      result += text.slice(mention.start, mention.end);
      cursor = mention.end;
      continue;
    }
    if (shown.has(resolved.id)) {
      const line = lineBounds(text, mention.start, mention.end);
      const onlyThisMention =
        text.slice(line.start, mention.start).trim() === "" &&
        text.slice(mention.end, line.endOfContent).trim() === "";
      if (onlyThisMention) {
        const alreadyCopied = mention.start - line.start;
        result = result.slice(0, result.length - alreadyCopied);
        cursor = line.end;
      } else {
        cursor = mention.end;
      }
      continue;
    }
    shown.add(resolved.id);
    const gap = result.length > 0 && !result.endsWith("\n") ? "\n\n" : result.endsWith("\n\n") ? "" : result.length > 0 ? "\n" : "";
    result += `${gap}${resolved.markdown}\n\n`;
    cursor = mention.end;
  }
  result += text.slice(cursor);
  return result.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Markdown only for images in the text that have not been shown yet.
 * Found ids are added to `shown` immediately.
 */
export async function markdownForNewMentions(
  text: string,
  resolve: (ref: string) => Promise<ResolvedMention | null>,
  shown: Set<string>,
): Promise<string> {
  const parts: string[] = [];
  for (const mention of findMentions(text)) {
    const resolved = await resolve(mention.ref);
    if (!resolved || shown.has(resolved.id)) continue;
    shown.add(resolved.id);
    parts.push(resolved.markdown);
  }
  return parts.join("\n\n");
}

function cleanRef(raw: string): string {
  let value = raw.trim();
  if (
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith("(") && value.endsWith(")")) ||
    (value.startsWith("<") && value.endsWith(">"))
  ) {
    value = value.slice(1, -1).trim();
  }
  value = value.replace(/^`+|`+$/g, "").trim();
  value = value.replace(/^(?:\*{1,2}|_{1,2})+|(?:\*{1,2}|_{1,2})+$/g, "").trim();
  value = value.replace(/[.,;:!?]+$/u, "");
  return value;
}

/**
 * A model often wraps the whole File line in backticks, or leaves a lone backtick
 * on the next line. Those characters are not part of the file name.
 */
function includeWrappingBackticks(text: string, start: number, end: number): { start: number; end: number } {
  let from = start;
  let to = end;
  if (from > 0 && text[from - 1] === "`" && to < text.length && text[to] === "`") {
    from -= 1;
    to += 1;
  }
  const before = /(?:^|\n)[ \t]*`[ \t]*\n[ \t]*$/.exec(text.slice(0, from));
  if (before) {
    const lineBreak = before[0].startsWith("\n") ? 1 : 0;
    from = from - before[0].length + lineBreak;
  }
  const after = /^(?:[ \t]*\n)[ \t]*`[ \t]*(?=\n|$)/.exec(text.slice(to));
  if (after) to += after[0].length;
  if (text[to] === "`" && (to + 1 === text.length || text[to + 1] === "\n")) to += 1;
  return { start: from, end: to };
}

interface Region {
  code: boolean;
  start: number;
  value: string;
}

/** Leaves text inside fenced ``` blocks alone. An unclosed fence counts as code too. */
function codeRegions(text: string): Region[] {
  const regions: Region[] = [];
  const fence = /```/g;
  let cursor = 0;
  let inCode = false;
  for (const match of text.matchAll(fence)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      regions.push({ code: inCode, start: cursor, value: text.slice(cursor, index) });
    }
    inCode = !inCode;
    cursor = index + match[0].length;
  }
  if (cursor < text.length) {
    regions.push({ code: inCode, start: cursor, value: text.slice(cursor) });
  }
  return regions;
}

function lineBounds(text: string, start: number, end: number): { start: number; end: number; endOfContent: number } {
  const startOfLine = text.lastIndexOf("\n", start - 1) + 1;
  const breakAt = text.indexOf("\n", end);
  return {
    start: startOfLine,
    end: breakAt === -1 ? text.length : breakAt + 1,
    endOfContent: breakAt === -1 ? text.length : breakAt,
  };
}
