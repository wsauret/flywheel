/** Catalog row joining for provider model listing: the models.dev baseline, saved and discovered rows, and their model maps. */
import { createHash } from "node:crypto";
import { CatalogDiscoveryDiagnosticAccumulator, type CatalogDiscoveryDiagnostics } from "./model-catalog-diagnostics.js";
import { normalizeResolvedCatalogRows, offeringTransport, type CatalogCanonicalRow, type CatalogDiscovery, type CatalogJsonValue, type CatalogModelOffering, type CatalogSourceRow, type ModelCatalogContribution, type OfferingTransport } from "./model-catalog-resolution.js";
import type { ModelInfo, ModelsClient, ProviderModelInfoField } from "./models.js";
import { narrowContextWindow, preferCatalogModelInfoFields, providerModelInfo } from "./provider-model-info.js";
import type { SavedModelRefusals } from "../auth/provider-model-catalog-store.js";
import { authoredCatalogModelId, canonicalCatalogModelId, canonicalModelId, isMovingModelAlias, preferredWireModelId, type CatalogDataUse } from "./model-id.js";
import { canonicalize } from "../canonical-name.js";

const STATIC_OFFERING_ORDER: readonly CatalogDataUse[] = ["standard", "contributor"];

export interface SharedModelsDevBaseline {
  readonly rows: readonly CatalogSourceRow[];
  readonly canonicalRows: readonly CatalogCanonicalRow[];
  readonly relationshipsByWireId: ReadonlyMap<string, { readonly modelId: string; readonly dataUse: CatalogDataUse; readonly routeKind?: "free" }>;
  readonly knownWireIds: ReadonlySet<string>;
  readonly provenance: "live" | "last-known-good" | "bundled";
  readonly generation: string;
}

export interface JoinedCatalogRows {
  readonly rows: readonly CatalogCanonicalRow[];
  readonly collisions: CatalogDiscoveryDiagnostics["collisions"];
  readonly unknownWireModelIds: CatalogDiscoveryDiagnostics["unknownWireModelIds"];
}

/** Reads the models.dev rows for one contribution from the document the
 *  process already holds. Listing never waits on models.dev: the owned
 *  metadata refresh replaces that document, and the next listing reads it. */
export function modelsDevBaseline(
  contribution: ModelCatalogContribution,
  modelsClient: ModelsClient | undefined,
): SharedModelsDevBaseline {
  if (modelsClient !== undefined) {
    const rows = modelsClient.getProviderCatalog(contribution.modelsDevCatalogIds, contribution.limits.canonicalRows);
    const sourceRows = rows.flatMap((row): readonly CatalogSourceRow[] => {
      const identity = contribution.canonicalizeWireId === undefined
        ? (row.canonical === null ? undefined : {
            modelId: (contribution.modelIdentity === "models-dev-snapshot" ? row.snapshotModelId : undefined) ?? row.canonical.modelId,
            dataUse: row.dataUse ?? canonicalCatalogModelId(row.canonical.modelId).dataUse,
          })
        : contribution.canonicalizeWireId(row.wireModelId);
      if (identity === undefined) return [];
      const transport = row.transport === null ? undefined : offeringTransport({ transport: row.transport });
      return [{
        modelId: identity.modelId,
        wireModelId: row.wireModelId,
        dataUse: identity.dataUse ?? row.dataUse ?? canonicalCatalogModelId(identity.modelId).dataUse,
        ...(identity.routeKind === undefined ? {} : { routeKind: identity.routeKind }),
        metadata: jsonMetadata({ ...row.metadata, transport: row.transport }),
        resolvedMetadata: row.metadata,
        ...(transport === undefined ? {} : { transport }),
      }];
    });
    const canonical = normalizeResolvedCatalogRows(sourceRows, contribution.limits, contribution.isFreeWire);
    const generation = createHash("sha256")
      .update(sourceRows.map((row) => `${row.wireModelId}\0${row.modelId}\0${row.dataUse ?? ""}\0${row.routeKind ?? ""}`).toSorted().join("\n"))
      .digest("hex");
    return {
      rows: sourceRows,
      canonicalRows: canonical.kind === "valid" ? canonical.rows : [],
      relationshipsByWireId: new Map(sourceRows.map((row) => [row.wireModelId, {
        modelId: row.modelId,
        dataUse: row.dataUse ?? canonicalCatalogModelId(row.modelId).dataUse,
        ...(row.routeKind === undefined ? {} : { routeKind: row.routeKind }),
      }])),
      knownWireIds: new Set(rows.map((row) => row.wireModelId)),
      provenance: rows[0]?.provenance ?? "bundled",
      generation,
    };
  }
  return {
    rows: [],
    canonicalRows: [],
    relationshipsByWireId: new Map(),
    knownWireIds: new Set(),
    provenance: "bundled",
    generation: "absent",
  };
}

