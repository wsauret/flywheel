
import { DebugLog } from "../debug-log.js";
import { canonicalCatalogModelId, canonicalModelId, preferredWireModelId, type CatalogDataUse } from "./model-id.js";
import type { ModelInfo } from "./models.js";
import { enrichProviderModelInfo, providerModelInfo } from "./provider-model-info.js";
export interface CatalogModelOffering {
  readonly wireModelId: string;
  readonly metadata: CatalogJsonValue;
  readonly dataUse: CatalogDataUse;
  readonly routeKind?: "free";
  readonly resolvedMetadata?: ModelInfo;
  readonly transport?: OfferingTransport;
}

export interface CatalogCanonicalRow {
  readonly modelId: string;
  readonly offerings: readonly CatalogModelOffering[];
}

/** The model a provider spelling belongs to, and whether that spelling is one of the model's free routes. */
interface GroupedOffering {
  readonly modelId: string;
  readonly freeRoute: boolean;
}

export type GroupedOfferingIndex = ReadonlyMap<string, GroupedOffering>;

/** Maps every provider spelling in grouped catalog rows to its canonical model identity. A spelling that is itself a
 *  model never counts as a free route. */
export function groupedOfferingIndex(rows: readonly CatalogCanonicalRow[]): GroupedOfferingIndex {
  const modelIds = new Set(rows.map((row) => row.modelId));
  const index = new Map<string, GroupedOffering>();
  for (const row of rows) {
    index.set(row.modelId, { modelId: row.modelId, freeRoute: false });
    for (const offering of row.offerings) {
      const spelling = canonicalModelId(offering.wireModelId);
      index.set(spelling, { modelId: row.modelId, freeRoute: offering.routeKind === "free" && !modelIds.has(spelling) });
    }
  }
  return index;
}

export interface CatalogSourceRow {
  readonly modelId: string;
  readonly wireModelId: string;
  readonly dataUse?: CatalogDataUse;
  readonly routeKind?: "free";
  readonly metadata: CatalogJsonValue;
  readonly resolvedMetadata?: ModelInfo;
  readonly transport?: OfferingTransport;
}
export interface CatalogWireIdentity {
  readonly modelId: string;
  readonly dataUse?: CatalogDataUse;
  readonly routeKind?: "free";
}

export type CatalogJsonValue = string | number | boolean | null | readonly CatalogJsonValue[] | { readonly [key: string]: CatalogJsonValue };

export type OfferingTransport = "anthropic-messages" | "openai-responses" | "openai-completions" | "google";

const UNRESOLVED_RELATIONSHIP_IDS_BYTES = 1024;
const CANONICAL_COLLISIONS_BYTES = 1024;

/** Records one bounded summary for unexpected stable routes that could not be
 *  joined to canonical catalog identity. Callers own generation-level timing. */
export function recordUnresolvedModelRelationships(
  providerId: string,
  observation: { readonly total: number; readonly values: readonly string[] },
): void {
  const unresolved = [...new Set(observation.values)].toSorted(compareStrings);
  const { total } = observation;
  if (total === 0) return;
  const included: string[] = [];
  let includedBytes = 2;
  for (const wireModelId of unresolved) {
    const encodedBytes = new TextEncoder().encode(JSON.stringify(wireModelId)).byteLength + (included.length === 0 ? 0 : 1);
    if (includedBytes + encodedBytes > UNRESOLVED_RELATIONSHIP_IDS_BYTES) continue;
    included.push(wireModelId);
    includedBytes += encodedBytes;
  }
  DebugLog.record({
    type: "model.catalog.relationship_unresolved",
    payload: {
      providerId,
      total,
      wireModelIds: included,
      omitted: total - included.length,
    },
  });
}

/** Returns the chat transport declared by models.dev npm metadata. */
export function offeringTransport(metadata: CatalogJsonValue): OfferingTransport | undefined {
  if (!isObject(metadata)) return undefined;
  const transport = metadata.transport;
  if (!isObject(transport) || typeof transport.npm !== "string") return undefined;
  if (transport.npm === "@ai-sdk/anthropic") return "anthropic-messages";
  if (transport.npm === "@ai-sdk/openai") return "openai-responses";
  if (transport.npm === "@ai-sdk/google" || transport.npm === "@ai-sdk/google-vertex") return "google";
  if (
    transport.npm === "@ai-sdk/openai-compatible"
    || transport.npm === "@openrouter/ai-sdk-provider"
    || transport.npm === "@ai-sdk/xai"
  ) return "openai-completions";
  return undefined;
}

