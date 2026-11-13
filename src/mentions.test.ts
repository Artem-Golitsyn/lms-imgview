import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findMentions, markdownForNewMentions, replaceMentions, type ResolvedMention } from "./mentions.js";

function resolver(known: Record<string, string>) {
  return async (ref: string): Promise<ResolvedMention | null> => {
    const id = known[ref];
    if (!id) return null;
    return { id, markdown: `![${ref}](preview.jpg)\n\n[${ref}](file:///orig/${ref})` };
  };
}

describe("findMentions", () => {
  it("recognizes File, the generator label Файл, brackets, quotes, and backticks", () => {
    const text = [
      "Файл: cat.png",
      "Файл: [кот.png]",
      'File: "my cat.png"',
      "File: `shot.jpeg`",
      "**Файл:** cover.webp",
      "**File:** `cover.webp`",
      "`File: wrapped.png`",
    ].join("\n");
    assert.deepEqual(
      findMentions(text).map((mention) => mention.ref),
      ["cat.png", "кот.png", "my cat.png", "shot.jpeg", "cover.webp", "cover.webp", "wrapped.png"],
    );
  });

  it("leaves code and names without an image extension alone", () => {
    const text = "File: notes.txt\n```\nFile: hidden.png\n```\nand also file: nope";
    assert.deepEqual(findMentions(text), []);
  });

  it("keeps a full path and strips a trailing period", () => {
    const [mention] = findMentions("Done. File: /tmp/out/cat.png.");
    assert.equal(mention?.ref, "/tmp/out/cat.png");
  });

  it("finds image paths without a File label and leaves a bare name", () => {
    const text = [
      "Saved /tmp/out/cat.png.",
      "also images/кот.png",
      "and file:///tmp/out/shot.jpeg",
      'plus "C:\\images\\my cat.png"',
      "and C:\\images\\cat.png",
      "but not cat.png in a sentence",
    ].join("\n");
    assert.deepEqual(
      findMentions(text).map((mention) => mention.ref),
      ["/tmp/out/cat.png", "images/кот.png", "file:///tmp/out/shot.jpeg", "C:\\images\\my cat.png", "C:\\images\\cat.png"],
    );
  });

  it("leaves quotes, indented code, tilde fences, and JSON alone", () => {
    const text = [
      "> File: quote.png",
      "    File: indented.png",
      "~~~",
      "File: tilde.png",
      "~~~",
      "{",
      '  "file": "/tmp/out/from-json.png"',
      "}",
      '{"path":"/tmp/out/inline.png"}',
      "File: kept.png",
      "See /tmp/out/kept.png",
    ].join("\n");
    assert.deepEqual(
      findMentions(text).map((mention) => mention.ref),
      ["kept.png", "/tmp/out/kept.png"],
    );
  });

  it("does not find a second path inside a File label or a code fence", () => {
    const text = "File: /tmp/out/cat.png\n```\n/tmp/hidden.png\n```\nSee images/cover.webp";
    assert.deepEqual(
      findMentions(text).map((mention) => mention.ref),
      ["/tmp/out/cat.png", "images/cover.webp"],
    );
  });
});

describe("replaceMentions", () => {
  it("inserts a preview and a link, then drops a repeat of the same file", async () => {
    const shown = new Set<string>();
    const resolve = resolver({ "cat.png": "/img/cat.png" });
    const first = await replaceMentions("Look.\nFile: cat.png\nEnd.", resolve, shown);
    assert.match(first, /!\[cat\.png\]\(preview\.jpg\)/);
    assert.match(first, /\[cat\.png\]\(file:\/\/\/orig\/cat\.png\)/);
    assert.doesNotMatch(first, /File:/);
    assert.match(first, /Look/);
    assert.match(first, /End/);

    const second = await replaceMentions("Again\nFile: cat.png", resolve, shown);
    assert.equal(second, "Again\n");
  });

  it("keeps the name when the file is not in the directory", async () => {
    const text = "Файл: missing.png";
    const next = await replaceMentions(text, resolver({}), new Set());
    assert.equal(next, text);
  });

  it("removes backticks wrapped around the file line", async () => {
    const next = await replaceMentions("`File: cat.png`", resolver({ "cat.png": "/img/cat.png" }), new Set());
    assert.equal(next.includes("`"), false);
    assert.match(next, /!\[cat\.png\]/);
  });

  it("removes a backtick left alone on the next line", async () => {
    const next = await replaceMentions("File: cat.png\n`\nThanks.", resolver({ "cat.png": "/img/cat.png" }), new Set());
    assert.equal(next.includes("`"), false);
    assert.match(next, /Thanks/);
  });

  it("keeps a backtick that belongs to later text", async () => {
    const next = await replaceMentions("File: cat.png\nsee `code`", resolver({ "cat.png": "/img/cat.png" }), new Set());
    assert.match(next, /see `code`/);
  });

  it("replaces a path when the file exists and keeps one that does not", async () => {
    const next = await replaceMentions(
      "Look /tmp/out/cat.png and /tmp/missing.png.\nFile: cat.png",
      resolver({ "/tmp/out/cat.png": "/img/from-path", "cat.png": "/img/from-label" }),
      new Set(),
    );
    assert.match(next, /!\[\/tmp\/out\/cat\.png\]/);
    assert.match(next, /!\[cat\.png\]/);
    assert.match(next, /\/tmp\/missing\.png/);
    assert.doesNotMatch(next, /File:/);
    assert.match(next, /Look/);
  });
});

describe("markdownForNewMentions", () => {
  it("returns only images that have not been shown yet", async () => {
    const shown = new Set<string>();
    const resolve = resolver({ "a.png": "/a", "b.png": "/b" });
    const first = await markdownForNewMentions("Файл: a.png\nФайл: b.png", resolve, shown);
    assert.match(first, /a\.png/);
    assert.match(first, /b\.png/);
    const second = await markdownForNewMentions("Файл: a.png", resolve, shown);
    assert.equal(second, "");
  });
});
