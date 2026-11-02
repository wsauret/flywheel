import { Schema } from "effect";
import type { AccessProviderId } from "./access-provider.js";
import type { ModelFamily } from "./model-family.js";

const described = <S extends Schema.Top>(schema: S, description: string) => schema.pipe(Schema.annotate({ description }));

export const CacheRetentionPolicySchema = Schema.Union([
  Schema.Literal("provider"),
  Schema.Literal("5m"),
  Schema.Literal("1h"),
  Schema.Literal("in_memory"),
  Schema.Literal("24h"),
]);
export type CacheRetentionPolicy = typeof CacheRetentionPolicySchema.Type;

const OpenAITextVerbositySchema = Schema.Union([
  Schema.Literal("low"),
  Schema.Literal("medium"),
  Schema.Literal("high"),
]);
const OpenAIReasoningSummarySchema = Schema.Union([
  Schema.Literal("auto"),
  Schema.Literal("concise"),
  Schema.Literal("detailed"),
  Schema.Literal("off"),
]);
const AnthropicThinkingDisplaySchema = Schema.Union([
  Schema.Literal("updates"),
  Schema.Literal("summarized"),
  Schema.Literal("omitted"),
]);

// Strict objects throughout: provider options come from user TOML, where a
// typo'd key must be an actionable config error, not a silent no-op
// (PI-CAP-011). `extra_body` is the sanctioned escape hatch for arbitrary
// provider keys.
const ExtraBodySchema = Schema.Record(Schema.String, Schema.Unknown);

// Uniform Flywheel-facing fast-mode knob. Each adapter translates it to the
// provider's own wire mechanism: OpenAI `service_tier: "fast"`, Anthropic
// `speed: "fast"` plus the `fast-mode-2026-02-01` beta.
const ProviderSpeedSchema = Schema.Literal("fast");

const OpenAIProviderOptionsSchema = Schema.Struct({
  parallel_tool_calls: Schema.optionalKey(described(Schema.Boolean, "Allow parallel tool calls.")),
  text_verbosity: Schema.optionalKey(described(OpenAITextVerbositySchema, "Set response text verbosity.")),
  reasoning_summary: Schema.optionalKey(described(OpenAIReasoningSummarySchema, "Set reasoning summary detail.")),
  speed: Schema.optionalKey(described(ProviderSpeedSchema, "Use the provider fast request mode.")),
  service_tier: Schema.optionalKey(described(Schema.NonEmptyString, "Set the OpenAI service tier.")),
  extra_body: Schema.optionalKey(described(ExtraBodySchema, "Add arbitrary provider request body fields.")),
}).pipe(Schema.annotate({ description: "OpenAI request options." }));

const AnthropicProviderOptionsSchema = Schema.Struct({
  thinking_display: Schema.optionalKey(described(AnthropicThinkingDisplaySchema, "Set how thinking content is displayed.")),
  user_id: Schema.optionalKey(described(Schema.NonEmptyString, "Set the stable end-user abuse-tracking identifier.")),
  speed: Schema.optionalKey(described(ProviderSpeedSchema, "Use the provider fast request mode.")),
  extra_body: Schema.optionalKey(described(ExtraBodySchema, "Add arbitrary provider request body fields.")),
}).pipe(Schema.annotate({ description: "Anthropic request options." }));

const GoogleProviderOptionsSchema = Schema.Struct({
  temperature: Schema.optionalKey(described(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 2 })), "Set the response sampling temperature.")),
  thinking_budgets: Schema.optionalKey(Schema.Struct({
    low: Schema.optionalKey(described(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), "Set the low-effort thinking token budget.")),
    medium: Schema.optionalKey(described(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), "Set the medium-effort thinking token budget.")),
    high: Schema.optionalKey(described(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), "Set the high-effort thinking token budget.")),
  }).pipe(Schema.annotate({ description: "Set per-effort Gemini thinking token budgets." }))),
  extra_body: Schema.optionalKey(described(ExtraBodySchema, "Add arbitrary provider request body fields.")),
}).pipe(Schema.annotate({ description: "Google request options." }));