export function offeringTransportFamily(transport: OfferingTransport): "anthropic" | "openai" | "google" {
  if (transport === "anthropic-messages") return "anthropic";
  return transport === "google" ? "google" : "openai";
}

function isOfferingTransport(value: unknown): value is OfferingTransport {
  return value === "anthropic-messages" || value === "openai-responses" || value === "openai-completions" || value === "google";
}

export interface CatalogLimits {
  readonly responseBytes: number;
  readonly canonicalRows: number;
  readonly modelIdLength: number;
  readonly durableBytes: number;
  readonly metadataDepth?: number;
  readonly metadataNodes?: number;
}

export const DEFAULT_DYNAMIC_CATALOG_LIMITS: CatalogLimits = {
  responseBytes: 2 * 1024 * 1024,
  canonicalRows: 10_000,
  modelIdLength: 512,
  durableBytes: 8 * 1024 * 1024,
  metadataDepth: 32,
  metadataNodes: 100_000,
};

type CatalogDiscoveryFailure = "http" | "timeout" | "transport" | "malformed" | "oversized";

export type CatalogDiscovery =
  | { readonly kind: "not-attempted" }
  | { readonly kind: "auth-invalid"; readonly status?: number }
  | { readonly kind: "failed"; readonly reason: CatalogDiscoveryFailure; readonly status?: number }
  | { readonly kind: "rows"; readonly rows: readonly unknown[] }
  | { readonly kind: "decoded-rows"; readonly rows: readonly CatalogSourceRow[] }
  | { readonly kind: "resolved-rows"; readonly rows: readonly CatalogCanonicalRow[] };

type CatalogLiveOutcome =
  | "valid"
  | "authentication-absent"
  | "authentication-invalid"
  | "discovery-failed"
  | "empty"
  | "unusable";

/** Why no catalog is available. `discovery-pending` is the one reason that is
 *  not an outcome: a cached-first listing found no saved rows and has not yet
 *  attempted discovery, and the refresh that follows settles it. */
type CatalogUnavailableReason = Exclude<CatalogLiveOutcome, "valid"> | "discovery-pending";

type CatalogProvenance =
  | "first-party"
  | "first-party-cached"
  | "models-dev-live"
  | "models-dev-archive"
  | "models-dev-bundled";

export function extractDataCatalogRows(body: unknown): readonly unknown[] {
  if (!isObject(body) || !Array.isArray(body.data)) throw new TypeError("model list data must be an array");
  if (!body.data.every((row) => isObject(row) && typeof row.id === "string" && row.id.length > 0)) {
    throw new TypeError("model list data rows must have non-empty ids");
  }
  return body.data;
}

export function canonicalizeIdCatalogRow(row: unknown): CatalogSourceRow | undefined {
  if (!isObject(row) || typeof row.id !== "string" || row.id.length === 0) return undefined;
  const sourceMetadata = Object.fromEntries(
    ["object", "owned_by"].flatMap((key) => isCatalogJsonValue(row[key]) ? [[key, row[key]]] : []),
  );
  const metadata = isCatalogJsonValue(row.metadata)
    ? row.metadata
    : Object.keys(sourceMetadata).length === 0 ? null : sourceMetadata;
  return {
    modelId: row.id,
    wireModelId: typeof row.wireModelId === "string" && row.wireModelId.length > 0 ? row.wireModelId : row.id,
    metadata,
  };
}

/** Normalizes an ID-only first-party listing into a runnable route. Shared
 * metadata can still enrich its absent descriptive and commercial fields. */
export function canonicalizeProviderIdCatalogRow(provider: string, row: unknown): CatalogSourceRow | undefined {
  const canonical = canonicalizeIdCatalogRow(row);
  return canonical === undefined
    ? undefined
    : { ...canonical, resolvedMetadata: providerModelInfo({ provider, id: canonical.modelId }) };
}

