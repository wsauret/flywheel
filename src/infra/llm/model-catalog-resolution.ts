
import { DebugLog } from "../debug-log.js";
import { canonicalCatalogModelId, canonicalModelId, preferredWireModelId, type CatalogDataUse } from "../model-id.js";
import type { ModelFamily } from "./model-family.js";
import type { ModelInfo } from "./models.js";
import { capContextWindow, enrichProviderModelInfo, providerModelInfo } from "./provider-model-info.js";
import type { CatalogJsonValue, CatalogModelOffering, OfferingTransport } from "../catalog-model-offering.js";
import { isCatalogJsonValue, normalizeCatalogMetadata, requireCatalogLimits, validateCanonicalRows, type CatalogCanonicalRow, type CatalogLimits, type NormalizedCatalog } from "../model-catalog-rows.js";
import type { GroupedOffering, GroupedOfferingIndex } from "../auth/provider-models/provider-model-preference-store.js";

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

export function offeringTransportFamily(transport: OfferingTransport): ModelFamily {
  switch (transport) {
    case "anthropic-messages": return "anthropic";
    case "openai-responses": return "openai";
    case "chat-completions": return "chat-completions";
    case "google": return "google";
  }
}

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
  readonly extractRows: (body: CatalogJsonValue) => readonly unknown[];
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary: one row of a provider's model-listing response, as `extractRows` returns it
  readonly canonicalize: (row: unknown) => CatalogSourceRow | undefined;
  /** When present, owns models.dev and discovered wire identity. Returning undefined rejects the row. */
  readonly canonicalizeWireId?: (wireModelId: string) => CatalogWireIdentity | undefined;
  readonly modelsDevCatalogIds: readonly string[];
  /** Uses stated models.dev capacities instead of advertised provider capacities.
   * Missing catalog capacities leave provider metadata unchanged. */
  readonly modelsDevMetadataFields?: readonly ("contextLimit" | "totalContextLimit")[];
  /** What names a model. `wire`, the default, derives the identity from the provider's wire id. `models-dev-snapshot`
   *  is for a provider whose wire ids move between model snapshots: the snapshot that models.dev records as a wire's
   *  `canonical_model_id` names the model, and a wire with no recorded snapshot keeps its wire identity. Requests
   *  always send the wire. */
  readonly modelIdentity?: "wire" | "models-dev-snapshot";
  /** True for a wire the provider's own spelling marks as free. When the provider also serves that model on a paid
   *  wire, the free wire joins it as a free offering, which only an account that prefers free routes uses. Otherwise
   *  the free wire is the model's own route. */
  readonly isFreeWire?: (wireModelId: string) => boolean;
  /** `first-party` is for a provider whose own listing is its whole lineup, such as an engine that states the models
   *  it serves. models.dev rows then only describe the models that listing names and never stand as the catalog, so the
   *  provider shows no model when it has neither a current listing nor valid saved first-party rows. Absent, models.dev
   *  rows stand in for a listing that fails. */
  readonly membership?: "first-party";
  /** The most context, in tokens, that the route serves on the wire `wireModelId`, such as a window below an engine's
   *  own compaction, or undefined for no cap. It bounds each listed row after the models.dev join: a smaller joined
   *  window stays, a larger one is lowered to the cap, and a row that states no window takes the cap. */
  readonly contextCap?: (wireModelId: string) => number | undefined;
}

/** The models.dev rows that may stand as a provider's catalog when its own listing has none. Enrichment of listed
 *  rows always reads every models.dev row. */
export function membershipFallback(contribution: ModelCatalogContribution, rows: readonly CatalogCanonicalRow[]): readonly CatalogCanonicalRow[] {
  return contribution.membership === "first-party" ? [] : rows;
}

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

function normalizeCatalogRows(rows: readonly unknown[], contribution: ModelCatalogContribution): NormalizedCatalog {
  return normalizeResolvedCatalogRows(rows.flatMap((row) => {
    const decoded = contribution.canonicalize(row);
    return decoded === undefined ? [] : [decoded];
  }), contribution.limits, contribution.isFreeWire);
}

/** Normalizes rows that already crossed a provider decoder or the typed ModelsClient boundary, without emitting
 *  source-owned diagnostics. `isFreeWire` is the contribution's free-wire predicate: when present, it alone decides
 *  which of the provider's wires are free routes. */
