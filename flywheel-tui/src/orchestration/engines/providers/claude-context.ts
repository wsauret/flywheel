/**
 * Claude-specific context utilization extraction.
 *
 * Extracts prompt size and context window from Claude Code's NDJSON events.
 * Called by the chat session's event handler to feed engine-agnostic values
 * into the budget tracker.
 *
 * Prompt size = input_tokens + cache_read_input_tokens + cache_creation_input_tokens
 * from "assistant" events where parent_tool_use_id is null (main conversation only).
 *
 * Context window is extracted from "result" events' modelUsage field.
 */

import type { NDJSONEvent } from "../../../infra/subprocess-types";
import { resolveModel } from "./claude";

export interface ContextUpdate {
  promptTokens: number;
  contextWindow: number;
}

/**
 * Derive context window size from a model identifier.
 *
 * Resolves the model through the alias map first (e.g. "opus" → 1M),
 * then checks the resolved ID for the `[1m]` suffix or `claude-` prefix.
 *
 * The authoritative value still comes from the "result" event's
 * modelUsage.contextWindow field, but that only fires when the subprocess
 * exits — too late for mid-session warnings.
 */
export function contextWindowForModel(model: string): number {
  const resolved = resolveModel(model);
  if (resolved.includes("[1m]")) return 1_000_000;
  if (resolved.startsWith("claude-")) return 200_000;
  // Bare aliases that didn't resolve to a full ID (e.g. "haiku") are 200k.
  const lower = resolved.toLowerCase();
  if (lower === "opus" || lower === "sonnet" || lower === "haiku") return 200_000;
  return 0;
}

/**
 * Try to extract a context utilization update from a Claude NDJSON event.
 * Returns null if the event doesn't carry relevant context info.
 */
export function extractContextUpdate(event: NDJSONEvent): ContextUpdate | null {
  const data = event.data as Record<string, unknown>;
  const type = data.type as string | undefined;

  if (type === "assistant") {
    // Skip subagent events — they have their own smaller context window.
    if (data.parent_tool_use_id != null) return null;

    const message = data.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, unknown> | undefined;
    if (!usage) return null;

    const input = Number(usage.input_tokens) || 0;
    const cacheRead = Number(usage.cache_read_input_tokens) || 0;
    const cacheCreate = Number(usage.cache_creation_input_tokens) || 0;
    const promptTokens = input + cacheRead + cacheCreate;

    if (promptTokens === 0) return null;
    return { promptTokens, contextWindow: 0 };
  }

  if (type === "result") {
    const modelUsage = data.modelUsage as Record<string, Record<string, unknown>> | undefined;
    if (!modelUsage) return null;

    // Take the max contextWindow across all models in this result.
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
