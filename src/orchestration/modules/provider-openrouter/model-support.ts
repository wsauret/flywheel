import type { CatalogJsonValue, CatalogSourceRow, CatalogWireIdentity } from "../../../infra/llm/model-catalog-resolution.js";
import { MAX_MODEL_OUTPUT_TOKENS, type ProviderReasoningEffort } from "../../../infra/llm/models.js";
import { providerModelInfo } from "../../../infra/llm/provider-model-info.js";
import { canonicalCatalogModelId, isMovingModelAlias } from "../../../infra/llm/model-id.js";

export interface OpenRouterModelPricing {
  readonly prompt: number;
  readonly completion: number;
  readonly inputCacheRead?: number;
  readonly inputCacheWrite?: number;
}

interface UnknownFields {
  readonly [key: string]: unknown;
}

function record(value: unknown): value is UnknownFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  const parsed = finiteNonNegative(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_MODEL_OUTPUT_TOKENS)
    : undefined;
}

/** Normalizes the OpenRouter-owned fields used by admission and transmission. */
export function normalizeOpenRouterModelMetadata(row: unknown): CatalogJsonValue {
  if (!record(row)) return null;
  let pricing: CatalogJsonValue | undefined;
  if (record(row.pricing)) {
    const prompt = finiteNonNegative(row.pricing.prompt);
    const completion = finiteNonNegative(row.pricing.completion);
    if (prompt !== undefined && completion !== undefined) {
      const inputCacheRead = finiteNonNegative(row.pricing.input_cache_read);
      const inputCacheWrite = finiteNonNegative(row.pricing.input_cache_write);
      pricing = {
      prompt,
      completion,
      ...(inputCacheRead === undefined ? {} : { input_cache_read: inputCacheRead }),
      ...(inputCacheWrite === undefined ? {} : { input_cache_write: inputCacheWrite }),
      };
    }
  }
  const maxCompletionTokens = record(row.top_provider)
    ? positiveSafeInteger(row.top_provider.max_completion_tokens)
    : undefined;
  const contextLength = positiveSafeInteger(row.context_length);
  const architecture = record(row.architecture) ? row.architecture : undefined;
  const inputModalities = stringArray(architecture?.input_modalities);
  const outputModalities = stringArray(architecture?.output_modalities);
  const efforts = record(row.reasoning) ? reasoningEfforts(row.reasoning.supported_efforts) : undefined;
  if (pricing === undefined && maxCompletionTokens === undefined && contextLength === undefined && inputModalities === undefined && outputModalities === undefined && efforts === undefined) return null;
  return {
    ...(pricing === undefined ? {} : { pricing }),
    ...(maxCompletionTokens === undefined ? {} : { top_provider: { max_completion_tokens: maxCompletionTokens } }),
    ...(contextLength === undefined ? {} : { context_length: contextLength }),
    ...(inputModalities === undefined && outputModalities === undefined ? {} : {
      architecture: {
        ...(inputModalities === undefined ? {} : { input_modalities: inputModalities }),
        ...(outputModalities === undefined ? {} : { output_modalities: outputModalities }),
      },
    }),
    ...(efforts === undefined ? {} : { reasoning: { supported_efforts: efforts } }),
  };
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.length <= 16 && value.every((item) => typeof item === "string" && item.length > 0)
    ? value
    : undefined;
}

function reasoningEfforts(value: unknown): readonly ProviderReasoningEffort[] | undefined {
  const values = stringArray(value);
  if (values === undefined) return undefined;
  const efforts = values.filter((item): item is ProviderReasoningEffort =>
    item === "none" || item === "minimal" || item === "low" || item === "medium"
    || item === "high" || item === "xhigh" || item === "max" || item === "ultra");
  return efforts;
}

/** Reads the live top-provider output limit without requiring price evidence. */
export function openRouterModelOutputCap(metadata: CatalogJsonValue | undefined): number | undefined {
  if (!record(metadata) || !record(metadata.top_provider)) return undefined;
  return positiveSafeInteger(metadata.top_provider.max_completion_tokens);
}

/** Reads a complete normalized live OpenRouter rate card. */
export function openRouterModelPricing(metadata: CatalogJsonValue | undefined): OpenRouterModelPricing | undefined {
  if (!record(metadata) || !record(metadata.pricing)) return undefined;
  const pricing = metadata.pricing;
  const prompt = finiteNonNegative(pricing.prompt);
  const completion = finiteNonNegative(pricing.completion);
  if (prompt === undefined || completion === undefined) return undefined;
  const inputCacheRead = finiteNonNegative(pricing.input_cache_read);
  const inputCacheWrite = finiteNonNegative(pricing.input_cache_write);
  return {
    prompt,
    completion,
    ...(inputCacheRead === undefined ? {} : { inputCacheRead }),
    ...(inputCacheWrite === undefined ? {} : { inputCacheWrite }),
  };
}