export function normalizeResolvedCatalogRows(rows: readonly CatalogSourceRow[], limits: CatalogLimits, isFreeWire?: (wireModelId: string) => boolean): NormalizedCatalog {
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

/** The rows that discovery returned, normalized by the shape the discovery delivered them in. */
function normalizedDiscovery(discovery: CatalogDiscovery, contribution: ModelCatalogContribution): NormalizedCatalog | undefined {
  switch (discovery.kind) {
    case "rows": return normalizeCatalogRows(discovery.rows, contribution);
    case "decoded-rows": return normalizeResolvedCatalogRows(discovery.rows, contribution.limits, contribution.isFreeWire);
    case "resolved-rows": return validateCanonicalRows(discovery.rows, contribution.limits);
    default: return undefined;
  }
}

function discoveryOutcome(discovery: CatalogDiscovery, live: NormalizedCatalog | undefined, cachedRows: boolean): CatalogLiveOutcome {
  switch (discovery.kind) {
    case "not-attempted": return cachedRows ? "valid" : "discovery-failed";
    case "auth-invalid": return "authentication-invalid";
    case "failed": return "discovery-failed";
    default:
      if (discovery.rows.length === 0) return "empty";
      return live?.kind === "valid" && live.rows.length > 0 ? "valid" : "unusable";
  }
}

export function resolveModelCatalog(options: ResolveModelCatalogOptions): ResolvedModelCatalog {
  if (!options.authenticated) return { kind: "unavailable", reason: "authentication-absent" };

  const cachedFirstParty = options.cachedFirstParty === undefined
    ? undefined
    : validateCanonicalRows(options.cachedFirstParty, options.contribution.limits);
  const live = cachedFirstParty?.kind === "valid" ? cachedFirstParty : normalizedDiscovery(options.live, options.contribution);
  const cachedRows = cachedFirstParty?.kind === "valid" && cachedFirstParty.rows.length > 0;
  const liveOutcome = discoveryOutcome(options.live, live, cachedRows);
  if (liveOutcome === "authentication-invalid") return { kind: "unavailable", reason: liveOutcome };

  const fallback = options.canonicalFallback === undefined
    ? undefined
    : validateCanonicalRows(options.canonicalFallback, options.contribution.limits);
  if (live?.kind === "valid" && live.rows.length > 0) {
    const joined = fallback?.kind === "valid" ? enrichCatalogRows(live.rows, fallback.rows) : live.rows;
    const enriched = options.contribution.contextCap === undefined ? joined : capCatalogRows(joined, options.contribution.contextCap);
    const bounded = validateCanonicalRows(enriched, options.contribution.limits);
    return {
      kind: "catalog",
      provenance: options.firstPartyProvenance ?? "first-party",
      liveOutcome,
      rows: bounded.kind === "valid" ? bounded.rows : live.rows,
    };
  }
  const members = fallback?.kind === "valid" ? membershipFallback(options.contribution, fallback.rows) : [];
  if (members.length > 0) {
    const provenance = options.fallbackProvenance === "live"
      ? "models-dev-live"
      : options.fallbackProvenance === "last-known-good"
        ? "models-dev-archive"
        : "models-dev-bundled";
    return { kind: "catalog", provenance, liveOutcome, rows: members };
  }

  if (liveOutcome === "discovery-failed") {
    const discoveryReason = options.live.kind === "failed" ? options.live.reason : "malformed";
    return { kind: "unavailable", reason: liveOutcome, discoveryReason };
  }
  return { kind: "unavailable", reason: liveOutcome === "valid" ? "unusable" : liveOutcome };
}

/** First-party rows with the metadata that models.dev states for the same model and route filling what they omit. */
export function enrichCatalogRows(firstParty: readonly CatalogCanonicalRow[], metadata: readonly CatalogCanonicalRow[]): readonly CatalogCanonicalRow[] {
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

function capCatalogRows(rows: readonly CatalogCanonicalRow[], cap: (wireModelId: string) => number | undefined): readonly CatalogCanonicalRow[] {
  return Object.freeze(rows.map((row) => Object.freeze({
    modelId: row.modelId,
    offerings: Object.freeze(row.offerings.map((offering) => {
      const limit = cap(offering.wireModelId);
      return limit === undefined || offering.resolvedMetadata === undefined
        ? offering
        : Object.freeze({ ...offering, resolvedMetadata: capContextWindow(offering.resolvedMetadata, limit) });
    })),
  })));
}

interface UnknownObject { readonly [key: string]: unknown }

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
