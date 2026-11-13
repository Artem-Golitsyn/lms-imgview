import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createImageResolver, imageMarkdown } from "./previews.js";
import { replaceMentions } from "./mentions.js";

describe("createImageResolver", () => {
  let root = "";
  let images = "";
  let work = "";
  let outside = "";

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lms-imgview-"));
    images = path.join(root, "images");
    work = path.join(root, "work");
    outside = path.join(root, "outside");
    await mkdir(images, { recursive: true });
    await mkdir(outside, { recursive: true });
  });

  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  it("copies the original into the chat and links to it", async () => {
    const source = path.join(images, "кот.png");
    await writeFile(source, "png-bytes");
    const warnings: string[] = [];
    const resolve = createImageResolver({ imagesDirectory: images, workDirectory: work }, (message) => warnings.push(message));
    const shown = new Set<string>();
    const text = await replaceMentions("Файл: кот.png", resolve, shown);
    assert.equal(warnings.length, 0);
    assert.match(text, /!\[кот\.png\]\(lms-imgview-[0-9a-f]{12}\.png\)/);
    assert.match(text, /\[кот\.png\]\(<\/.+кот\.png>\)/);
    assert.doesNotMatch(text, /file:/);
    const copiedName = text.match(/lms-imgview-[0-9a-f]{12}\.png/)?.[0] ?? "";
    assert.equal(await readFile(path.join(work, copiedName), "utf8"), "png-bytes");
    const again = await replaceMentions("Файл: кот.png", resolve, shown);
    assert.doesNotMatch(again, /!\[/);
  });

  it("ignores a file outside the directory", async () => {
    const foreign = path.join(outside, "secret.png");
    await writeFile(foreign, "secret");
    const resolve = createImageResolver({ imagesDirectory: images, workDirectory: work }, () => undefined);
    const resolved = await resolve(foreign);
    assert.equal(resolved, null);
    const escaped = await resolve("../outside/secret.png");
    assert.equal(escaped, null);
  });

  it("writes a separate chat file for each post of the same image", async () => {
    const source = path.join(images, "again.png");
    await writeFile(source, "again");
    const library = { imagesDirectory: images, workDirectory: work };
    const first = await createImageResolver(library, () => undefined)("again.png");
    const second = await createImageResolver(library, () => undefined)("again.png");
    assert.ok(first);
    assert.ok(second);
    const nameOf = (markdown: string) => markdown.match(/lms-imgview-[0-9a-f]{12}\.png/)?.[0] ?? "";
    const firstName = nameOf(first.markdown);
    const secondName = nameOf(second.markdown);
    assert.notEqual(firstName, "");
    assert.notEqual(firstName, secondName);
    assert.equal(await readFile(path.join(work, firstName), "utf8"), "again");
    assert.equal(await readFile(path.join(work, secondName), "utf8"), "again");
  });
});

describe("imageMarkdown", () => {
  it("links to the absolute path and spells out a Windows path", () => {
    assert.equal(
      imageMarkdown("cat.png", "chat.png", "/images/my cat.png"),
      "![cat.png](chat.png)\n\n[cat.png](</images/my cat.png>)",
    );
    assert.equal(
      imageMarkdown("cat.png", "chat.png", "C:\\images\\cat.png"),
      "![cat.png](chat.png)\n\n`C:\\images\\cat.png`",
    );
  });
});
