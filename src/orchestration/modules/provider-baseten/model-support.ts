import type { CatalogSourceRow, CatalogWireIdentity } from "../../../infra/llm/model-catalog-resolution.js";
import { canonicalCatalogModelId } from "../../../infra/llm/model-id.js";
import { providerModelInfo } from "../../../infra/llm/provider-model-info.js";

interface UnknownFields { readonly [key: string]: unknown }

function record(value: unknown): value is UnknownFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function positiveSafeInteger(value: unknown): number | undefined {
  const parsed = finiteNonNegative(value);
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0) ? value : undefined;
}

// Provider decimal rates need rounding after binary floating-point scaling.
function perMillion(perToken: number): number {
  return Number((perToken * 1_000_000).toPrecision(12));
}

/** Joins owner-scoped Baseten ids to shared model choices without changing the case-sensitive wire id. */
export function canonicalizeBasetenWireId(wireModelId: string): CatalogWireIdentity {
  const separator = wireModelId.indexOf("/");
  return { modelId: canonicalCatalogModelId(separator < 0 ? wireModelId : wireModelId.slice(separator + 1)).modelId };
}

/** Normalizes Baseten's model list, whose prices are per token and whose feature list owns tool eligibility. */
export function canonicalizeBasetenCatalogRow(row: unknown): CatalogSourceRow | undefined {
  if (!record(row) || typeof row.id !== "string" || row.id.length === 0) return undefined;
  const identity = canonicalizeBasetenWireId(row.id);
  const features = stringArray(row.supported_features) ?? [];
  const contextLimit = positiveSafeInteger(row.context_length);
  const outputLimit = positiveSafeInteger(row.max_completion_tokens);
  const inputModalities = stringArray(row.input_modalities);
  const outputModalities = stringArray(row.output_modalities);
  const pricing = record(row.pricing) ? row.pricing : undefined;
  const input = finiteNonNegative(pricing?.prompt);
  const output = finiteNonNegative(pricing?.completion);
  const cacheRead = finiteNonNegative(pricing?.input_cache_read);
  return {
    ...identity,
    wireModelId: row.id,
    metadata: null,
    resolvedMetadata: providerModelInfo({
      provider: "baseten",
      id: identity.modelId,
      ...(typeof row.name === "string" ? { name: row.name } : {}),
      toolCall: features.includes("tools"),
      reasoning: features.includes("reasoning"),
      ...(contextLimit === undefined ? {} : { contextLimit }),
      ...(outputLimit === undefined ? {} : { outputLimit }),
      ...(input === undefined || output === undefined ? {} : {
        pricing: {
          status: "available",
          rateCard: { input: perMillion(input), output: perMillion(output), ...(cacheRead === undefined ? {} : { cacheRead: perMillion(cacheRead) }) },
          provenance: { source: "provider-api", provider: "baseten", model: row.id },
        },
      }),
      ...(inputModalities === undefined ? {} : { attachment: inputModalities.some((modality) => modality !== "text") }),
      ...(inputModalities === undefined && outputModalities === undefined ? {} : {
        modalities: { input: inputModalities ?? ["text"], output: outputModalities ?? ["text"] },
      }),
    }),
  };
}