export interface ModelCatalogContribution {
  readonly limits: CatalogLimits;
  readonly extractRows: (body: unknown) => readonly unknown[];
  readonly canonicalize: (row: unknown) => CatalogSourceRow | undefined;
  /** When present, owns models.dev and discovered wire identity. Returning undefined rejects the row. */
  readonly canonicalizeWireId?: (wireModelId: string) => CatalogWireIdentity | undefined;
  readonly modelsDevCatalogIds: readonly string[];
  /** Uses stated models.dev capacities instead of advertised provider capacities.
   * Missing catalog capacities leave provider metadata unchanged. */
  readonly modelsDevMetadataFields?: readonly ("contextLimit" | "totalContextLimit")[];
  /** What the provider's own listing states. `authoritative`, the default, makes valid live rows the whole catalog.
   *  `extends-baseline` is for a listing that states only part of what the login serves: its rows join the models.dev
   *  rows instead of replacing them, so a model the listing names before models.dev does appears at once. */
  readonly liveMembership?: "authoritative" | "extends-baseline";
  /** What names a model. `wire`, the default, derives the identity from the provider's wire id. `models-dev-snapshot`
   *  is for a provider whose wire ids move between model snapshots: the snapshot that models.dev records as a wire's
   *  `canonical_model_id` names the model, and a wire with no recorded snapshot keeps its wire identity. Requests
   *  always send the wire. */
  readonly modelIdentity?: "wire" | "models-dev-snapshot";
  /** True for a wire the provider's own spelling marks as free. When the provider also serves that model on a paid
   *  wire, the free wire joins it as a free offering, which only an account that prefers free routes uses. Otherwise
   *  the free wire is the model's own route. */
  readonly isFreeWire?: (wireModelId: string) => boolean;
}

export type NormalizedCatalog =
  | { readonly kind: "valid"; readonly rows: readonly CatalogCanonicalRow[] }
  | { readonly kind: "rejected"; readonly reason: "too-many-rows" | "duplicate-model" | "model-id-too-long" | "invalid-canonical-row" };

export type ResolvedModelCatalog =
  | { readonly kind: "catalog"; readonly provenance: CatalogProvenance; readonly liveOutcome: CatalogLiveOutcome; readonly rows: readonly CatalogCanonicalRow[] }
  | { readonly kind: "unavailable"; readonly reason: CatalogUnavailableReason; readonly discoveryReason?: CatalogDiscoveryFailure };

interface ResolveModelCatalogOptions {
  readonly authenticated: boolean;
  readonly live: CatalogDiscovery;
  readonly canonicalFallback: readonly CatalogCanonicalRow[] | undefined;
  readonly fallbackProvenance?: "live" | "last-known-good" | "bundled";
  readonly contribution: ModelCatalogContribution;
  readonly firstPartyProvenance?: "first-party" | "first-party-cached";
  readonly cachedFirstParty?: readonly CatalogCanonicalRow[];
}

export function normalizeCatalogRows(rows: readonly unknown[], contribution: ModelCatalogContribution): NormalizedCatalog {
  return normalizeResolvedCatalogRows(rows.flatMap((row) => {
    const decoded = contribution.canonicalize(row);
    return decoded === undefined ? [] : [decoded];
  }), contribution.limits, contribution.isFreeWire);
}

/** Normalizes rows that already crossed a provider decoder or the typed ModelsClient boundary. */
export function normalizeDecodedCatalogRows(rows: readonly CatalogSourceRow[], limits: CatalogLimits, isFreeWire?: (wireModelId: string) => boolean): NormalizedCatalog {
  return normalizeResolvedCatalogRows(rows, limits, isFreeWire);
}

/** Normalizes resolved rows without emitting source-owned diagnostics. `isFreeWire` is the contribution's free-wire
 *  predicate: when present, it alone decides which of the provider's wires are free routes. */
export function normalizeResolvedCatalogRows(rows: readonly CatalogSourceRow[], limits: CatalogLimits, isFreeWire?: (wireModelId: string) => boolean): NormalizedCatalog {
  return normalizeDecodedRows(rows, limits, isFreeWire);
}