function jsonMetadata(value: unknown): CatalogJsonValue {
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- boundary: JSON serialization removes optional undefined fields before catalog validation
  return JSON.parse(JSON.stringify(value));
}

export function reconcileSavedCatalogRows(
  savedRows: readonly CatalogCanonicalRow[],
  baseline: SharedModelsDevBaseline,
  contribution: ModelCatalogContribution,
): JoinedCatalogRows {
  const sourceRows = savedRows.flatMap((row) => row.offerings.map((offering): CatalogSourceRow => ({
        modelId: row.modelId,
        wireModelId: offering.wireModelId,
        dataUse: offering.dataUse,
        ...(offering.routeKind === undefined ? {} : { routeKind: offering.routeKind }),
        metadata: offering.metadata,
        ...(offering.resolvedMetadata === undefined ? {} : { resolvedMetadata: offering.resolvedMetadata }),
        ...(offering.transport === undefined ? {} : { transport: offering.transport }),
      })));
  return joinCatalogRows(sourceRows, baseline, contribution);
}

export function decodeDiscoveryRows(discovery: CatalogDiscovery, contribution: ModelCatalogContribution): readonly CatalogSourceRow[] | undefined {
  if (discovery.kind === "rows") {
    return discovery.rows.flatMap((row) => {
      const decoded = contribution.canonicalize(row);
      return decoded === undefined ? [] : [decoded];
    });
  }
  if (discovery.kind === "decoded-rows") return discovery.rows;
  return undefined;
}

export function joinCatalogRows(
  sourceRows: readonly CatalogSourceRow[],
  baseline: SharedModelsDevBaseline,
  contribution: ModelCatalogContribution,
): JoinedCatalogRows {
  const eligible: CatalogSourceRow[] = [];
  const diagnostics = new CatalogDiscoveryDiagnosticAccumulator(contribution.limits.modelIdLength);
  for (const row of sourceRows) {
    const relationship = baseline.relationshipsByWireId.get(row.wireModelId);
    if (relationship === undefined && !baseline.knownWireIds.has(row.wireModelId)) diagnostics.addUnknown(row.wireModelId);
    if (isMovingModelAlias(row.wireModelId)) continue;
    const identity = contribution.canonicalizeWireId === undefined
      ? relationship ?? {
          modelId: row.modelId,
          dataUse: row.dataUse ?? canonicalCatalogModelId(row.modelId).dataUse,
        }
      : contribution.canonicalizeWireId(row.wireModelId);
    if (identity === undefined) continue;
    const resolved = { ...row, ...identity };
    eligible.push(resolved);
    diagnostics.addResolved(resolved);
  }
  const normalizedEligible = normalizeResolvedCatalogRows(eligible, contribution.limits, contribution.isFreeWire);
  return {
    rows: normalizedEligible.kind === "valid" ? normalizedEligible.rows : [],
    ...diagnostics.snapshot(),
  };
}

export function preferredCatalog(
  discovery: readonly CatalogCanonicalRow[] | undefined,
  saved: readonly CatalogCanonicalRow[] | undefined,
  fallback: readonly CatalogCanonicalRow[],
): readonly CatalogCanonicalRow[] {
  if (discovery !== undefined && discovery.length > 0) return discovery;
  if (saved !== undefined && saved.length > 0) return saved;
  return fallback;
}

/** Projects route metadata without changing retained provider evidence.
 * Catalog preferences apply only to fields the catalog explicitly states. */
export function catalogRowsToModelMap(
  rows: readonly CatalogCanonicalRow[],
  defaultTransport: OfferingTransport | undefined,
  metadataPreference?: {
    readonly fields: readonly ProviderModelInfoField[];
    readonly rows: readonly CatalogSourceRow[];
  },
): ReadonlyMap<string, readonly CatalogModelOffering[]> {
  const metadataByWireId = metadataPreference === undefined
    ? undefined
    : new Map(metadataPreference.rows.map((row) => [row.wireModelId, row.resolvedMetadata]));
  return new Map(rows.map((row) => [row.modelId, Object.freeze(row.offerings.map((offering) => {
    const transport = offering.transport ?? offeringTransport(offering.metadata) ?? defaultTransport;
    const catalogMetadata = metadataByWireId?.get(offering.wireModelId);
    const resolvedMetadata = metadataPreference === undefined || catalogMetadata === undefined
      ? offering.resolvedMetadata
      : preferCatalogModelInfoFields(
          offering.resolvedMetadata ?? providerModelInfo({ provider: catalogMetadata.provider, id: row.modelId }),
          catalogMetadata,
          metadataPreference.fields,
        );
    return Object.freeze({
      ...offering,
      ...(resolvedMetadata === undefined ? {} : { resolvedMetadata }),
      ...(transport === undefined ? {} : { transport }),
    });
  }))]));
}

