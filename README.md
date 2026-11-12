# lms-imgview

An [LM Studio](https://lmstudio.ai) plugin that turns a named image file in a reply into a picture you can see.

Image tools such as z-image often end a turn with a line like this:

```text
File: cat.png
```

or, from generators that print a Russian label:

```text
Файл: cat.png
```

If that file is in the folder you choose, lms-imgview replaces the line with the picture. By default the original file is copied into the chat as it is. Turn on **Make preview** to show a smaller JPEG instead, and keep the original untouched on disk either way.

```markdown
![cat.png](lms-imgview-a1b2c3d4e5f6.png)

[cat.png](</path/to/images/cat.png>)
```

With **Make preview** on, the picture in the chat is a compressed JPEG. It is scaled down on both width and height so the longer side fits inside a square (512 pixels by default).

## Install

You need LM Studio running, Node.js, and the `lms` command-line tool (LM Studio installs it for you).

```bash
git clone <this repository>
cd lms-imgview
npm install
npx lms dev --install
```

`Successfully installed local/lms-imgview` means the plugin is in LM Studio.

Then, in the app:

1. Open a chat and enable **lms-imgview** in the plugin list.
2. Open the plugin gear and set **Images directory** to the folder your generator writes into.
3. Send a prompt that produces a `File:` or `Файл:` line for a picture that is already in that folder.

The picture appears in the assistant message. The line under it is the path of the original file.

To develop with a rebuild on every save, run `npx lms dev` from this directory instead of `--install`. Enable the plugin in the chat after the dev server is up. Use `npx lms dev --install` again when you want a normal installed copy.

If an older copy was installed under the name `fileframe` or `img-placer`, disable that one. Only one prediction-loop plugin should be active in a chat.

## Settings

Settings are global: one folder for every chat. Open them from the gear next to the plugin.

| Setting | Default | What it does |
| --- | --- | --- |
| Images directory | empty | Folder of original images. The plugin does nothing with pictures until this is set. |
| Make preview | off | Off: the original file is copied into the chat. On: a smaller JPEG is created and that JPEG is what the chat shows. |
| Preview directory | `<images directory>/.preview` | Where compressed JPEGs are stored. Shown when **Make preview** is on. An empty value uses `.preview` inside the images directory. The folder is created if it does not exist. |
| Maximum preview edge | 512 | Longest side of the preview, in pixels. The other side shrinks by the same ratio. Images that are already smaller stay at their original size. Shown when **Make preview** is on. |
| Preview JPEG quality | 70 | JPEG quality from 30 to 95. Lower values make a smaller file. Shown when **Make preview** is on. |

## What gets replaced

A mention is a label, a colon, and an image name. Both of these labels are recognized:

- `File:`
- `Файл:`

The label may be wrapped in markdown bold or italics (`**File:** cat.png`). The name may be bare, quoted, in backticks, or in square brackets. A backtick pair around the whole line is removed with the line, including a backtick left alone on the next line:

```text
File: cat.png
File: "my cat.png"
File: `shot.jpeg`
File: [cover.webp]
`File: cat.png`
```

Recognized extensions: `png`, `jpg`, `jpeg`, `webp`, `gif`, `bmp`, `avif`, `tif`, `tiff`.

A name is resolved in this order:

1. An absolute path, a `file://` URL, or a path relative to the images directory, when that path stays inside the directory.
2. The file name alone, searched recursively through the images directory.

Text inside fenced ` ``` ` code blocks is left alone. A name that is not in the directory stays as text. The same file is shown once per reply; a later mention that sits on its own line is removed. Paths that escape the images directory, including `..` and symlinks that point outside, are ignored. Generated preview files are not treated as originals.

## Where the files go

- **Originals** stay in the images directory.
- **The picture in the chat** is a copy in the chat working directory, named `lms-imgview-` plus a short hash. LM Studio renders a markdown image when the file is in that working directory. With **Make preview** off, the copy is the original file, extension included. With **Make preview** on, the copy is the JPEG preview.
- **Cached previews** are written only when **Make preview** is on, under the preview directory. The file name records the settings, for example `cat.e512.q70.jpg`. A preview is reused when it is newer than the original.

Pictures built from a tool result are attached to the assistant message and are not sent back to the model, so the model still sees the tool's original text.

## The line under the picture

LM Studio's chat removes link addresses that use the `file:` scheme, so a `file://` link never becomes clickable. The line under the picture is a markdown link whose address is the absolute path of the original file:

```markdown
[cat.png](</path/to/images/cat.png>)
```

A click opens LM Studio's link popover, where that path can be copied. The app does not open the file from the chat. The picture itself is the copy in the chat working directory; use the image menu on that picture to reveal the copy.

A Windows path such as `C:\images\cat.png` is shown as text. A link address with a drive letter is removed by the same sanitizer.

## Notes

- lms-imgview runs the prediction loop itself. Model text, tool confirmation, and MCP tool calls still go through that loop. Enable only one plugin that takes over the prediction loop.
- With **Make preview** on, PNG, JPEG, GIF, BMP, and TIFF originals can be turned into previews. WebP and AVIF names are recognized; if the decoder cannot read the file, the mention stays as text and a debug note is written. With **Make preview** off, the original bytes are copied and no decoder is required.
- The plugin sandbox is off. lms-imgview needs to read the folder you choose and, when previews are on, write them.
- Until **Images directory** is set, mentions are left as text and the chat shows a status asking you to set the folder.

## Develop

```bash
npm install
npm test
```

`npm test` typechecks the project and runs the mention and preview tests.

Artem Golitsyn (artem.golitsyn@gmail.com), 2026
