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

import type { NDJSONEvent } from "../subprocess/ndjson-parser";

export interface ContextUpdate {
  promptTokens: number;
  contextWindow: number;
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

    const input = (usage.input_tokens as number | undefined) ?? 0;
    const cacheRead = (usage.cache_read_input_tokens as number | undefined) ?? 0;
    const cacheCreate = (usage.cache_creation_input_tokens as number | undefined) ?? 0;
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
      const w = info.contextWindow as number | undefined;
      if (w && w > maxWindow) maxWindow = w;
    }

    if (maxWindow === 0) return null;
    return { promptTokens: 0, contextWindow: maxWindow };
  }

  return null;
}
