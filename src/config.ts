import { createConfigSchematics } from "@lmstudio/sdk";

/**
 * Global settings shared by every chat.
 * When the preview directory is empty, previews are written to <images>/.preview.
 */
export const globalConfigSchematics = createConfigSchematics()
  .field(
    "imagesDirectory",
    "directory",
    {
      displayName: "Images directory",
      subtitle: "Folder where MCP image generators (z-image and others) save pictures.",
      accessPermission: "readWrite",
    },
    "",
  )
  .field(
    "makePreview",
    "boolean",
    {
      displayName: "Make preview",
      subtitle: "Off: the original image is placed in the chat. On: a smaller JPEG is shown instead.",
    },
    false,
  )
  .field(
    "previewDirectory",
    "directory",
    {
      displayName: "Preview directory",
      subtitle: "Used when Make preview is on. Leave empty to use <images directory>/.preview. The folder is created when missing.",
      accessPermission: "readWrite",
      dependencies: [{ key: "makePreview", condition: { type: "equals", value: true } }],
    },
    "",
  )
  .field(
    "maxPreviewEdge",
    "numeric",
    {
      displayName: "Maximum preview edge",
      subtitle: "Used when Make preview is on. The preview fits inside a square of this size, in pixels. Both sides are scaled down.",
      int: true,
      min: 64,
      max: 2048,
      slider: { min: 64, max: 2048, step: 32 },
      dependencies: [{ key: "makePreview", condition: { type: "equals", value: true } }],
    },
    512,
  )
  .field(
    "previewQuality",
    "numeric",
    {
      displayName: "Preview JPEG quality",
      subtitle: "Used when Make preview is on. Lower values compress the file more.",
      int: true,
      min: 30,
      max: 95,
      slider: { min: 30, max: 95, step: 1 },
      dependencies: [{ key: "makePreview", condition: { type: "equals", value: true } }],
    },
    70,
  )
  .build();