function normalizeDecodedRows(rows: readonly CatalogSourceRow[], limits: CatalogLimits, isFreeWire: ((wireModelId: string) => boolean) | undefined): NormalizedCatalog {
  requireCatalogLimits(limits);
  const routes = rows.map((source) => {
    const canonical = canonicalCatalogModelId(source.modelId);
    return { source, modelId: canonical.modelId, dataUse: source.dataUse ?? canonical.dataUse };
  });
  // A free wire is a free route of its model only when the provider also serves that model, in the same data-use
  // class, on a paid wire. A model the provider serves only on a free wire keeps that wire as its own route, so an
  // account without free routes can still use it.
  const paidGroups = isFreeWire === undefined
    ? undefined
    : new Set(routes.filter((route) => !isFreeWire(route.source.wireModelId)).map((route) => `${route.modelId}\0${route.dataUse}`));
  const byModel = new Map<string, Map<string, CatalogModelOffering>>();
  for (const { source, ...identity } of routes) {
    const metadata = normalizeCatalogMetadata(source.metadata, limits);
    if (metadata === undefined) return { kind: "rejected", reason: "invalid-canonical-row" };
    const routeKind = isFreeWire === undefined || !isFreeWire(source.wireModelId)
      ? source.routeKind
      : paidGroups?.has(`${identity.modelId}\0${identity.dataUse}`) === true ? "free" : undefined;
    const offering = Object.freeze({
      wireModelId: source.wireModelId,
      metadata: metadata.value,
      dataUse: identity.dataUse,
      ...(routeKind === undefined ? {} : { routeKind }),
      ...(source.resolvedMetadata === undefined ? {} : { resolvedMetadata: source.resolvedMetadata }),
      ...(source.transport === undefined ? {} : { transport: source.transport }),
    });
    const routeIdentity = `${identity.dataUse}:${routeKind ?? "default"}`;
    const offerings = byModel.get(identity.modelId) ?? new Map<string, CatalogModelOffering>();
    const previous = offerings.get(routeIdentity);
    if (previous?.wireModelId === offering.wireModelId && JSON.stringify(previous.metadata) !== JSON.stringify(offering.metadata)) {
      return { kind: "rejected", reason: "duplicate-model" };
    }
    if (!previous || preferredWireModelId(previous.wireModelId, offering.wireModelId) === offering.wireModelId) {
      offerings.set(routeIdentity, offering);
      byModel.set(identity.modelId, offerings);
    }
  }
  const canonicalRows = [...byModel].map(([modelId, offerings]) => Object.freeze({
    modelId,
    offerings: Object.freeze([
      ...offerings.values(),
    ].toSorted((left, right) =>
      (left.dataUse === right.dataUse ? 0 : left.dataUse === "standard" ? -1 : 1)
      || ((left.routeKind === "free" ? 1 : 0) - (right.routeKind === "free" ? 1 : 0))
      || left.wireModelId.localeCompare(right.wireModelId)
    )),
  }));
  return validateCanonicalRows(canonicalRows, limits);
}

/** Records one bounded provider-scoped collision summary for a completed catalog discovery. */
export function recordCanonicalModelCollisions(
  providerId: string,
  observation: {
    readonly total: number;
    readonly values: readonly {
      readonly modelId: string;
      readonly wireModelIds: readonly string[];
      readonly total: number;
    }[];
  },
): void {
  if (observation.total === 0) return;
  const collisions: Array<{ readonly modelId: string; readonly wireModelIds: readonly string[]; readonly total: number; readonly omitted: number }> = [];
  let includedBytes = 2;
  for (const collision of observation.values) {
    const wireModelIds = boundedSortedStrings(collision.wireModelIds, Math.max(0, CANONICAL_COLLISIONS_BYTES - includedBytes));
    const candidate = {
      modelId: collision.modelId,
      wireModelIds,
      total: collision.total,
      omitted: collision.total - wireModelIds.length,
    };
    const encodedBytes = new TextEncoder().encode(JSON.stringify(candidate)).byteLength + (collisions.length === 0 ? 0 : 1);
    if (includedBytes + encodedBytes > CANONICAL_COLLISIONS_BYTES) continue;
    collisions.push(candidate);
    includedBytes += encodedBytes;
  }
  DebugLog.record({
    type: "model.catalog.canonical_collision",
    payload: {
      providerId,
      total: observation.total,
      collisions,
      omitted: observation.total - collisions.length,
    },
  });
}