/** OpenRouter states per-token decimal rates; scaling them in binary floating
 *  point turns $0.10 into 0.09999999999999999, so the result is rounded back to
 *  the precision the listing carries. */
function perMillion(perToken: number): number {
  return Number((perToken * 1_000_000).toPrecision(12));
}

/** Normalizes first-party OpenRouter metadata. */
export function canonicalizeOpenRouterCatalogRow(row: unknown): CatalogSourceRow | undefined {
  if (!record(row) || typeof row.id !== "string" || row.id.length === 0) return undefined;
  const identity = canonicalizeOpenRouterWireId(row.id);
  if (identity === undefined) return undefined;
  const metadata = normalizeOpenRouterModelMetadata(row);
  const livePricing = openRouterModelPricing(metadata);
  const outputLimit = openRouterModelOutputCap(metadata);
  const contextLimit = record(metadata) ? positiveSafeInteger(metadata.context_length) : undefined;
  const architecture = record(metadata) && record(metadata.architecture) ? metadata.architecture : undefined;
  const inputModalities = stringArray(architecture?.input_modalities);
  const outputModalities = stringArray(architecture?.output_modalities);
  const efforts = record(metadata) && record(metadata.reasoning) ? reasoningEfforts(metadata.reasoning.supported_efforts) : undefined;
  // OpenRouter states tool support per model; a model without it is recorded as such so listing removes it.
  const callsTools = Array.isArray(row.supported_parameters) && row.supported_parameters.includes("tools");
  return {
    ...identity,
    wireModelId: row.id,
    metadata,
    resolvedMetadata: providerModelInfo({
      provider: "openrouter",
      id: identity.modelId,
      ...(typeof row.name === "string" ? { name: row.name } : {}),
      toolCall: callsTools,
      ...(efforts === undefined ? {} : { reasoning: efforts.length > 0 }),
      ...(efforts === undefined ? {} : { reasoningEfforts: efforts }),
      ...(contextLimit === undefined ? {} : { contextLimit }),
      ...(outputLimit === undefined ? {} : { outputLimit }),
      ...(livePricing === undefined ? {} : {
        pricing: {
          status: "available",
          rateCard: {
            input: perMillion(livePricing.prompt),
            output: perMillion(livePricing.completion),
            ...(livePricing.inputCacheRead === undefined ? {} : { cacheRead: perMillion(livePricing.inputCacheRead) }),
            ...(livePricing.inputCacheWrite === undefined ? {} : { cacheWrite: perMillion(livePricing.inputCacheWrite) }),
          },
          provenance: { source: "provider-api", provider: "openrouter", model: row.id },
        },
      }),
      ...(inputModalities === undefined ? {} : { attachment: inputModalities.some((modality) => modality !== "text") }),
      ...(inputModalities === undefined && outputModalities === undefined ? {} : {
        modalities: { input: inputModalities ?? ["text"], output: outputModalities ?? ["text"] },
      }),
    }),
  };
}

/** Derives OpenRouter's shared model identity while preserving its exact route. */
export function canonicalizeOpenRouterWireId(wireModelId: string): CatalogWireIdentity | undefined {
  if (isMovingModelAlias(wireModelId)) return undefined;
  // An interactive harness never submits batch jobs, so a batch route is never servable.
  if (wireModelId.endsWith(":batch")) return undefined; // provider-model-literal-allow: identity -- OpenRouter declares batch route variants in its catalog
  const routeKind = wireModelId.endsWith(":free") || wireModelId === "openrouter/free" ? "free" as const : undefined; // provider-model-literal-allow: identity -- OpenRouter declares free route variants in its catalog
  const routeId = routeKind === "free" && wireModelId.endsWith(":free") ? wireModelId.slice(0, -":free".length) : wireModelId; // provider-model-literal-allow: identity -- the free suffix is route identity, not model identity
  const separator = routeId.indexOf("/");
  const modelId = canonicalCatalogModelId(separator < 0 ? routeId : routeId.slice(separator + 1)).modelId;
  return {
    modelId,
    ...(routeKind === undefined ? {} : { routeKind }),
  };
}