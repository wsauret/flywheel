import type { NDJSONEvent } from "../../infra/ndjson-event-types.js";

interface ContextUpdate {
  promptTokens: number;
  contextWindow: number;
}

// The authoritative value comes from the "result" event's modelUsage.contextWindow field,
// but that only fires when the engine process exits — too late for mid-session warnings.
export function contextWindowForModel(model: string): number {
  const lower = model.toLowerCase().trim();

  // Claude models: full IDs, aliases, and context-window suffixes
  if (lower.includes("[1m]")) return 1_000_000;
  if (lower.startsWith("claude-")) return 200_000;
  if (lower === "opus" || lower === "sonnet" || lower === "haiku") return 200_000;

  // OpenAI models
  if (/^o\d/.test(lower)) return 200_000;
  if (
    lower.startsWith("gpt-4o") ||
    lower === "gpt-4-turbo" ||
    lower.startsWith("gpt-5") ||
    lower.startsWith("codex-") ||
    lower.startsWith("chatgpt-")
  ) return 128_000;

  // Reasonable default for unknown models
  return 200_000;
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
