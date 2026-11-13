import { createConfigSchematics } from "@lmstudio/sdk";

/** Global settings shared by every chat. */
export const globalConfigSchematics = createConfigSchematics()
  .field(
    "imagesDirectory",
    "directory",
    {
      displayName: "Images directory",
      subtitle: "Folder where image generators save pictures.",
      accessPermission: "readWrite",
    },
    "",
  )
  .build();
