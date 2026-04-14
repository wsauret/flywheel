import type { NDJSONEvent } from "../../../infra/subprocess-types.js";
import { resolveModel } from "./claude.js";

export interface ContextUpdate {
  promptTokens: number;
  contextWindow: number;
}

// The authoritative value comes from the "result" event's modelUsage.contextWindow field,
// but that only fires when the subprocess exits — too late for mid-session warnings.
export function contextWindowForModel(model: string): number {
  const resolved = resolveModel(model);
  if (resolved.includes("[1m]")) return 1_000_000;
  if (resolved.startsWith("claude-")) return 200_000;
  // Bare aliases that didn't resolve to a full ID (e.g. "haiku") are 200k.
  const lower = resolved.toLowerCase();
  if (lower === "opus" || lower === "sonnet" || lower === "haiku") return 200_000;
  return 0;
}

export function extractContextUpdate(event: NDJSONEvent): ContextUpdate | null {
  if (event.type === "assistant") {
    if (event.data.parent_tool_use_id != null) return null;

    const usage = event.data.message?.usage;
    if (!usage) return null;

    const input = Number(usage.input_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
    const promptTokens = input + cacheRead + cacheCreate;

    if (promptTokens === 0) return null;
    return { promptTokens, contextWindow: 0 };
  }

  if (event.type === "result") {
    const modelUsage = event.data.modelUsage;
    if (!modelUsage) return null;

    let maxWindow = 0;
    for (const info of Object.values(modelUsage)) {
      const w = Number(info.contextWindow) || 0;
      if (w > maxWindow) maxWindow = w;
    }

    if (maxWindow === 0) return null;
    return { promptTokens: 0, contextWindow: maxWindow };
  }

  return null;
}
