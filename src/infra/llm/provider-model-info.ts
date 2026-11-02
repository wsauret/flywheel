import type { CatalogModelOffering } from "./model-catalog-resolution.js";
import { inferModelFamilyFromProvider, type ModelFamily } from "./model-family.js";
import {
  MAX_MODEL_OUTPUT_TOKENS,
  type ModelInfo,
  type ModelPricing,
  type ProviderModelInfoField,
  type ProviderReasoningEffort,
} from "./models.js";

export interface ProviderModelInfoInput {
  readonly provider: string;
  readonly id: string;
  readonly family?: ModelFamily;
  readonly name?: string;
  readonly modelFamily?: string;
  readonly releaseDate?: string;
  readonly knowledgeCutoff?: string;
  readonly lastUpdated?: string;
  readonly openWeights?: boolean;
  readonly reasoning?: boolean;
  readonly reasoningEfforts?: readonly ProviderReasoningEffort[];
  readonly toolCall?: boolean;
  readonly attachment?: boolean;
  readonly temperature?: boolean;
  readonly contextLimit?: number;
  readonly totalContextLimit?: number;
  readonly outputLimit?: number;
  readonly pricing?: ModelPricing;
  readonly modalities?: { readonly input: readonly string[]; readonly output: readonly string[] };
}

/** Completes provider-owned facts with runtime-safe defaults. Missing commercial
 * metadata stays unavailable and never blocks dispatch. */
export function providerModelInfo(input: ProviderModelInfoInput): ModelInfo {
  const pricing = input.pricing ?? { status: "unavailable", reason: "missing-rate-card" };
  const cost = pricing.status === "available" ? pricing.rateCard : { input: 0, output: 0 };
  const providerFields: ProviderModelInfoField[] = [];
  if (input.family !== undefined) providerFields.push("family");
  if (input.name !== undefined) providerFields.push("name");
  if (input.modelFamily !== undefined) providerFields.push("modelFamily");
  if (input.releaseDate !== undefined) providerFields.push("releaseDate");
  if (input.knowledgeCutoff !== undefined) providerFields.push("knowledgeCutoff");
  if (input.lastUpdated !== undefined) providerFields.push("lastUpdated");
  if (input.openWeights !== undefined) providerFields.push("openWeights");
  if (input.reasoning !== undefined) providerFields.push("reasoning");
  if (input.reasoningEfforts !== undefined) providerFields.push("reasoningEfforts");
  if (input.toolCall !== undefined) providerFields.push("toolCall");
  if (input.attachment !== undefined) providerFields.push("attachment");
  if (input.temperature !== undefined) providerFields.push("temperature");
  if (input.contextLimit !== undefined) providerFields.push("contextLimit");
  if (input.totalContextLimit !== undefined) providerFields.push("totalContextLimit");
  if (input.outputLimit !== undefined) providerFields.push("outputLimit");
  if (input.pricing !== undefined) providerFields.push("pricing");
  if (input.modalities !== undefined) providerFields.push("modalities");
  return Object.freeze({
    provider: input.provider,
    family: input.family ?? inferModelFamilyFromProvider(input.provider) ?? "openai",
    id: input.id,
    name: input.name ?? input.id,
    ...(input.modelFamily === undefined ? {} : { modelFamily: input.modelFamily }),
    ...(input.releaseDate === undefined ? {} : { releaseDate: input.releaseDate }),
    ...(input.knowledgeCutoff === undefined ? {} : { knowledgeCutoff: input.knowledgeCutoff }),
    ...(input.lastUpdated === undefined ? {} : { lastUpdated: input.lastUpdated }),
    openWeights: input.openWeights ?? false,
    reasoning: input.reasoning ?? false,
    ...(input.reasoningEfforts === undefined ? {} : { reasoningEfforts: Object.freeze([...input.reasoningEfforts]) }),
    toolCall: input.toolCall ?? true,
    attachment: input.attachment ?? false,
    temperature: input.temperature ?? true,
    contextLimit: input.contextLimit ?? 200_000,
    ...(input.totalContextLimit === undefined ? {} : { totalContextLimit: input.totalContextLimit }),
    outputLimit: Math.min(input.outputLimit ?? 4_096, MAX_MODEL_OUTPUT_TOKENS),
    cost: Object.freeze({ ...cost, ...(cost.highContext ? { highContext: Object.freeze({ ...cost.highContext }) } : {}) }),
    pricing: pricing.status === "available"
      ? Object.freeze({ ...pricing, rateCard: Object.freeze({ ...pricing.rateCard, ...(pricing.rateCard.highContext ? { highContext: Object.freeze({ ...pricing.rateCard.highContext }) } : {}) }), provenance: Object.freeze({ ...pricing.provenance }) })
      : pricing,
    modalities: Object.freeze({
      input: Object.freeze([...(input.modalities?.input ?? ["text"])]),
      output: Object.freeze([...(input.modalities?.output ?? ["text"])]),
    }),
    providerFields: Object.freeze(providerFields),
  });
}

