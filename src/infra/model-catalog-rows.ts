// The canonical row shape of a provider model catalog, its limits, and its
// validation. Both the saved-catalog store in auth and catalog resolution in
// llm read rows through this one codec.
import type { ModelInfo } from "./llm/models/models.js";
import type { CatalogJsonValue, CatalogModelOffering, OfferingTransport } from "./catalog-model-offering.js";

export interface CatalogCanonicalRow {
  readonly modelId: string;
  readonly offerings: readonly CatalogModelOffering[];
}

/** Returns the chat transport declared by models.dev npm metadata. The xAI package sends the Responses API by default,
 *  which is the wire that the xAI subscription speaks. */
export function offeringTransport(metadata: unknown): OfferingTransport | undefined {
  if (!isObject(metadata)) return undefined;
  const transport = metadata.transport;
  if (!isObject(transport) || typeof transport.npm !== "string") return undefined;
  if (transport.npm === "@ai-sdk/anthropic") return "anthropic-messages";
  if (transport.npm === "@ai-sdk/openai" || transport.npm === "@ai-sdk/xai") return "openai-responses";
  if (transport.npm === "@ai-sdk/google" || transport.npm === "@ai-sdk/google-vertex") return "google";
  if (
    transport.npm === "@ai-sdk/openai-compatible"
    || transport.npm === "@openrouter/ai-sdk-provider"
  ) return "chat-completions";
  return undefined;
}

function isOfferingTransport(value: unknown): value is OfferingTransport {
  return value === "anthropic-messages" || value === "openai-responses" || value === "chat-completions" || value === "google";
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

export type NormalizedCatalog =
  | { readonly kind: "valid"; readonly rows: readonly CatalogCanonicalRow[] }
  | { readonly kind: "rejected"; readonly reason: "too-many-rows" | "duplicate-model" | "model-id-too-long" | "invalid-canonical-row" };

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
    || (value.family !== "anthropic" && value.family !== "openai" && value.family !== "chat-completions" && value.family !== "google")
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

export function normalizeCatalogMetadata(value: unknown, limits: CatalogLimits): { readonly value: CatalogJsonValue } | undefined {
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

export function requireCatalogLimits(limits: CatalogLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Catalog limit ${name} must be a positive safe integer`);
  }
}

function isPlainObject(value: UnknownObject): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function isCatalogJsonValue(value: unknown): value is CatalogJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isCatalogJsonValue);
  return isObject(value) && isPlainObject(value) && Object.values(value).every(isCatalogJsonValue);
}

function hasOnlyKeys(value: UnknownObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

interface UnknownObject { readonly [key: string]: unknown }

function isObject(value: unknown): value is UnknownObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
