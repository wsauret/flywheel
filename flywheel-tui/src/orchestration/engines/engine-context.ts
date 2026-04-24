import type { NDJSONEvent } from "../../infra/ndjson-event-types.js";
import { canonicalize } from "../../infra/canonical-name.js";

interface ContextUpdate {
  promptTokens: number;
  contextWindow: number;
}

// Falls back to static lookup because the authoritative value (result event's
// modelUsage.contextWindow) only fires when the engine process exits.
export function contextWindowForModel(model: string): number {
  const lower = canonicalize(model);

  if (lower.includes("[1m]")) return 1_000_000;
  if (lower.startsWith("claude-")) return 200_000;
  if (lower === "opus" || lower === "sonnet" || lower === "haiku") return 200_000;

  if (/^o\d/.test(lower)) return 200_000;
  if (
    lower.startsWith("gpt-4o") ||
    lower === "gpt-4-turbo" ||
    lower.startsWith("gpt-5") ||
    lower.startsWith("codex-") ||
    lower.startsWith("chatgpt-")
  ) return 128_000;

  if (lower.startsWith("gemini-")) return 1_000_000;

  return 200_000;
}

export function extractContextUpdate(event: NDJSONEvent): ContextUpdate | null {
  if (event.type === "assistant") {
    const parentToolUseId = event.data.message?.parent_tool_use_id;
    if (parentToolUseId != null) return null;

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
