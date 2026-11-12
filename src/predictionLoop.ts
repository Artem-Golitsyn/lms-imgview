import path from "node:path";
import type {
  GeneratorPredictionResult,
  LLM,
  LLMActionOpts,
  PredictionLoopHandlerController,
  PredictionProcessContentBlockController,
  PredictionResult,
  Tool,
  ToolCallContext,
} from "@lmstudio/sdk";
import { globalConfigSchematics } from "./config.js";
import { hasMention, markdownForNewMentions, replaceMentions } from "./mentions.js";
import { createImageResolver, imagesDirectoryMissingMessage, type ImageLibrary } from "./previews.js";

type TokenSource = LLM;
type AnyResult = PredictionResult | GeneratorPredictionResult;

interface TextState {
  block: PredictionProcessContentBlockController;
  text: string;
}

/**
 * Reply loop. The model and MCP tools run as usual, and a File: name in the
 * text or in a tool result is replaced with a preview.
 */
export async function predictionLoop(ctl: PredictionLoopHandlerController): Promise<void> {
  const history = await ctl.pullHistory();
  const source = (await ctl.tokenSource()) as TokenSource;
  const library = readLibrary(ctl);
  const shown = new Set<string>();
  const pendingImages = new Map<number, string>();
  let warned = false;
  const warn = (message: string) => {
    if (warned) return;
    warned = true;
    ctl.createStatus({ status: "error", text: message });
  };
  const resolve = library
    ? createImageResolver(library, (message) => {
        if (message.startsWith(imagesDirectoryMissingMessage(""))) {
          warn(message);
          return;
        }
        ctl.debug(message);
      })
    : async () => null;

  let textBlock: PredictionProcessContentBlockController | undefined;
  let reasoning: PredictionProcessContentBlockController | undefined;
  let roundText = "";
  let lastText: TextState | null = null;
  let chain: Promise<void> = Promise.resolve();

  const enqueue = (task: () => Promise<void>): Promise<void> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const rewrite = async (state: TextState) => {
    if (!library) {
      if (hasMention(state.text)) {
        warn("Set the images directory in the plugin's global settings (the gear icon).");
      }
      return;
    }
    const next = await replaceMentions(state.text, resolve, shown);
    if (next !== state.text) {
      state.block.replaceText(next);
      state.text = next;
    }
  };

  const session = await openTools(ctl);
  const tools = watchTools(session?.tools ?? [], async (output, callId) => {
    await enqueue(async () => {
      if (!library) {
        if (hasMention(output)) {
          warn("Set the images directory in the plugin's global settings (the gear icon).");
        }
        return;
      }
      const markdown = await markdownForNewMentions(output, resolve, shown);
      if (markdown) pendingImages.set(callId, markdown);
      if (lastText) await rewrite(lastText);
    });
  });

  const statuses = new Map<number, ReturnType<PredictionLoopHandlerController["createToolStatus"]>>();
  const startedAt = new Map<number, number>();

  try {
    await source.act(history, tools, {
      signal: ctl.abortSignal,
      onRoundStart: () => {
        textBlock = undefined;
        reasoning = undefined;
        roundText = "";
      },
      onPredictionFragment: (fragment) => {
        if (fragment.reasoningType === "reasoningEndTag") {
          reasoning?.setStyle({ type: "thinking", ended: true });
          reasoning = undefined;
          return;
        }
        if (fragment.isStructural || fragment.reasoningType === "reasoningStartTag") return;
        if (fragment.reasoningType === "reasoning") {
          reasoning ??= ctl.createContentBlock({ style: { type: "thinking" } });
          reasoning.appendText(fragment.content);
          return;
        }
        textBlock ??= ctl.createContentBlock();
        textBlock.appendText(fragment.content);
        roundText += fragment.content;
      },
      onPredictionCompleted: (result) => {
        const block = textBlock;
        if (block) attachStats(block, result as AnyResult);
        if (!block || !hasMention(roundText)) {
          if (block) lastText = { block, text: roundText };
          return;
        }
        const state: TextState = { block, text: roundText };
        lastText = state;
        void enqueue(() => rewrite(state));
      },
      onToolCallRequestStart: (_round, callId) => {
        statuses.set(callId, ctl.createToolStatus(callId, { type: "generatingToolCall" }));
      },
      onToolCallRequestNameReceived: (_round, callId, name) => {
        statuses.get(callId)?.setStatus({ type: "generatingToolCall", name });
      },
      onToolCallRequestArgumentFragmentGenerated: (_round, callId, content) => {
        statuses.get(callId)?.appendArgumentFragment(content);
      },
      onToolCallRequestEnd: (_round, callId, info) => {
        const request = info.toolCallRequest;
        ctl.createContentBlock().appendToolRequest({
          callId,
          toolCallRequestId: request.id,
          name: request.name,
          parameters: request.arguments ?? {},
          pluginIdentifier: pluginId(tools, request.name),
        });
        statuses.get(callId)?.setStatus({ type: info.isQueued ? "toolCallQueued" : "confirmingToolCall" });
      },
      onToolCallRequestFailure: (_round, callId, error) => {
        statuses.get(callId)?.setStatus({ type: "toolCallGenerationFailed", error: error.message });
      },
      guardToolCall: async (_round, callId, guard) => {
        statuses.get(callId)?.setStatus({ type: "confirmingToolCall" });
        try {
          const pluginIdentifier = guard.tool.type === "remoteTool" ? guard.tool.pluginIdentifier : undefined;
          const confirmation = await ctl.requestConfirmToolCall({
            callId,
            pluginIdentifier,
            name: guard.toolCallRequest.name,
            parameters: guard.toolCallRequest.arguments ?? {},
          });
          ctl.abortSignal.throwIfAborted();
          if (confirmation.type === "deny") {
            statuses.get(callId)?.setStatus({ type: "toolCallDenied", denyReason: confirmation.denyReason });
            guard.deny(confirmation.denyReason ?? "Tool call denied.");
            return;
          }
          startedAt.set(callId, performance.now());
          statuses.get(callId)?.setStatus({ type: "callingTool" });
          if (confirmation.toolArgsOverride) guard.allowAndOverrideParameters(confirmation.toolArgsOverride);
          else guard.allow();
        } catch (error) {
          if (ctl.abortSignal.aborted) {
            guard.deny("Stopped.");
            return;
          }
          ctl.debug("Tool confirmation is unavailable, allowing the call:", error);
          startedAt.set(callId, performance.now());
          statuses.get(callId)?.setStatus({ type: "callingTool" });
          guard.allow();
        }
      },
      onToolCallResult: (_round, callId, result) => {
        const started = startedAt.get(callId);
        statuses.get(callId)?.setStatus({
          type: "toolCallSucceeded",
          timeMs: started === undefined ? 0 : Math.max(0, Math.round(performance.now() - started)),
        });
        ctl.createContentBlock({ roleOverride: "tool" }).appendToolResult({
          callId,
          toolCallRequestId: result.toolCallId,
          content: result.content,
          name: result.name,
        });
        const markdown = pendingImages.get(callId);
        if (!markdown) return;
        pendingImages.delete(callId);
        ctl
          .createContentBlock({ roleOverride: "assistant", includeInContext: false })
          .appendText(markdown);
      },
    } as LLMActionOpts);
    await chain;
  } catch (error) {
    await chain;
    if (ctl.abortSignal.aborted) return;
    const message = error instanceof Error ? error.message : String(error);
    const name = error instanceof Error ? error.name : "";
    if (name === "ToolCallRequestError" || /ToolCallRequest/.test(message)) {
      ctl.createStatus({
        status: "error",
        text: "The model sent a malformed tool call. Send the message again.",
      });
      return;
    }
    throw error;
  } finally {
    session?.[Symbol.dispose]();
  }
}