/** Whether a model can drive Flywheel's agentic coding loop: it calls tools and
 *  takes and returns text only. */
export function callsToolsOnText(info: ModelInfo): boolean {
  return info.toolCall
    && info.modalities.input.includes("text")
    && info.modalities.output.includes("text")
    && info.modalities.output.every((modality) => modality === "text");
}

/** A route is listed only when Flywheel can price it for tiering and use it for
 *  agentic coding. */
export function isListableRoute(offering: CatalogModelOffering): boolean {
  return offering.resolvedMetadata !== undefined
    && offering.resolvedMetadata.pricing.status === "available"
    && callsToolsOnText(offering.resolvedMetadata);
}

const MODEL_INFO_FIELDS = [
  "family", "name", "modelFamily", "releaseDate", "knowledgeCutoff", "lastUpdated", "openWeights", "reasoning", "reasoningEfforts",
  "interleavedReasoningField", "toolCall", "attachment", "temperature", "contextLimit", "totalContextLimit", "outputLimit", "pricing", "modalities",
] as const satisfies readonly ProviderModelInfoField[];

/** How well sourced one field of one route is: the provider stated it (0),
 *  the shared catalog supplied it (1), or it holds a runtime default (2). */
type FieldSource = 0 | 1 | 2;

function fieldSource(info: ModelInfo, field: ProviderModelInfoField): FieldSource {
  const present = field === "pricing" ? info.pricing.status === "available" : info[field] !== undefined;
  if (!present) return 2;
  // Metadata without provider fields is a shared-catalog row, where every field belongs to that source.
  if (info.providerFields === undefined) return 1;
  if (info.providerFields.includes(field)) return 0;
  return info.catalogFields?.includes(field) === true ? 1 : 2;
}

/** The route's metadata at the context window the account grants, which is smaller than the catalog's. The window
 *  bounds the prompt and the output together, and the account's own word owns both limits, so no shared record
 *  fills them back. */
export function narrowContextWindow(info: ModelInfo, limit: number): ModelInfo {
  if (info.contextLimit <= limit && info.totalContextLimit !== undefined && info.totalContextLimit <= limit) return info;
  const providerFields = info.providerFields === undefined ? undefined : [...new Set([...info.providerFields, "contextLimit", "totalContextLimit"] as const)];
  return Object.freeze({
    ...info,
    contextLimit: Math.min(info.contextLimit, limit),
    totalContextLimit: Math.min(info.totalContextLimit ?? limit, limit),
    ...(providerFields === undefined ? {} : { providerFields: Object.freeze(providerFields) }),
  });
}

type MutableModelInfo = { -readonly [Key in keyof ModelInfo]: ModelInfo[Key] };

function copyField(target: MutableModelInfo, source: ModelInfo, field: ProviderModelInfoField): void {
  if (field === "pricing") {
    target.pricing = source.pricing;
    target.cost = source.cost;
    return;
  }
  const value = source[field];
  if (value === undefined) Reflect.deleteProperty(target, field);
  else Object.assign(target, { [field]: value });
}

function freezeModelInfo(info: MutableModelInfo, catalogFields: readonly ProviderModelInfoField[]): ModelInfo {
  const { catalogFields: _previous, ...rest } = info;
  return Object.freeze({ ...rest, ...(catalogFields.length === 0 ? {} : { catalogFields: Object.freeze([...catalogFields]) }) });
}

/** Overrides only delegated fields explicitly stated by the catalog.
 * Missing catalog values retain the route's value and field ownership. */
export function preferCatalogModelInfoFields(
  provider: ModelInfo,
  catalog: ModelInfo,
  fields: readonly ProviderModelInfoField[],
): ModelInfo {
  const overrides = fields.filter((field) => catalog.catalogFields?.includes(field) === true);
  if (overrides.length === 0) return provider;
  const result: MutableModelInfo = { ...provider };
  if (provider.providerFields !== undefined) {
    result.providerFields = Object.freeze(provider.providerFields.filter((field) => !overrides.includes(field)));
  }
  for (const field of overrides) copyField(result, catalog, field);
  return freezeModelInfo(result, [...new Set([...provider.catalogFields ?? [], ...overrides])]);
}

