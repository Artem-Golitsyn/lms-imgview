/**
 * Finds image mentions in a reply and replaces those that exist on disk.
 * A mention is either a File:/Файл: label or a path that contains a folder separator.
 */

const EXTENSION_RE = /\.(?:png|jpe?g|webp|gif|bmp|avif|tiff?)$/iu;
const EXTENSION = "png|jpe?g|webp|gif|bmp|avif|tiff?";

/** \x60 is a backtick. A fresh RegExp per call keeps lastIndex from racing across tasks. */
function mentionPattern(): RegExp {
  return /(?<![\p{L}\p{N}_])(?:\*{1,2}|_{1,2})?(?:Файл|File)(?:\*{1,2}|_{1,2})?\s*:(?!\s*[/\\]{2})\s*(?:\*{1,2}|_{1,2})?\s*(?:"([^"\n]+)"|'([^'\n]+)'|\x60([^\x60\n]+)\x60|\[([^\]\n]+)\]|([^\n]*?\.(?:png|jpe?g|webp|gif|bmp|avif|tiff?)))/giu;
}

/**
 * Paths without a File: label. A bare name such as cat.png is not a path:
 * that still requires File: or Файл:, so ordinary sentences stay as text.
 */
function pathPattern(): RegExp {
  const name = "[^\\s<>\"'`()\\[\\]\\\\/]+";
  const ext = `\\.(?:${EXTENSION})`;
  const unquoted = [
    `file://\\S+?${ext}`,
    `[A-Za-z]:[\\\\/](?:${name}[\\\\/])*${name}${ext}`,
    `(?:\\.{1,2}[\\\\/]|[\\\\/])(?:${name}[\\\\/])*${name}${ext}`,
    `(?:${name}[\\\\/])+${name}${ext}`,
  ].join("|");
  const quoted = `[^"'\\x60\\n]*[\\\\/][^"'\\x60\\n]*${ext}`;
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:\"(?:${quoted})\"|'(?:${quoted})'|\\x60(?:${quoted})\\x60|<(?:${quoted})>|${unquoted})`,
    "giu",
  );
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
  for (const region of proseRegions(text)) {
    const labeled = mentionsIn(region, mentionPattern(), true);
    const paths = mentionsIn(region, pathPattern(), false).filter(
      (pathMention) => !labeled.some((mention) => pathMention.start < mention.end && pathMention.end > mention.start),
    );
    mentions.push(...labeled, ...paths);
  }
  mentions.sort((a, b) => a.start - b.start);
  return mentions;
}

function mentionsIn(region: Region, pattern: RegExp, labeled: boolean): Mention[] {
  const mentions: Mention[] = [];
  for (const match of region.value.matchAll(pattern)) {
    const raw = labeled ? (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? "") : match[0];
    const ref = cleanRef(raw);
    if (!EXTENSION_RE.test(ref)) continue;
    const localStart = match.index ?? 0;
    const localEnd = localStart + match[0].length;
    const bounds = labeled
      ? includeWrappingBackticks(region.value, localStart, localEnd)
      : includeWrappingQuotes(region.value, localStart, localEnd);
    let start = region.start + bounds.start;
    const end = region.start + bounds.end;
    const previousEnd = mentions.at(-1)?.end ?? region.start;
    if (start < previousEnd) start = previousEnd;
    if (end <= start) continue;
    mentions.push({ start, end, ref });
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
    (value.startsWith("<") && value.endsWith(">")) ||
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
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
function includeWrappingQuotes(text: string, start: number, end: number): { start: number; end: number } {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["<", ">"],
  ];
  if (start === 0 || end >= text.length) return { start, end };
  for (const [open, close] of pairs) {
    if (text[start - 1] === open && text[end] === close) return { start: start - 1, end: end + 1 };
  }
  return { start, end };
}

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
  start: number;
  value: string;
}

interface Range {
  start: number;
  end: number;
}

interface Line {
  start: number;
  end: number;
  text: string;
}

/**
 * Plain prose only. Code fences, indented code, blockquotes, and JSON values
 * stay as text. An MCP result is often a JSON block with no markdown marker.
 */
function proseRegions(text: string): Region[] {
  const skipped = mergeRanges([
    ...fenceRanges(text),
    ...blockquoteRanges(text),
    ...indentedCodeRanges(text),
    ...jsonRanges(text),
  ]);
  const regions: Region[] = [];
  let cursor = 0;
  for (const range of skipped) {
    if (range.start > cursor) regions.push({ start: cursor, value: text.slice(cursor, range.start) });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < text.length) regions.push({ start: cursor, value: text.slice(cursor) });
  return regions;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "\n") continue;
    lines.push({ start, end: index + 1, text: text.slice(start, index) });
    start = index + 1;
  }
  lines.push({ start, end: text.length, text: text.slice(start) });
  return lines;
}

/** ``` and ~~~ fences. An unclosed fence counts through the end of the text. */
function fenceRanges(text: string): Range[] {
  const ranges: Range[] = [];
  let open: { char: string; len: number; start: number } | null = null;
  for (const line of linesOf(text)) {
    const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (!open) {
      if (match) open = { char: match[2][0] ?? "`", len: match[2].length, start: line.start };
      continue;
    }
    if (match && match[2][0] === open.char && match[2].length >= open.len && match[3].trim() === "") {
      ranges.push({ start: open.start, end: line.end });
      open = null;
    }
  }
  if (open) ranges.push({ start: open.start, end: text.length });
  return ranges;
}

function blockquoteRanges(text: string): Range[] {
  return lineRuns(text, (line) => /^ {0,3}>/.test(line));
}

function indentedCodeRanges(text: string): Range[] {
  return lineRuns(text, (line) => /^(?: {4}|\t)/.test(line) && line.trim() !== "");
}

function lineRuns(text: string, inside: (line: string) => boolean): Range[] {
  const ranges: Range[] = [];
  let start: number | null = null;
  let end = 0;
  for (const line of linesOf(text)) {
    if (inside(line.text)) {
      start ??= line.start;
      end = line.end;
      continue;
    }
    if (start !== null) {
      ranges.push({ start, end });
      start = null;
    }
  }
  if (start !== null) ranges.push({ start, end });
  return ranges;
}

/** Objects and arrays. MCP tools often return a picture path inside JSON. */
function jsonRanges(text: string): Range[] {
  const ranges: Range[] = [];
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch !== "{" && ch !== "[") continue;
    if (index > 0 && /[\p{L}\p{N}_]/u.test(text[index - 1] ?? "")) continue;
    const end = jsonValueEnd(text, index);
    if (end === null) continue;
    ranges.push({ start: index, end });
    index = end - 1;
  }
  return ranges;
}

function jsonValueEnd(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index++) {
    const ch = text[index];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth !== 0) continue;
      const slice = text.slice(start, index + 1);
      try {
        const value = JSON.parse(slice) as unknown;
        if (value !== null && typeof value === "object") return index + 1;
      } catch {
        return null;
      }
      return null;
    }
  }
  return null;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = ranges.filter((range) => range.end > range.start).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ start: range.start, end: range.end });
  }
  return merged;
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
