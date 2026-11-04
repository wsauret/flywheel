import type { AccessProviderId } from "../../../infra/llm/access-provider.js";

// Each array is the single source of its union type, so schema mirrors
// (Schema.Literals) stay total when a member is added.
export const LLM_APIS = ["openai-responses", "anthropic-messages", "google-generative-ai"] as const;
export type LlmApi = (typeof LLM_APIS)[number];

import type { ModelFamily } from "../../../infra/llm/model-family.js";
// The model-family vocabulary; the type lives in infra/llm/model-family.ts.
export const MODEL_FAMILIES = ["openai", "anthropic", "google"] as const;

export const LLM_STOP_REASONS = [
  "end_turn",
  "tool_use",
  "max_tokens",
  "stop_sequence",
  "content_filter",
  "error",
  "aborted",
  "unknown",
] as const;
export type LlmStopReason = (typeof LLM_STOP_REASONS)[number];
/** The stop reasons of a completed turn. A truncated, broken, or aborted
 *  response is never a completed turn: an adapter throws its typed failure
 *  instead. Persisted history keeps every `LlmStopReason`, because older
 *  entries and settled failed attempts record the excluded values. */
export type CompletedStopReason = Exclude<LlmStopReason, "max_tokens" | "error" | "aborted">;

/** The one provider API each model family speaks. */
export function modelFamilyApi(family: ModelFamily): LlmApi {
  if (family === "anthropic") return "anthropic-messages";
  if (family === "google") return "google-generative-ai";
  return "openai-responses";
}

/** True when an assistant message was produced by the exact access provider,
 * provider API, and model that the current request targets. Opaque wire data
 * is never replayed when access-provider provenance is absent or different. */
export function isSameProviderReplay(
  message: { accessProvider?: AccessProviderId; provider?: ModelFamily; api?: LlmApi; model?: string },
  options: { accessProvider: AccessProviderId; provider: ModelFamily; api: LlmApi; model: string },
): boolean {
  return message.accessProvider === options.accessProvider
    && message.provider === options.provider
    && message.api === options.api
    && message.model === options.model;
}

export function isSameAccessProviderReplay(
  message: { accessProvider?: AccessProviderId },
  options: { accessProvider: AccessProviderId },
): boolean {
  return message.accessProvider === options.accessProvider;
}

export type { LlmToolOutputPart } from "../../../infra/llm/tool-output-part-schema.js";