const OpenRouterSortSchema = Schema.Union([
  Schema.String,
  Schema.Struct({
    by: Schema.optionalKey(described(Schema.String, "Set the router sort field.")),
    partition: Schema.optionalKey(described(Schema.NullOr(Schema.String), "Set the router sort partition.")),
  }),
]);
const OpenRouterPriceSchema = Schema.Union([Schema.Number, Schema.String]);
const OpenRouterMaxPriceSchema = Schema.Struct({
  prompt: Schema.optionalKey(described(OpenRouterPriceSchema, "Set the maximum prompt price.")),
  completion: Schema.optionalKey(described(OpenRouterPriceSchema, "Set the maximum completion price.")),
  image: Schema.optionalKey(described(OpenRouterPriceSchema, "Set the maximum image price.")),
  audio: Schema.optionalKey(described(OpenRouterPriceSchema, "Set the maximum audio price.")),
  request: Schema.optionalKey(described(OpenRouterPriceSchema, "Set the maximum request price.")),
});
const OpenRouterPercentilesSchema = Schema.Struct({
  p50: Schema.optionalKey(described(Schema.Number, "Set the p50 performance threshold.")),
  p75: Schema.optionalKey(described(Schema.Number, "Set the p75 performance threshold.")),
  p90: Schema.optionalKey(described(Schema.Number, "Set the p90 performance threshold.")),
  p99: Schema.optionalKey(described(Schema.Number, "Set the p99 performance threshold.")),
});
const OpenRouterPerformancePreferenceSchema = Schema.Union([
  Schema.Number,
  OpenRouterPercentilesSchema,
]);
const OpenRouterProviderOptionsSchema = Schema.Struct({
  allow_fallbacks: Schema.optionalKey(described(Schema.Boolean, "Allow fallback models.")),
  require_parameters: Schema.optionalKey(described(Schema.Boolean, "Require models to support all request parameters.")),
  zdr: Schema.optionalKey(described(Schema.Boolean, "Require zero-data-retention endpoints.")),
  enforce_distillable_text: Schema.optionalKey(described(Schema.Boolean, "Require distillable text outputs.")),
  data_collection: Schema.optionalKey(described(Schema.Union([Schema.Literal("deny"), Schema.Literal("allow")]), "Set the data collection policy.")),
  order: Schema.optionalKey(described(Schema.Array(Schema.String), "Set preferred provider order.")),
  only: Schema.optionalKey(described(Schema.Array(Schema.String), "Restrict routing to these providers.")),
  ignore: Schema.optionalKey(described(Schema.Array(Schema.String), "Exclude these providers from routing.")),
  quantizations: Schema.optionalKey(described(Schema.Array(Schema.String), "Restrict routing to these quantizations.")),
  sort: Schema.optionalKey(described(OpenRouterSortSchema, "Set the provider routing sort.")),
  max_price: Schema.optionalKey(described(OpenRouterMaxPriceSchema, "Set maximum routing prices.")),
  preferred_min_throughput: Schema.optionalKey(described(OpenRouterPerformancePreferenceSchema, "Set preferred minimum throughput.")),
  preferred_max_latency: Schema.optionalKey(described(OpenRouterPerformancePreferenceSchema, "Set preferred maximum latency.")),
}).pipe(Schema.annotate({ description: "OpenRouter request options." }));

export const ProviderRequestOptionsSchema = Schema.Struct({
  openai: Schema.optionalKey(described(OpenAIProviderOptionsSchema, "Set OpenAI request options.")),
  anthropic: Schema.optionalKey(described(AnthropicProviderOptionsSchema, "Set Anthropic request options.")),
  google: Schema.optionalKey(described(GoogleProviderOptionsSchema, "Set Google request options.")),
  openrouter: Schema.optionalKey(described(OpenRouterProviderOptionsSchema, "Set OpenRouter request options.")),
});

export type OpenAIReasoningSummary = typeof OpenAIReasoningSummarySchema.Type;
export type AnthropicThinkingDisplay = typeof AnthropicThinkingDisplaySchema.Type;
export type ProviderRequestOptions = typeof ProviderRequestOptionsSchema.Type;