interface DescribedWire {
  readonly wireModelId: string;
  readonly metadata: ModelInfo;
}

/** The offerings of a provider whose model list is user-authored: each declared wire spelling under its authored
 *  identity. A declared model takes its metadata from the `catalog` row with the same wire id, ignoring case, so a
 *  dated snapshot keeps its own row; else from the preferred row of its canonical model; else it carries none. */
export function staticOfferingMap(
  wireModelIds: Iterable<string>,
  transport: OfferingTransport,
  catalog: readonly DescribedWire[],
): ReadonlyMap<string, readonly CatalogModelOffering[]> {
  const byWire = preferredRowsBy(catalog, canonicalize);
  const byModel = preferredRowsBy(catalog, canonicalModelId);
  const result = new Map<string, Map<CatalogDataUse, CatalogModelOffering>>();
  for (const wireModelId of wireModelIds) {
    const { modelId, dataUse } = authoredCatalogModelId(wireModelId);
    const offerings = result.get(modelId) ?? new Map<CatalogDataUse, CatalogModelOffering>();
    const previous = offerings.get(dataUse);
    if (previous === undefined || preferredWireModelId(previous.wireModelId, wireModelId) === wireModelId) {
      const resolvedMetadata = (byWire.get(canonicalize(wireModelId)) ?? byModel.get(canonicalModelId(wireModelId)))?.metadata;
      offerings.set(dataUse, Object.freeze({ wireModelId, metadata: null, dataUse, transport, ...(resolvedMetadata === undefined ? {} : { resolvedMetadata }) }));
    }
    result.set(modelId, offerings);
  }
  return new Map([...result].map(([modelId, offerings]) => [
    modelId,
    Object.freeze(STATIC_OFFERING_ORDER.flatMap((dataUse) => {
      const offering = offerings.get(dataUse);
      return offering === undefined ? [] : [offering];
    })),
  ]));
}

/** One row per key, chosen by wire preference rather than catalog order. */
function preferredRowsBy(catalog: readonly DescribedWire[], key: (wireModelId: string) => string): ReadonlyMap<string, DescribedWire> {
  const result = new Map<string, DescribedWire>();
  for (const row of catalog) {
    const previous = result.get(key(row.wireModelId));
    if (previous === undefined || preferredWireModelId(previous.wireModelId, row.wireModelId) === row.wireModelId) result.set(key(row.wireModelId), row);
  }
  return result;
}

type OfferingMap = ReadonlyMap<string, readonly CatalogModelOffering[]>;

/** One account's listing without the wire models the account refused and with each refused extended window narrowed
 *  to the window the account grants. A model leaves the listing only when every one of its offerings is refused. */
export function withModelRefusals<Listed extends { readonly models: OfferingMap | null; readonly visibleModels?: OfferingMap }>(listed: Listed, refusals: SavedModelRefusals): Listed {
  if (Object.keys(refusals).length === 0) return listed;
  const apply = (catalog: OfferingMap): OfferingMap => new Map([...catalog].flatMap(([modelId, offerings]) => {
    const kept = offerings.flatMap((offering) => {
      const refusal = refusals[offering.wireModelId];
      if (refusal === undefined) return [offering];
      if (refusal.kind === "model") return [];
      return [offering.resolvedMetadata === undefined ? offering : Object.freeze({ ...offering, resolvedMetadata: narrowContextWindow(offering.resolvedMetadata, refusal.contextLimit) })];
    });
    return kept.length === 0 ? [] : [[modelId, kept] as const];
  }));
  const models = listed.models === null ? null : apply(listed.models);
  const visibleModels = listed.visibleModels === listed.models ? models ?? undefined : listed.visibleModels === undefined ? undefined : apply(listed.visibleModels);
  return { ...listed, models, ...(visibleModels === undefined ? {} : { visibleModels }) };
}
