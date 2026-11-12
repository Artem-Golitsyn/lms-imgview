import type { PluginContext } from "@lmstudio/sdk";
import { globalConfigSchematics } from "./config.js";
import { predictionLoop } from "./predictionLoop.js";

export async function main(context: PluginContext): Promise<void> {
  context.withGlobalConfigSchematics(globalConfigSchematics);
  context.withPredictionLoopHandler(predictionLoop);
}
