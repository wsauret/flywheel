import type Anthropic from "@anthropic-ai/sdk";
import { isRecord } from "../../../infra/record.js";
import type { ProviderStreamEvent } from "./types.js";

/** Per-attempt billing counters, cumulative as the provider reports them. */
export interface AnthropicUsageCounters {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  /** 1h-retention subset of `cacheCreate`; null marks unsupported wire evidence. */
  cacheCreate1h: number | null;
  cacheCreate5m: number | null;
  reasoning: number;
  /** True once `message_delta` carried usage, the provider's terminal report; `message_start` counts are lower bounds. */
  final: boolean;
}

export function emptyAnthropicUsage(): AnthropicUsageCounters {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cacheCreate1h: 0, cacheCreate5m: 0, reasoning: 0, final: false };
}

/** The usage event of an attempt's counters so far. The cache-write split names the retention that the attempt's
 *  cache writes hold; unsupported split evidence reports an unknown retention. */
export function anthropicUsageEvent(usage: AnthropicUsageCounters): Extract<ProviderStreamEvent, { kind: "usage" }> {
  return {
    kind: "usage",
    final: usage.final,
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheCreateTokens: usage.cacheCreate,
    cacheCreate1hTokens: usage.cacheCreate1h ?? 0,
    ...(usage.cacheCreate1h === null ? { cacheRetentionMs: null }
      : usage.cacheCreate1h > 0 ? { cacheRetentionMs: 3_600_000 }
      : usage.cacheCreate5m === null ? { cacheRetentionMs: null }
      : usage.cacheCreate5m > 0 ? { cacheRetentionMs: 300_000 } : {}),
    reasoningTokens: usage.reasoning,
  };
}

export function foldAnthropicMessageStartUsage(u: Anthropic.Message["usage"], c: AnthropicUsageCounters): void {
  c.input = u.input_tokens ?? 0;
  c.output = u.output_tokens ?? 0;
  c.cacheRead = u.cache_read_input_tokens ?? 0;
  c.cacheCreate = u.cache_creation_input_tokens ?? 0;
  foldAnthropicCacheCreation(u.cache_creation, c);
}

function foldAnthropicCacheCreation(creation: unknown, counters: AnthropicUsageCounters): void {
  if (creation == null) return;
  if (!isRecord(creation)) {
    counters.cacheCreate1h = null;
    counters.cacheCreate5m = null;
    return;
  }
  for (const [field, counter] of Object.entries({ ephemeral_1h_input_tokens: "cacheCreate1h", ephemeral_5m_input_tokens: "cacheCreate5m" } as const)) {
    const value = creation[field];
    if (value === undefined) continue;
    const count = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    counters[counter] = typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
  }
}

export function foldAnthropicMessageDeltaUsage(u: Anthropic.RawMessageDeltaEvent["usage"], c: AnthropicUsageCounters): void {
  // Use `!= null` rather than `!== undefined` so proxies that emit explicit
  // `null` don't poison the accumulators (pi anthropic.ts:644-655
  // guard pattern).
  c.final = true;
  if (u.output_tokens != null) c.output = u.output_tokens;
  if (u.input_tokens != null) c.input = u.input_tokens;
  if (u.cache_read_input_tokens != null) c.cacheRead = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens != null) c.cacheCreate = u.cache_creation_input_tokens;
  // The 1h cache-write split rides the final message_delta usage; the SDK's
  // MessageDeltaUsage does not declare it (pi `anthropic-messages.ts:582`).
  // SAFETY: narrow read of a beta wire field the SDK type omits; cache
  // creation is normalized at this boundary before it supplies retention evidence.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the Anthropic beta cache_creation usage field is absent from the external SDK type
  const extra = u as { cache_creation?: unknown };
  foldAnthropicCacheCreation(extra.cache_creation, c);
  if (u.output_tokens_details?.thinking_tokens != null) c.reasoning = u.output_tokens_details.thinking_tokens;
}