interface UnknownFields {
  [key: string]: unknown;
}

function mergeRecords(
  base: UnknownFields | undefined,
  override: UnknownFields | undefined,
): UnknownFields | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override };
}

interface NamespaceOptions { extra_body?: UnknownFields }

function mergeNamespace<T extends NamespaceOptions>(base: T | undefined, next: T | undefined): T | undefined {
  if (!next) return base;
  const extraBody = mergeRecords(base?.extra_body, next.extra_body);
  // SAFETY: Merging namespace fields preserves the concrete provider option subtype.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: generic namespace merging preserves the concrete provider option subtype
  return {
    ...base,
    ...next,
    ...(extraBody ? { extra_body: extraBody } : {}),
  } as T;
}

export function mergeProviderOptions(
  ...items: Array<ProviderRequestOptions | undefined>
): ProviderRequestOptions | undefined {
  let openai: ProviderRequestOptions["openai"] | undefined;
  let anthropic: ProviderRequestOptions["anthropic"] | undefined;
  let google: ProviderRequestOptions["google"] | undefined;
  let openrouter: ProviderRequestOptions["openrouter"] | undefined;
  for (const item of items) {
    openai = mergeNamespace(openai, item?.openai);
    anthropic = mergeNamespace(anthropic, item?.anthropic);
    google = mergeNamespace(google, item?.google);
    openrouter = item?.openrouter ? { ...openrouter, ...item.openrouter } : openrouter;
  }
  return openai || anthropic || google || openrouter
    ? {
        ...(openai ? { openai } : {}),
        ...(anthropic ? { anthropic } : {}),
        ...(google ? { google } : {}),
        ...(openrouter ? { openrouter } : {}),
      }
    : undefined;
}

export const OPENAI_RESPONSES_RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning",
  "max_output_tokens",
  "temperature",
  "text",
  "store",
  "include",
  "prompt_cache_key",
  "prompt_cache_retention",
  "service_tier",
]);

export const ANTHROPIC_RESERVED_BODY_KEYS: ReadonlySet<string> = new Set([
  "model",
  "messages",
  "system",
  "stream",
  "tools",
  "tool_choice",
  "temperature",
  "max_tokens",
  "thinking",
  "output_config",
  "metadata",
  "stop_sequences",
  "speed",
]);

export function applyProviderExtraBody(
  target: UnknownFields,
  extraBody: UnknownFields | undefined,
  reservedKeys: ReadonlySet<string>,
): void {
  if (!extraBody) return;
  for (const [key, value] of Object.entries(extraBody)) {
    if (!reservedKeys.has(key)) target[key] = value;
  }
}

/** Effective OpenAI service tier: an explicit `service_tier` passthrough wins;
 *  otherwise the uniform `speed: "fast"` knob maps to OpenAI's renamed fast
 *  tier (formerly priority processing). Single source for the request param,
 *  the cost tracker's requested tier, and access-provider admission. */
export function resolveOpenAIServiceTier(
  providerOptions: ProviderRequestOptions | undefined,
): string | undefined {
  const options = providerOptions?.openai;
  return options?.service_tier ?? (options?.speed === "fast" ? "fast" : undefined);
}

/** Why `provider` cannot honor a request carrying these options, or undefined
 *  when it can. Service tiers and fast mode are direct-API request parameters:
 *  subscription and aggregator paths ignore or reject them, so a request that
 *  names one must route to the family's metered API even when a subscription
 *  is available. */
export function providerOptionsUnservableReason(
  provider: AccessProviderId,
  family: ModelFamily,
  options: ProviderRequestOptions | undefined,
): string | undefined {
  if (family === "openai" && provider !== "openai_api") {
    const tier = resolveOpenAIServiceTier(options);
    if (tier !== undefined) return `service tier "${tier}" is served by the OpenAI API only`;
  }
  if (family === "anthropic" && provider !== "anthropic_api" && options?.anthropic?.speed === "fast") {
    return "fast mode is served by the Anthropic API only";
  }
  return undefined;
}