function boundedSortedStrings(values: Iterable<string>, byteLimit: number): readonly string[] {
  const included: string[] = [];
  let includedBytes = 2;
  for (const value of [...values].toSorted(compareStrings)) {
    const encodedBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength + (included.length === 0 ? 0 : 1);
    if (includedBytes + encodedBytes > byteLimit) continue;
    included.push(value);
    includedBytes += encodedBytes;
  }
  return included;
}


export function validateCanonicalRows(rows: readonly unknown[], limits: CatalogLimits): NormalizedCatalog {
  requireCatalogLimits(limits);
  if (rows.length > limits.canonicalRows) return { kind: "rejected", reason: "too-many-rows" };
  const models = new Set<string>();
  const normalized: CatalogCanonicalRow[] = [];
  for (const row of rows) {
    if (!isCanonicalRow(row) || modelIdHasTerminalControl(row.modelId)) return { kind: "rejected", reason: "invalid-canonical-row" };
    const offerings: CatalogModelOffering[] = [];
    for (const offering of row.offerings) {
      if (modelIdHasTerminalControl(offering.wireModelId)) return { kind: "rejected", reason: "invalid-canonical-row" };
      const metadata = normalizeCatalogMetadata(offering.metadata, limits);
      if (metadata === undefined) return { kind: "rejected", reason: "invalid-canonical-row" };
      if (row.modelId.length > limits.modelIdLength || offering.wireModelId.length > limits.modelIdLength) return { kind: "rejected", reason: "model-id-too-long" };
      offerings.push(Object.freeze({ ...offering, metadata: metadata.value }));
    }
    if (models.has(row.modelId)) return { kind: "rejected", reason: "duplicate-model" };
    models.add(row.modelId);
    normalized.push(Object.freeze({ modelId: row.modelId, offerings: Object.freeze(offerings) }));
  }
  return { kind: "valid", rows: Object.freeze(normalized) };
}

export function resolveModelCatalog(options: ResolveModelCatalogOptions): ResolvedModelCatalog {
  if (!options.authenticated) return { kind: "unavailable", reason: "authentication-absent" };

  const cachedFirstParty = options.cachedFirstParty === undefined
    ? undefined
    : validateCanonicalRows(options.cachedFirstParty, options.contribution.limits);
  const live = cachedFirstParty?.kind === "valid"
    ? cachedFirstParty
    : options.live.kind === "rows"
    ? normalizeCatalogRows(options.live.rows, options.contribution)
    : options.live.kind === "decoded-rows"
      ? normalizeDecodedCatalogRows(options.live.rows, options.contribution.limits, options.contribution.isFreeWire)
      : options.live.kind === "resolved-rows"
        ? validateCanonicalRows(options.live.rows, options.contribution.limits)
      : undefined;
  const liveOutcome: CatalogLiveOutcome = cachedFirstParty?.kind === "valid" && cachedFirstParty.rows.length > 0 && options.live.kind === "not-attempted"
    ? "valid"
    : options.live.kind === "auth-invalid"
    ? "authentication-invalid"
    : options.live.kind === "failed"
      ? "discovery-failed"
      : options.live.kind === "not-attempted"
        ? "discovery-failed"
        : (options.live.kind === "rows" || options.live.kind === "decoded-rows" || options.live.kind === "resolved-rows") && options.live.rows.length === 0
          ? "empty"
          : live?.kind === "valid" && live.rows.length > 0
            ? "valid"
            : "unusable";
  if (liveOutcome === "authentication-invalid") return { kind: "unavailable", reason: liveOutcome };

  const fallback = options.canonicalFallback === undefined
    ? undefined
    : validateCanonicalRows(options.canonicalFallback, options.contribution.limits);
  if (live?.kind === "valid" && live.rows.length > 0) {
    const enriched = fallback?.kind === "valid" ? enrichCatalogRows(live.rows, fallback.rows) : live.rows;
    const listed = new Set(live.rows.map((row) => row.modelId));
    const membership = options.contribution.liveMembership === "extends-baseline" && fallback?.kind === "valid"
      ? [...enriched, ...fallback.rows.filter((row) => !listed.has(row.modelId))]
      : enriched;
    const bounded = validateCanonicalRows(membership, options.contribution.limits);
    return {
      kind: "catalog",
      provenance: options.firstPartyProvenance ?? "first-party",
      liveOutcome,
      rows: bounded.kind === "valid" ? bounded.rows : live.rows,
    };
  }
  if (fallback?.kind === "valid" && fallback.rows.length > 0) {
    const provenance = options.fallbackProvenance === "live"
      ? "models-dev-live"
      : options.fallbackProvenance === "last-known-good"
        ? "models-dev-archive"
        : "models-dev-bundled";
    return { kind: "catalog", provenance, liveOutcome, rows: fallback.rows };
  }

  if (liveOutcome === "discovery-failed") {
    const discoveryReason = options.live.kind === "failed" ? options.live.reason : "malformed";
    return { kind: "unavailable", reason: liveOutcome, discoveryReason };
  }
  return { kind: "unavailable", reason: liveOutcome === "valid" ? "unusable" : liveOutcome };
}

