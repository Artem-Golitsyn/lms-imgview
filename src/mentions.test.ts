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
