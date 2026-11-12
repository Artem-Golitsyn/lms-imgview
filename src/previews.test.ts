import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Jimp } from "jimp";
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
  it("scales the picture on both sides and links to the original", async () => {
    const source = path.join(images, "кот.png");
    const image = new Jimp({ width: 800, height: 200, color: 0xff0000ff });
    await image.write(source as `${string}.${string}`);

    const warnings: string[] = [];
    const resolve = createImageResolver(
      {
        imagesDirectory: images,
        previewDirectory: "",
        maxPreviewEdge: 100,
        previewQuality: 60,
        makePreview: true,
        workDirectory: work,
      },
      (message) => warnings.push(message),
    );

    const shown = new Set<string>();
    const text = await replaceMentions("Файл: кот.png", resolve, shown);
    assert.equal(warnings.length, 0);
    assert.match(text, /!\[кот\.png\]\(lms-imgview-[0-9a-f]{12}\.jpg\)/);
    assert.match(text, /\[кот\.png\]\(<file:\/\/\/.+%D0%BA%D0%BE%D1%82\.png>\)/);

    const preview = path.join(images, ".preview", "кот.e100.q60.jpg");
    const previewImage = await Jimp.read(await readFile(preview));
    assert.ok(previewImage.width <= 100);
    assert.ok(previewImage.height <= 100);
    assert.ok(previewImage.width < 800);
    assert.ok(previewImage.height < 200);

    const copied = await stat(path.join(work, text.match(/lms-imgview-[0-9a-f]{12}\.jpg/)?.[0] ?? ""));
    assert.ok(copied.size > 0);

    const again = await replaceMentions("Файл: кот.png", resolve, shown);
    assert.doesNotMatch(again, /!\[/);
  });

  it("ignores a file outside the directory", async () => {
    const foreign = path.join(outside, "secret.png");
    await new Jimp({ width: 4, height: 4, color: 0x00ff00ff }).write(foreign as `${string}.${string}`);
    const resolve = createImageResolver(
      {
        imagesDirectory: images,
        previewDirectory: path.join(images, ".preview"),
        maxPreviewEdge: 64,
        previewQuality: 70,
        makePreview: true,
        workDirectory: work,
      },
      () => undefined,
    );
    const resolved = await resolve(foreign);
    assert.equal(resolved, null);
    const escaped = await resolve("../outside/secret.png");
    assert.equal(escaped, null);
  });

  it("copies the original into the chat when previews are off", async () => {
    const source = path.join(images, "plain.png");
    await new Jimp({ width: 20, height: 10, color: 0x0000ffff }).write(source as `${string}.${string}`);
    const resolve = createImageResolver(
      {
        imagesDirectory: images,
        previewDirectory: path.join(images, ".preview"),
        maxPreviewEdge: 8,
        previewQuality: 40,
        makePreview: false,
        workDirectory: work,
      },
      () => undefined,
    );
    const resolved = await resolve("plain.png");
    assert.ok(resolved);
    assert.match(resolved.markdown, /!\[plain\.png\]\(lms-imgview-[0-9a-f]{12}\.png\)/);
    assert.match(resolved.markdown, /\[plain\.png\]\(<file:\/\/\/.+plain\.png>\)/);
    const copiedName = resolved.markdown.match(/lms-imgview-[0-9a-f]{12}\.png/)?.[0] ?? "";
    const copied = await readFile(path.join(work, copiedName));
    const original = await readFile(source);
    assert.deepEqual(copied, original);
    await assert.rejects(stat(path.join(images, ".preview", "plain.e8.q40.jpg")));
  });
});

describe("imageMarkdown", () => {
  it("links to the original with a file URL", () => {
    assert.equal(
      imageMarkdown("cat.png", "chat.png", "/images/my cat.png"),
      "![cat.png](chat.png)\n\n[cat.png](<file:///images/my%20cat.png>)",
    );
    assert.equal(
      imageMarkdown("cat.png", "chat.png", "C:\\images\\cat.png"),
      "![cat.png](chat.png)\n\n[cat.png](<file:///C:/images/cat.png>)",
    );
  });
});
