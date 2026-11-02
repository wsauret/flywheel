import type { AccessProviderId } from "../../../infra/llm/access-provider.js";
import { computeUsagePrice } from "../../../infra/llm/llm-helpers.js";
import type { ModelInfo } from "../../../infra/llm/models.js";
import { SHARED_PROMPT_NOTES } from "./prompt-notes.js";
import { FUNCTION_TOOL_PRESENTATION, type ProviderPromptNotes, type ServingAttempt, type ToolDef, type ToolPresentation } from "./types.js";

// The facts of each wire protocol live here, apart from its adapter: a provider describes a model when it builds
// its client, and loads the adapter, with its SDK, only when it opens its first connection.

export const ANTHROPIC_PROMPT_NOTES = {
  progress: "",
  modelNotes: "- Use extended thinking for complex multi-step reasoning.",
} satisfies ProviderPromptNotes;

export const ANTHROPIC_CACHE_RATES = { cacheReadRatio: 0.1, cacheWriteRatio: 1.25 } as const;

export function supportsAnthropicReasoning(model: string, info: ModelInfo | null): boolean {
  return info?.reasoning ?? /^claude-(opus|sonnet|haiku)-4/.test(model);
}

export function anthropicOutputLimit(info: ModelInfo | null): number {
  return info?.outputLimit ?? 16_384;
}

export const GOOGLE_CACHE_RATES = { cacheReadRatio: 0.25, cacheWriteRatio: 1.0 } as const;

export const GOOGLE_PROMPT_NOTES = {
  progress: "",
  modelNotes: "- Gemini supports extended thinking via `thinkingBudget`/`thinkingLevel`.",
} satisfies ProviderPromptNotes;

export function supportsGoogleReasoning(model: string, info: ModelInfo | null): boolean {
  // The `-latest` aliases carry no version digit but track current reasoning
  // models (pi `providers/google.ts:420-423`).
  return info?.reasoning ?? /^gemini-(2|3)|^gemini-flash(-lite)?-latest|^gemma-?4/i.test(model);
}

export function googleOutputLimit(info: ModelInfo | null): number {
  return info?.outputLimit ?? 16_384;
}

export const OPENAI_CACHE_RATES = { cacheReadRatio: 0.5, cacheWriteRatio: 1.0 } as const;

export const OPENAI_RESPONSES_TOOL_PRESENTATION: ToolPresentation = Object.freeze({
  format: "openai-responses",
  present: (tool: ToolDef) => tool.wire?.kind === "custom"
    ? Object.freeze({ kind: "custom" as const, description: tool.description, inputFormat: Object.freeze({ type: "grammar" as const, syntax: tool.wire.grammar.syntax, definition: tool.wire.grammar.definition }) })
    : FUNCTION_TOOL_PRESENTATION.present(tool),
});

export function supportsOpenAIReasoning(model: string, info: ModelInfo | null): boolean {
  return info?.reasoning ?? /^(o\d|gpt-5)/.test(model);
}

export function openAIOutputLimit(info: ModelInfo | null): number {
  return info?.outputLimit ?? 16_384;
}

type Protocol = "anthropic" | "openai-responses" | "openai-completions" | "google";

export interface ProviderDescriptionOptions {
  readonly accessProvider: AccessProviderId;
  readonly protocol: Protocol;
  readonly providerHint: string;
  readonly providerOutputCap?: number;
  readonly availableModels?: ReadonlySet<string>;
  readonly resolvedModelMetadata?: ModelInfo;
}

/** Resolves static provider and model facts without constructing an SDK client. */
export async function describeProvider(model: string, options: ProviderDescriptionOptions): Promise<ServingAttempt> {
  const info = options.resolvedModelMetadata;
  if (info === undefined) throw new Error(`Model info unavailable for ${model}`);
  const protocol = options.protocol;
  return Object.freeze({
    accessProvider: options.accessProvider,
    modelFamily: protocol === "anthropic" ? "anthropic" : protocol === "google" ? "google" : "openai",
    model,
    toolPresentation: protocol === "openai-responses" ? OPENAI_RESPONSES_TOOL_PRESENTATION : FUNCTION_TOOL_PRESENTATION,
    promptNotes: protocol === "anthropic" ? ANTHROPIC_PROMPT_NOTES : protocol === "google" ? GOOGLE_PROMPT_NOTES : SHARED_PROMPT_NOTES,
    // The Responses routes group their prompt cache by the request's prompt-cache
    // key: the OpenAI API reads the body `prompt_cache_key`, and the ChatGPT
    // backend reads the session-id header, which carries the same key (openai-helpers.ts).
    ...(protocol === "openai-responses" ? { sharedPromptPrefix: "cache-key" } : {}),
    ...(options.availableModels === undefined ? {} : { availableModels: options.availableModels }),
    contextLimit: info.contextLimit,
    ...(info.totalContextLimit === undefined ? {} : { totalContextLimit: info.totalContextLimit }),
    outputLimit: Math.min(outputLimitFor(protocol, info), options.providerOutputCap ?? Number.POSITIVE_INFINITY),
    supportsReasoning: reasoningFor(protocol, model, info),
    priceFor: (tokens: Parameters<ServingAttempt["priceFor"]>[0]) => computeUsagePrice(
      protocol === "openai-responses" ? { ...tokens, reasoning: 0 } : tokens,
      info.pricing,
      protocol === "anthropic" ? ANTHROPIC_CACHE_RATES : protocol === "google" ? GOOGLE_CACHE_RATES : OPENAI_CACHE_RATES,
    ),
  });
}

function outputLimitFor(protocol: Protocol, info: ModelInfo): number {
  if (protocol === "anthropic") return anthropicOutputLimit(info);
  if (protocol === "google") return googleOutputLimit(info);
  return openAIOutputLimit(info);
}

function reasoningFor(protocol: Protocol, model: string, info: ModelInfo): boolean {
  if (protocol === "anthropic") return supportsAnthropicReasoning(model, info);
  if (protocol === "google") return supportsGoogleReasoning(model, info);
  if (protocol === "openai-responses") return supportsOpenAIReasoning(model, info);
  return info.reasoning;
}
