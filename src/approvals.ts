import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * LM Studio stores "Always allow" outside the plugin. A prediction-loop plugin
 * that calls requestConfirmToolCall is prompted again anyway, so the same
 * settings are checked here first.
 */
export interface ToolApprovalSettings {
  neverAskForToolConfirmation?: boolean;
  skipToolConfirmationPatterns?: unknown;
}

export function isToolPreapproved(
  settings: ToolApprovalSettings | undefined,
  pluginIdentifier: string | undefined,
  toolName: string,
): boolean {
  if (settings?.neverAskForToolConfirmation === true) return true;
  if (!pluginIdentifier) return false;
  const patterns = Array.isArray(settings?.skipToolConfirmationPatterns)
    ? settings.skipToolConfirmationPatterns.filter((pattern): pattern is string => typeof pattern === "string")
    : [];
  return patterns.some((pattern) => matchesApprovalPattern(pattern, pluginIdentifier, toolName));
}

export async function readToolApprovalSettings(
  settingsPath = join(homedir(), ".lmstudio", "settings.json"),
): Promise<ToolApprovalSettings> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as { chat?: ToolApprovalSettings };
    return parsed.chat ?? {};
  } catch {
    return {};
  }
}

/** A pattern is "plugin:tool". "*" matches within one side and does not cross the colon. */
function matchesApprovalPattern(pattern: string, pluginIdentifier: string, toolName: string): boolean {
  const split = pattern.indexOf(":");
  if (split < 0) return false;
  return wildcard(pattern.slice(0, split), pluginIdentifier) && wildcard(pattern.slice(split + 1), toolName);
}

function wildcard(pattern: string, name: string): boolean {
  const pieces = pattern.split("*");
  if (pieces.length === 1) return pattern === name;
  const first = pieces[0] ?? "";
  const last = pieces[pieces.length - 1] ?? "";
  if (!name.startsWith(first) || !name.endsWith(last) || name.length < first.length + last.length) return false;
  let at = first.length;
  const end = name.length - last.length;
  for (const piece of pieces.slice(1, -1)) {
    const found = name.indexOf(piece, at);
    if (found < 0 || found + piece.length > end) return false;
    at = found + piece.length;
  }
  return true;
}
