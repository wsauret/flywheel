import { Schema } from "effect";

export const MAX_MODELS_DOCUMENT_BYTES = 8 * 1024 * 1024;
export type ModelsDevCatalogProvenance = "live" | "last-known-good" | "bundled";

// models.dev is an external boundary. Validate only fields normalization
// consumes, so unused external metadata never enters the admitted catalog.
const RawModelCostTierSchema = Schema.Struct({
  input: Schema.optionalKey(Schema.Number),
  output: Schema.optionalKey(Schema.Number),
  cache_read: Schema.optionalKey(Schema.Number),
  cache_write: Schema.optionalKey(Schema.Number),
  reasoning: Schema.optionalKey(Schema.Number),
});

const RawModelCostSchema = Schema.Struct({
  ...RawModelCostTierSchema.fields,
  context_over_200k: Schema.optionalKey(RawModelCostTierSchema),
});

const RawModelSchema = Schema.Struct({
  id: Schema.String,
  canonical_model_id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  family: Schema.optionalKey(Schema.String),
  release_date: Schema.optionalKey(Schema.String),
  knowledge: Schema.optionalKey(Schema.String),
  last_updated: Schema.optionalKey(Schema.String),
  open_weights: Schema.optionalKey(Schema.Boolean),
  reasoning: Schema.optionalKey(Schema.Boolean),
  tool_call: Schema.optionalKey(Schema.Boolean),
  attachment: Schema.optionalKey(Schema.Boolean),
  temperature: Schema.optionalKey(Schema.Boolean),
  // models.dev writes `true` or `{ field }`; normalization reads only the
  // object form, so an unfamiliar shape never fails document admission.
  interleaved: Schema.optionalKey(Schema.Unknown),
  reasoning_options: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        type: Schema.String,
        values: Schema.optionalKey(Schema.Array(Schema.Unknown)),
      }),
    ),
  ),
  limit: Schema.optionalKey(
    Schema.Struct({
      context: Schema.optionalKey(Schema.Number),
      input: Schema.optionalKey(Schema.Number),
      output: Schema.optionalKey(Schema.Number),
    }),
  ),
  cost: Schema.optionalKey(RawModelCostSchema),
  modalities: Schema.optionalKey(
    Schema.Struct({
      input: Schema.optionalKey(Schema.Array(Schema.String)),
      output: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  provider: Schema.optionalKey(
    Schema.Struct({
      npm: Schema.optionalKey(Schema.String),
    }),
  ),
});

const RawProviderSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  env: Schema.optionalKey(Schema.Array(Schema.String)),
  npm: Schema.optionalKey(Schema.String),
  models: Schema.Record(Schema.String, RawModelSchema),
});

const RawApiSchema = Schema.Record(Schema.String, RawProviderSchema);
const RawModelMapSchema = Schema.Record(Schema.String, RawModelSchema);
const RawCombinedCatalogSchema = Schema.Struct({
  models: RawModelMapSchema,
  providers: RawApiSchema,
});

export type RawModelCost = typeof RawModelCostSchema.Type;
export type RawModel = typeof RawModelSchema.Type;
export type RawApi = typeof RawApiSchema.Type;
type RawModelMap = typeof RawModelMapSchema.Type;

export interface AdmittedModelsDocument {
  readonly document: RawApi;
  readonly modelMap: RawModelMap | null;
  readonly relationshipAuthority: "model-map" | "legacy-provider-scan";
  readonly providerOrder: readonly string[];
  readonly provenance: ModelsDevCatalogProvenance;
}

/** Admits one complete models.dev document after enforcing its byte, schema,
 * and plausibility contracts. Throws on invalid content. All runtime and
 * snapshot publication paths use this boundary before exposing document content. */
export function admitModelsDocument(bytes: Uint8Array | string): AdmittedModelsDocument {
  const encoded = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  if (encoded.byteLength === 0) throw new Error("models.dev document is empty");
  if (encoded.byteLength > MAX_MODELS_DOCUMENT_BYTES) throw new Error("models.dev document exceeds 8 MiB");
  const parsed: unknown = JSON.parse(new TextDecoder().decode(encoded));
  if (isUnknownRecord(parsed) && ("models" in parsed || "providers" in parsed)) {
    if (!Object.hasOwn(parsed, "models") || !Object.hasOwn(parsed, "providers") || Object.keys(parsed).some((key) => key !== "models" && key !== "providers")) {
      throw new Error("models.dev combined document has an invalid envelope");
    }
    const combined = Schema.decodeUnknownSync(RawCombinedCatalogSchema)(parsed);
    assertPlausibleDocument(combined.providers);
    assertValidCosts(combined.providers);
    assertValidModelCosts(combined.models);
    if (Object.keys(combined.models).length === 0) throw new Error("models.dev model map is empty");
    for (const [identity, model] of Object.entries(combined.models)) {
      if (model.id !== identity) throw new Error("models.dev model map identity does not match its row");
    }
    return {
      document: combined.providers,
      modelMap: combined.models,
      relationshipAuthority: "model-map",
      providerOrder: Object.keys(combined.providers),
      provenance: "live",
    };
  }
  // Remove after 2026-12-17: provider-only api.json archives predate the
  // combined model-map authority and remain readable until one fresh refresh.
  const document = Schema.decodeUnknownSync(RawApiSchema)(parsed);
  assertPlausibleDocument(document);
  assertValidCosts(document);
  return {
    document,
    modelMap: null,
    relationshipAuthority: "legacy-provider-scan",
    providerOrder: Object.keys(document),
    provenance: "live",
  };
}

/** Admits the current combined models.dev shape. Live and newly bundled
 * publication reject legacy provider-only documents. Throws on invalid content. */
export function admitCurrentModelsDocument(bytes: Uint8Array | string): AdmittedModelsDocument {
  const admitted = admitModelsDocument(bytes);
  if (admitted.relationshipAuthority !== "model-map") throw new Error("models.dev current document is not a combined catalog");
  return admitted;
}

function assertPlausibleDocument(document: RawApi): void {
  const providerOrder = Object.keys(document);
  if (providerOrder.length < 10 || Object.keys(document.anthropic?.models ?? {}).length === 0) {
    throw new Error("models.dev document is implausible");
  }
}

function assertValidCosts(document: RawApi): void {
  for (const provider of Object.values(document)) {
    assertValidModelCosts(provider.models);
  }
}

function assertValidModelCosts(models: RawModelMap): void {
  for (const model of Object.values(models)) {
    if (model.cost !== undefined && !validCost(model.cost)) throw new Error("models.dev model cost is invalid");
  }
}

function validCost(cost: RawModelCost): boolean {
  if (![cost.input, cost.output, cost.cache_read, cost.cache_write, cost.reasoning].every(optionalNonNegative)) return false;
  const high = cost.context_over_200k;
  return high === undefined || [high.input, high.output, high.cache_read, high.cache_write, high.reasoning].every(optionalNonNegative);
}

function optionalNonNegative(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value >= 0);
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