function readLibrary(ctl: PredictionLoopHandlerController): ImageLibrary | null {
  const config = ctl.getGlobalPluginConfig(globalConfigSchematics);
  const imagesDirectory = config.get("imagesDirectory").trim();
  if (!imagesDirectory) return null;
  const previewOverride = config.get("previewDirectory").trim();
  let workDirectory: string | null = null;
  try {
    workDirectory = ctl.getWorkingDirectory() || null;
  } catch {
    workDirectory = null;
  }
  return {
    imagesDirectory,
    previewDirectory: previewOverride || path.join(imagesDirectory, ".preview"),
    maxPreviewEdge: clamp(config.get("maxPreviewEdge"), 64, 2048, 512),
    previewQuality: clamp(config.get("previewQuality"), 30, 95, 70),
    makePreview: config.get("makePreview") === true,
    workDirectory,
  };
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

async function openTools(
  ctl: PredictionLoopHandlerController,
): Promise<{ tools: Tool[]; [Symbol.dispose](): void } | null> {
  try {
    return await ctl.startToolUseSession();
  } catch (error) {
    ctl.debug("Tool session is unavailable:", error);
    ctl.createStatus({
      status: "error",
      text: "Tools from other plugins are unavailable, so this reply will not use them.",
    });
    return null;
  }
}

function watchTools(
  tools: Tool[],
  after: (output: string, callId: number) => Promise<void>,
): Tool[] {
  return tools.map((tool) => {
    if (tool.type === "unimplementedRawFunction") return tool;
    const implementation = tool.implementation.bind(tool);
    return {
      ...tool,
      implementation: async (params: Record<string, unknown>, ctx: ToolCallContext) => {
        const value = await implementation(params, ctx);
        const output = typeof value === "string" ? value : value == null ? "" : JSON.stringify(value);
        if (output) {
          try {
            await after(output, ctx.callId);
          } catch (error) {
            ctx.warn(`lms-imgview: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return value;
      },
    } as typeof tool;
  });
}

function pluginId(tools: Tool[], name: string): string | undefined {
  const tool = tools.find((item) => item.name === name);
  return tool?.type === "remoteTool" ? tool.pluginIdentifier : undefined;
}

function attachStats(block: PredictionProcessContentBlockController, result: AnyResult): void {
  if (!("stats" in result) || !("modelInfo" in result) || !("loadConfig" in result)) return;
  block.attachGenInfo({
    indexedModelIdentifier: result.modelInfo.modelKey,
    identifier: result.modelInfo.identifier,
    loadModelConfig: result.loadConfig,
    predictionConfig: result.predictionConfig,
    stats: result.stats,
  });
}