/** Provider facts win. Shared metadata fills every field the provider omitted. */
export function enrichProviderModelInfo(
  provider: ModelInfo,
  fallback: ModelInfo,
): ModelInfo {
  const result: MutableModelInfo = { ...provider };
  const catalogFields: ProviderModelInfoField[] = [];
  for (const field of MODEL_INFO_FIELDS) {
    if (provider.providerFields?.includes(field) === true) continue;
    copyField(result, fallback, field);
    if (fieldSource(fallback, field) < 2) catalogFields.push(field);
  }
  return freezeModelInfo(result, catalogFields);
}

/** Builds the one shared record for a model from every route that offers it.
 *  Routes arrive in automatic-selection order. Each field comes from the first
 *  route whose provider stated it, else from the first route the shared catalog
 *  filled, else from the first route's default. */
export function mergeRouteModelInfos(routes: readonly [ModelInfo, ...ModelInfo[]]): ModelInfo {
  const [first] = routes;
  const result: MutableModelInfo = { ...first };
  const providerFields: ProviderModelInfoField[] = [];
  const catalogFields: ProviderModelInfoField[] = [];
  for (const field of MODEL_INFO_FIELDS) {
    let best = first;
    let bestSource = fieldSource(first, field);
    for (const route of routes) {
      const source = fieldSource(route, field);
      if (source < bestSource) {
        best = route;
        bestSource = source;
      }
    }
    copyField(result, best, field);
    if (bestSource === 0) providerFields.push(field);
    if (bestSource === 1) catalogFields.push(field);
  }
  result.providerFields = Object.freeze(providerFields);
  return freezeModelInfo(result, catalogFields);
}

/** Fills only the fields a route holds as runtime defaults from the model's
 *  shared record. What the route's own provider or its own catalog entry states
 *  stays, because it describes this exact route. */
function fillRouteModelInfoDefaults(route: ModelInfo, shared: ModelInfo): ModelInfo {
  const filled = MODEL_INFO_FIELDS.filter((field) => fieldSource(route, field) === 2 && fieldSource(shared, field) < 2);
  if (filled.length === 0) return route;
  const result: MutableModelInfo = { ...route };
  for (const field of filled) copyField(result, shared, field);
  return freezeModelInfo(result, [...route.catalogFields ?? [], ...filled]);
}

/** Merges every described route of each model into its shared record. Routes
 *  arrive in automatic-selection order, so the route a request would use first
 *  wins ties. */
export function sharedModelInfos(routes: Iterable<readonly [string, readonly CatalogModelOffering[]]>): ReadonlyMap<string, ModelInfo> {
  const byModel = new Map<string, [ModelInfo, ...ModelInfo[]]>();
  for (const [modelId, offerings] of routes) {
    for (const { resolvedMetadata } of offerings) {
      if (resolvedMetadata === undefined) continue;
      const infos = byModel.get(modelId);
      if (infos === undefined) byModel.set(modelId, [resolvedMetadata]);
      else infos.push(resolvedMetadata);
    }
  }
  return new Map([...byModel].map(([modelId, infos]) => [modelId, mergeRouteModelInfos(infos)]));
}

/** Completes each route of one provider catalog from the shared records. A
 *  route its provider described nothing for starts from `provider`'s defaults.
 *  Returns the same catalog when no route gains a field. */
export function fillCatalogRouteModelInfos(
  catalog: ReadonlyMap<string, readonly CatalogModelOffering[]>,
  shared: ReadonlyMap<string, ModelInfo>,
  provider: string,
): ReadonlyMap<string, readonly CatalogModelOffering[]> {
  let changed = false;
  const filled = new Map([...catalog].map(([modelId, offerings]) => {
    const record = shared.get(modelId);
    if (record === undefined) return [modelId, offerings] as const;
    const routes = offerings.map((offering) => {
      const base = offering.resolvedMetadata ?? providerModelInfo({ provider, id: modelId });
      const resolvedMetadata = fillRouteModelInfoDefaults(base, record);
      return resolvedMetadata === base ? offering : Object.freeze({ ...offering, resolvedMetadata });
    });
    if (routes.every((route, index) => route === offerings[index])) return [modelId, offerings] as const;
    changed = true;
    return [modelId, Object.freeze(routes)] as const;
  }));
  return changed ? filled : catalog;
}