function enrichCatalogRows(firstParty: readonly CatalogCanonicalRow[], metadata: readonly CatalogCanonicalRow[]): readonly CatalogCanonicalRow[] {
  const metadataByModel = new Map(metadata.map((row) => [row.modelId, row]));
  return Object.freeze(firstParty.map((row) => {
    const enrichments = metadataByModel.get(row.modelId)?.offerings;
    if (!enrichments) return row;
    return Object.freeze({
      modelId: row.modelId,
      offerings: Object.freeze(row.offerings.map((offering) => {
        const enrichment = enrichments.find((candidate) =>
          candidate.dataUse === offering.dataUse && candidate.routeKind === offering.routeKind
        );
        if (!enrichment) return offering;
        const merged = isObject(enrichment.metadata) && isObject(offering.metadata)
          ? { ...enrichment.metadata, ...offering.metadata }
          : offering.metadata ?? enrichment.metadata;
        return Object.freeze({
          ...offering,
          metadata: merged,
          ...((offering.resolvedMetadata ?? enrichment.resolvedMetadata) === undefined ? {} : {
            resolvedMetadata: offering.resolvedMetadata !== undefined && enrichment.resolvedMetadata !== undefined
              ? enrichProviderModelInfo(offering.resolvedMetadata, enrichment.resolvedMetadata)
              : offering.resolvedMetadata ?? enrichment.resolvedMetadata,
          }),
          ...((offering.transport ?? enrichment.transport) === undefined ? {} : { transport: offering.transport ?? enrichment.transport }),
        });
      })),
    });
  }));
}

function isCanonicalRow(value: unknown): value is CatalogCanonicalRow {
  if (!isObject(value) || !hasOnlyKeys(value, ["modelId", "offerings"]) || typeof value.modelId !== "string" || value.modelId.length === 0
    || !Array.isArray(value.offerings) || value.offerings.length === 0 || value.offerings.length > 4) return false;
  const routeIdentities = new Set<string>();
  for (const offering of value.offerings) {
    if (!isObject(offering) || !hasOnlyKeys(offering, ["wireModelId", "metadata", "dataUse", "routeKind", "transport", "resolvedMetadata"])
      || typeof offering.wireModelId !== "string" || offering.wireModelId.length === 0
      || (offering.transport !== undefined && !isOfferingTransport(offering.transport))
      || (offering.routeKind !== undefined && offering.routeKind !== "free")
      || (offering.dataUse !== "standard" && offering.dataUse !== "contributor")
      // Remove after 2026-12-22: older version-1 durable rows omitted
      // resolvedMetadata; models.dev enrichment reconstructs their gaps.
      || (offering.resolvedMetadata !== undefined && !isModelInfo(offering.resolvedMetadata))) return false;
    const routeIdentity = `${offering.dataUse}:${offering.routeKind ?? "default"}`;
    if (routeIdentities.has(routeIdentity)) return false;
    routeIdentities.add(routeIdentity);
  }
  return true;
}

