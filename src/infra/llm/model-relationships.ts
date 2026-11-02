import { canonicalCatalogModelId, canonicalModelId } from "./model-id.js";

export interface RelationshipModel {
  readonly id: string;
  readonly limit?: {
    readonly context?: number;
    readonly input?: number;
    readonly output?: number;
  };
}

export interface RelationshipProvider {
  readonly id?: string;
  readonly models: { readonly [modelId: string]: RelationshipModel };
}

export interface CanonicalModelRelationship {
  readonly providerId: string;
  readonly modelId: string;
}

/** Treats bare wires as provider-owned identities and resolves qualified wires only from exact combined model-map evidence. */
export function resolveModelMapRelationship(
  modelMap: ReadonlyMap<string, RelationshipModel>,
  providerId: string,
  wireModelId: string,
): CanonicalModelRelationship | null {
  const relationshipIdentity = exactCatalogRelationshipIdentity(wireModelId);
  if (!relationshipIdentity.includes("/")) {
    if (relationshipIdentity.startsWith("~")) return null;
    return Object.freeze({
      providerId,
      modelId: canonicalCatalogModelId(relationshipIdentity).modelId,
    });
  }
  const relationshipId = relationshipIdentity;
  if (!modelMap.has(relationshipId)) return null;
  const separator = relationshipId.indexOf("/");
  if (separator <= 0 || separator === relationshipId.length - 1) return null;
  return Object.freeze({
    providerId: relationshipId.slice(0, separator),
    modelId: canonicalCatalogModelId(relationshipId.slice(separator + 1)).modelId,
  });
}

/** Preserves provider-catalog scanning only for provider-only legacy documents. */
export function resolveLegacyRelationship(
  document: { readonly [providerId: string]: RelationshipProvider },
  providerNamespaces: ReadonlyMap<string, string>,
  exactRelationships: Map<string, ReadonlyMap<string, RelationshipModel>>,
  providerId: string,
  wireModelId: string,
  canonicalWireModelId: string,
): CanonicalModelRelationship | null {
  const separator = wireModelId.indexOf("/");
  if (separator === -1) return Object.freeze({ providerId, modelId: canonicalWireModelId });
  if (separator <= 0 || separator === wireModelId.length - 1) return null;
  const namespace = wireModelId.slice(0, separator);
  const modelId = wireModelId.slice(separator + 1);
  const canonicalProviderKey = providerNamespaces.get(relaxedCatalogKey(namespace));
  const canonicalProvider = canonicalProviderKey ? document[canonicalProviderKey] : undefined;
  const canonicalModel = canonicalProviderKey && canonicalProvider
    ? resolveExactRelationship(exactRelationships, canonicalProviderKey, canonicalProvider.models, modelId)
    : undefined;
  if (!canonicalProviderKey || !canonicalProvider || !canonicalModel) return null;
  return Object.freeze({
    providerId: canonicalProvider.id ?? canonicalProviderKey,
    modelId: canonicalCatalogModelId(canonicalModel.id).modelId,
  });
}

export function providerNamespaceIndex(
  document: { readonly [providerId: string]: RelationshipProvider },
): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const key in document) {
    if (!Object.hasOwn(document, key)) continue;
    const provider = document[key];
    if (provider === undefined) continue;
    for (const candidate of [key, provider.id ?? key]) {
      const relaxed = relaxedCatalogKey(candidate);
      if (!index.has(relaxed)) index.set(relaxed, key);
    }
  }
  return index;
}

export function modelMapIndex(
  modelMap: { readonly [identity: string]: RelationshipModel } | null,
): ReadonlyMap<string, RelationshipModel> {
  if (modelMap === null) return new Map();
  const index = new Map<string, RelationshipModel>();
  for (const key in modelMap) {
    if (!Object.hasOwn(modelMap, key)) continue;
    const model = modelMap[key];
    if (model !== undefined && hasValidModelLimits(model) && model.id === key) index.set(key, model);
  }
  return index;
}

export function hasValidModelLimits(raw: RelationshipModel): boolean {
  return [raw.limit?.context, raw.limit?.input, raw.limit?.output].every(
    (value) => value === undefined || (Number.isSafeInteger(value) && value > 0),
  );
}

function resolveExactRelationship(
  cache: Map<string, ReadonlyMap<string, RelationshipModel>>,
  providerKey: string,
  models: RelationshipProvider["models"],
  modelId: string,
): RelationshipModel | undefined {
  const canonical = canonicalModelId(modelId);
  let relationships = cache.get(providerKey);
  if (relationships === undefined) {
    const indexed = new Map<string, RelationshipModel>();
    for (const model of validRelationshipModels(models)) {
      const identity = canonicalModelId(model.id);
      if (!indexed.has(identity)) indexed.set(identity, model);
    }
    relationships = indexed;
    cache.set(providerKey, relationships);
  }
  return relationships.get(canonical);
}

function* validRelationshipModels(models: RelationshipProvider["models"]): Generator<RelationshipModel> {
  for (const key in models) {
    if (!Object.hasOwn(models, key)) continue;
    const model = models[key];
    if (model !== undefined && hasValidModelLimits(model)) yield model;
  }
}

function exactCatalogRelationshipIdentity(wireModelId: string): string {
  const contributorMarker = "-contributor";
  return wireModelId.endsWith(contributorMarker)
    ? wireModelId.slice(0, -contributorMarker.length)
    : wireModelId;
}

function relaxedCatalogKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, "");
}