function isModelInfo(value: unknown): value is ModelInfo {
  if (!isObject(value)
    || typeof value.provider !== "string"
    || (value.family !== "anthropic" && value.family !== "openai" && value.family !== "google")
    || typeof value.id !== "string"
    || typeof value.name !== "string"
    || typeof value.openWeights !== "boolean"
    || typeof value.reasoning !== "boolean"
    || typeof value.toolCall !== "boolean"
    || typeof value.attachment !== "boolean"
    || typeof value.temperature !== "boolean"
    || !positiveInteger(value.contextLimit)
    || !positiveInteger(value.outputLimit)
    || !isCost(value.cost)
    || !isPricing(value.pricing)
    || !isObject(value.modalities)
    || !stringArray(value.modalities.input)
    || !stringArray(value.modalities.output)) return false;
  if (value.totalContextLimit !== undefined && !positiveInteger(value.totalContextLimit)) return false;
  if (value.interleavedReasoningField !== undefined && typeof value.interleavedReasoningField !== "string") return false;
  if (value.reasoningEfforts !== undefined && (!Array.isArray(value.reasoningEfforts)
    || value.reasoningEfforts.some((effort) => effort !== "none" && effort !== "minimal" && effort !== "low"
      && effort !== "medium" && effort !== "high" && effort !== "xhigh" && effort !== "max" && effort !== "ultra"))) return false;
  for (const fields of [value.providerFields, value.catalogFields]) {
    if (fields !== undefined && (!Array.isArray(fields) || fields.some((field) => typeof field !== "string"))) return false;
  }
  return true;
}

function isPricing(value: unknown): boolean {
  if (!isObject(value)) return false;
  if (value.status === "unavailable") return value.reason === "missing-rate-card";
  return value.status === "available" && isCost(value.rateCard) && isObject(value.provenance)
    && (value.provenance.source === "models.dev" || value.provenance.source === "provider-api" || value.provenance.source === "provider-docs")
    && typeof value.provenance.provider === "string" && typeof value.provenance.model === "string";
}

function isCost(value: unknown): boolean {
  if (!isObject(value) || !nonNegative(value.input) || !nonNegative(value.output)
    || !optionalNonNegative(value.cacheRead) || !optionalNonNegative(value.cacheWrite) || !optionalNonNegative(value.reasoning)) return false;
  if (value.highContext === undefined) return true;
  return isObject(value.highContext) && positiveInteger(value.highContext.threshold)
    && nonNegative(value.highContext.input) && nonNegative(value.highContext.output)
    && optionalNonNegative(value.highContext.cacheRead) && optionalNonNegative(value.highContext.cacheWrite)
    && optionalNonNegative(value.highContext.reasoning);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function optionalNonNegative(value: unknown): boolean {
  return value === undefined || nonNegative(value);
}

function stringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

export function modelIdHasTerminalControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function normalizeCatalogMetadata(value: unknown, limits: CatalogLimits): { readonly value: CatalogJsonValue } | undefined {
  const maximumDepth = limits.metadataDepth ?? 32;
  const maximumNodes = limits.metadataNodes ?? 100_000;
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    nodes += 1;
    if (nodes > maximumNodes || current.depth > maximumDepth) return undefined;
    const entry = current.value;
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") continue;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) return undefined;
      continue;
    }
    if (typeof entry !== "object") return undefined;
    if (seen.has(entry)) return undefined;
    seen.add(entry);
    if (Array.isArray(entry) && Object.keys(entry).length !== entry.length) return undefined;
    if (!Array.isArray(entry) && (!isObject(entry) || !isPlainObject(entry))) return undefined;
    const children = Array.isArray(entry) ? entry : Object.values(entry);
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }

  if (!isCatalogJsonValue(value)) return undefined;
  const copy = structuredClone(value);
  const containers: object[] = [];
  const freezePending: unknown[] = [copy];
  while (freezePending.length > 0) {
    const current = freezePending.pop();
    if (typeof current !== "object" || current === null) continue;
    containers.push(current);
    freezePending.push(...(Array.isArray(current) ? current : Object.values(current)));
  }
  for (const container of containers.toReversed()) Object.freeze(container);
  return { value: copy };
}

function requireCatalogLimits(limits: CatalogLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Catalog limit ${name} must be a positive safe integer`);
  }
}

interface UnknownObject { readonly [key: string]: unknown }

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: UnknownObject): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isCatalogJsonValue(value: unknown): value is CatalogJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCatalogJsonValue);
  return isObject(value) && isPlainObject(value) && Object.values(value).every(isCatalogJsonValue);
}

function hasOnlyKeys(value: UnknownObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
