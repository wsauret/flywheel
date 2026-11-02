/**
 * models.dev combined-catalog client.
 *
 * The API returns one large document with provider rows and a provider-agnostic
 * model map. Each
 * client loads its current document from memory, an archive, or the bundled
 * snapshot without network I/O. Only an explicit refresh reaches the network:
 * it performs one coalesced, bounded request and publishes only an admitted
 * document, so every read serves the current document at once. The process
 * shares one client per account root via getSharedModelsClient
 * (orchestration/config). Every successful refresh is archived to disk under
 * that root (~/.flywheel/models/models.json).
 * With no archive the client serves the snapshot bundled into the binary
 * (models-bundled.txt, refreshed via
 * `bun run models:snapshot`), so a document is always available and only
 * models absent from it resolve to null.
 */

import * as fs from "node:fs";
import bundledModelsJson from "./models-bundled.txt";
import { writeFileAtomic } from "../atomic-write.js";
import { errorDetail, errorMessage } from "../error-message.js";
import { Log } from "../log.js";
import type { CustomProviderDefinition } from "./custom-provider-registry.js";
import {
  canonicalCatalogModelId,
  canonicalModelId,
  type CatalogDataUse,
  type ClaudeTokenizerIdentity,
  parseCanonicalModelGeneration,
} from "./model-id.js";
import { inferModelFamilyFromProvider } from "./model-family.js";
import { awaitWithAbortSignal } from "../abort.js";
import {
  admitModelsDocument,
  MAX_MODELS_DOCUMENT_BYTES,
  type AdmittedModelsDocument,
  type ModelsDevCatalogProvenance,
  type RawApi,
  type RawModel,
  type RawModelCost,
} from "./models-document.js";
import { runModelsDocumentJob } from "./models-document-job.js";
import {
  hasValidModelLimits,
  modelMapIndex,
  providerNamespaceIndex,
  resolveLegacyRelationship,
  resolveModelMapRelationship,
  type RelationshipModel,
} from "./model-relationships.js";

const log = Log.create({ service: "llm-models" });

const API_URL = "https://models.dev/catalog.json";
export const MAX_MODEL_OUTPUT_TOKENS = 2_000_000;

interface ModelCostTier {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly reasoning?: number;
}

export interface ModelCost extends ModelCostTier {
  readonly highContext?: ModelCostTier & { readonly threshold: number };
}

export interface NormalizedModelCostTier {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h: number;
  readonly reasoning: number;
}

export interface NormalizedModelRateCard {
  readonly standard: NormalizedModelCostTier;
  readonly highContext?: NormalizedModelCostTier;
}

export type ModelPricingProvenance =
  | { readonly source: "models.dev"; readonly catalog: ModelsDevCatalogProvenance; readonly provider: string; readonly model: string }
  | { readonly source: "provider-api" | "provider-docs"; readonly provider: string; readonly model: string };

export type ModelPricing =
  | { readonly status: "available"; readonly rateCard: ModelCost; readonly provenance: ModelPricingProvenance }
  | { readonly status: "unavailable"; readonly reason: "missing-rate-card" };

export const REASONING_EFFORTS = ["off", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

/** Canonical reasoning-effort vocabulary in ascending order: "off" disables
 *  thinking; the rest are ascending tiers. Provider adapters map from this to
 *  their wire unions. */
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export const PROVIDER_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type ProviderReasoningEffort = (typeof PROVIDER_REASONING_EFFORTS)[number];

export interface ModelInfo {
  readonly provider: string;
  readonly family: ReturnType<typeof inferModelFamilyFromProvider>;
  readonly id: string;
  readonly name: string;
  readonly modelFamily?: string;
  readonly releaseDate?: string;
  readonly knowledgeCutoff?: string;
  readonly lastUpdated?: string;
  readonly openWeights: boolean;
  readonly reasoning: boolean;
  /** Effort tiers declared via models.dev `reasoning_options` (type "effort"). */
  readonly reasoningEfforts?: readonly ProviderReasoningEffort[];
  /** Assistant-message field on which the model requires its reasoning
   *  returned on later requests, from models.dev `interleaved.field`. */
  readonly interleavedReasoningField?: string;
  readonly toolCall: boolean;
  readonly attachment: boolean;
  readonly temperature: boolean;
  /** Prompt/input token budget. Prefer models.dev `limit.input` when present;
   *  some providers report `limit.context` as input + max output. */
  readonly contextLimit: number;
  /** Combined prompt and output budget when models.dev explicitly declares
   *  `limit.context`. Absent for fallback and input-only catalog data. */
  readonly totalContextLimit?: number;
  readonly outputLimit: number;
  readonly cost: ModelCost;
  readonly pricing: ModelPricing;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  /** Fields established by the exact provider route. Absent on shared-catalog
   * metadata, where every field belongs to that source. */
  readonly providerFields?: readonly ProviderModelInfoField[];
  /** Fields a provider route took from the shared catalog under its metadata policy.
   * A route field in neither list holds a runtime default. Shared-catalog rows
   * list explicitly stated context capacities here to distinguish them from defaults. */
  readonly catalogFields?: readonly ProviderModelInfoField[];
}

export type ProviderModelInfoField =
  | "family" | "name" | "modelFamily" | "releaseDate" | "knowledgeCutoff" | "lastUpdated"
  | "openWeights" | "reasoning" | "reasoningEfforts" | "interleavedReasoningField" | "toolCall"
  | "attachment" | "temperature" | "contextLimit" | "totalContextLimit"
  | "outputLimit" | "pricing" | "modalities";

let admittedBundledModels: AdmittedModelsDocument | undefined;

function bundledModels(): AdmittedModelsDocument {
  admittedBundledModels ??= { ...admitModelsDocument(bundledModelsJson), provenance: "bundled" };
  return admittedBundledModels;
}

/** Reads one models.dev response without buffering beyond the admitted document limit. */
export async function readBoundedModelsResponse(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODELS_DOCUMENT_BYTES) {
    throw new Error("models.dev document exceeds 8 MiB");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("models.dev response body is missing");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_MODELS_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new Error("models.dev document exceeds 8 MiB");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface ModelsProviderCatalogRow {
  readonly providerId: string;
  readonly providerName: string;
  readonly wireModelId: string;
  readonly dataUse?: CatalogDataUse;
  readonly metadata: ModelInfo;
  readonly provenance: ModelsDevCatalogProvenance;
  /** Bare rows are provider-owned canonical identities. A null relationship is
   *  reserved for namespace-qualified routes that the admitted catalog cannot join. */
  readonly canonical: { readonly providerId: string; readonly modelId: string } | null;
  /** The Flywheel identity of models.dev's `canonical_model_id`: the dated snapshot this wire serves now. */
  readonly snapshotModelId?: string;
  readonly transport: { readonly npm: string } | null;
}

export interface ModelsClient {
  /** Refreshes models.dev metadata from the network. Concurrent refreshes share one bounded request; cancellation settles when the shared request no longer has an owner. Failed refreshes retain the current catalog. */
  refresh(signal: AbortSignal): Promise<void>;
  /** Resolves an embedded tokenizer only for canonical members of the Anthropic catalog. Provider
   *  request admission calls it, so it reads the current document (live, archived, or bundled) and
   *  never waits on the network. A model newer than that document resolves after an owned refresh
   *  publishes a document that lists it. */
  getTokenizerIdentity(modelId: string): ClaudeTokenizerIdentity | undefined;
  /** Returns immutable models.dev rows with exact wire IDs, metadata, transport, and namespace-qualified canonical relationships from the current document, without network I/O. */
  getProviderCatalog(providerIds: readonly string[], rowLimit: number): readonly ModelsProviderCatalogRow[];
}

/** Returns the configured metadata contract for a custom provider offering without borrowing another provider's row. */
export function customProviderModelInfo(owner: CustomProviderDefinition, modelId: string): ModelInfo {
  return {
    provider: owner.id,
    family: "openai",
    id: modelId,
    name: modelId,
    openWeights: false,
    reasoning: false,
    toolCall: true,
    attachment: false,
    temperature: true,
    contextLimit: owner.contextLimit,
    outputLimit: 32_768,
    cost: { input: 0, output: 0 },
    pricing: { status: "unavailable", reason: "missing-rate-card" },
    modalities: { input: ["text"], output: ["text"] },
  };
}

/** Serves cached metadata synchronously and coalesces explicit live refreshes.
 * Admission jobs must join their resources before settling. Failed refreshes
 * retain current metadata; withdrawal of the final waiter prevents publication. */
export function createModelsClient(
  snapshotFile: string,
  admitLive: (bytes: Uint8Array, signal: AbortSignal) => Promise<AdmittedModelsDocument> = runModelsDocumentJob,
): ModelsClient {
  let inMemory: AdmittedModelsDocument | null = null;
  let inFlight: {
    readonly controller: AbortController;
    promise: Promise<void>;
    waiters: number;
    settled: boolean;
  } | null = null;
  let documentIndexes = new WeakMap<AdmittedModelsDocument, {
    readonly providerNamespaces: ReadonlyMap<string, string>;
    readonly exactRelationships: Map<string, ReadonlyMap<string, RelationshipModel>>;
    readonly modelMap: ReadonlyMap<string, RelationshipModel>;
    readonly providerCatalogs: Map<string, {
      readonly rawRows: Iterator<RawModel>;
      exhausted: boolean;
      readonly rows: ModelsProviderCatalogRow[];
    }>;
  }>();

  async function fetchFresh(signal: AbortSignal): Promise<AdmittedModelsDocument | null> {
    try {
      const res = await fetch(API_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      });
      if (!res.ok) return null;
      const bytes = await readBoundedModelsResponse(res);
      const fresh = await admitLive(bytes, signal);
      signal.throwIfAborted();
      saveSnapshot(bytes);
      return fresh;
    } catch (err) {
      if (signal.aborted) throw signal.reason;
      log.warn("Failed to fetch models from models.dev API", { error: errorMessage(err), errorDetail: errorDetail(err) });
      return null;
    }
  }

  function saveSnapshot(bytes: Uint8Array): void {
    try {
      writeFileAtomic(snapshotFile, bytes, { durableDirectorySync: true });
    } catch (err) {
      log.warn("Failed to archive models.dev snapshot", { file: snapshotFile, error: errorMessage(err) });
    }
  }

  function loadSnapshot(): AdmittedModelsDocument | null {
    let bytes: Uint8Array;
    try {
      if (fs.statSync(snapshotFile).size > MAX_MODELS_DOCUMENT_BYTES) throw new Error("archive exceeds 8 MiB");
      bytes = fs.readFileSync(snapshotFile);
    } catch (err) {
      if (!fs.existsSync(snapshotFile)) return null;
      log.warn("models.dev snapshot cannot be read; ignoring it", { file: snapshotFile, error: errorMessage(err) });
      return null;
    }
    try {
      const snapshot = { ...admitModelsDocument(bytes), provenance: "last-known-good" as const };
      return snapshot;
    } catch (err) {
      log.warn("models.dev snapshot failed admission; ignoring it", { file: snapshotFile, error: errorMessage(err) });
      return null;
    }
  }

  function loadArchived(): AdmittedModelsDocument | null {
    if (inMemory === null) inMemory = loadSnapshot();
    return inMemory;
  }

  function loadCurrent(): AdmittedModelsDocument {
    return loadArchived() ?? bundledModels();
  }

  async function refresh(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!inFlight) {
      const controller = new AbortController();
      const operation = {
        controller,
        waiters: 0,
        settled: false,
        promise: Promise.resolve(),
      };
      operation.promise = (async () => {
        const fresh = await fetchFresh(controller.signal);
        controller.signal.throwIfAborted();
        if (fresh) {
          inMemory = fresh;
          documentIndexes = new WeakMap();
        }
      })().finally(() => {
        operation.settled = true;
        if (inFlight === operation) inFlight = null;
      });
      inFlight = operation;
    }
    const operation = inFlight;
    operation.waiters += 1;
    try {
      await awaitWithAbortSignal(operation.promise, signal);
    } finally {
      operation.waiters -= 1;
      if (operation.waiters === 0 && !operation.settled) {
        operation.controller.abort(signal.aborted ? signal.reason : new DOMException("Models refresh has no owner", "AbortError"));
        await Promise.allSettled([operation.promise]);
      }
    }
  }

  function normalizeCost(rawCost: RawModelCost | undefined): ModelCost {
    const base: ModelCost = {
      input: rawCost?.input ?? 0,
      output: rawCost?.output ?? 0,
      cacheRead: rawCost?.cache_read,
      cacheWrite: rawCost?.cache_write,
      reasoning: rawCost?.reasoning,
    };
    if (!rawCost?.context_over_200k) return base;
    return Object.freeze({
      ...base,
      highContext: {
        threshold: 200_000,
        input: rawCost.context_over_200k.input ?? base.input,
        output: rawCost.context_over_200k.output ?? base.output,
        cacheRead: rawCost.context_over_200k.cache_read ?? base.cacheRead,
        cacheWrite: rawCost.context_over_200k.cache_write ?? base.cacheWrite,
        reasoning: rawCost.context_over_200k.reasoning ?? base.reasoning,
      },
    });
  }

  function normalizeReasoningEfforts(raw: RawModel): readonly ProviderReasoningEffort[] | undefined {
    const values = raw.reasoning_options?.find((option) => option.type === "effort")?.values;
    if (!values) return undefined;
    const efforts = values.flatMap((value) => {
      const effort = PROVIDER_REASONING_EFFORTS.find((tier) => tier === value);
      return effort ? [effort] : [];
    });
    return efforts.length > 0 ? efforts : undefined;
  }

  function normalize(provider: string, raw: RawModel, catalog: ModelsDevCatalogProvenance): ModelInfo {
    const reasoningEfforts = normalizeReasoningEfforts(raw);
    const interleaved = raw.interleaved;
    const interleavedReasoningField = typeof interleaved === "object" && interleaved !== null && "field" in interleaved && typeof interleaved.field === "string"
      ? interleaved.field
      : undefined;
    const cost = normalizeCost(raw.cost);
    const pricing: ModelPricing = raw.cost?.input === undefined || raw.cost.output === undefined
      ? Object.freeze({ status: "unavailable", reason: "missing-rate-card" })
      : Object.freeze({
          status: "available",
          rateCard: Object.freeze({
            ...cost,
            ...(cost.highContext ? { highContext: Object.freeze({ ...cost.highContext }) } : {}),
          }),
          provenance: Object.freeze({ source: "models.dev", catalog, provider, model: raw.id }),
        });
    return Object.freeze({
      provider,
      family: inferModelFamilyFromProvider(provider),
      id: raw.id,
      name: raw.name ?? raw.id,
      modelFamily: raw.family,
      releaseDate: raw.release_date,
      knowledgeCutoff: raw.knowledge,
      lastUpdated: raw.last_updated,
      openWeights: raw.open_weights ?? false,
      reasoning: raw.reasoning ?? false,
      ...(reasoningEfforts ? { reasoningEfforts: Object.freeze(reasoningEfforts) } : {}),
      ...(interleavedReasoningField ? { interleavedReasoningField } : {}),
      toolCall: raw.tool_call ?? false,
      attachment: raw.attachment ?? false,
      temperature: raw.temperature ?? true,
      contextLimit: raw.limit?.input ?? raw.limit?.context ?? 200_000,
      ...(raw.limit?.context === undefined ? {} : { totalContextLimit: raw.limit.context }),
      catalogFields: Object.freeze([
        ...(raw.limit?.input === undefined && raw.limit?.context === undefined ? [] : ["contextLimit" as const]),
        ...(raw.limit?.context === undefined ? [] : ["totalContextLimit" as const]),
      ]),
      outputLimit: Math.min(raw.limit?.output ?? 4_096, MAX_MODEL_OUTPUT_TOKENS),
      cost: Object.freeze({
        ...cost,
        ...(cost.highContext ? { highContext: Object.freeze({ ...cost.highContext }) } : {}),
      }),
      pricing,
      modalities: Object.freeze({
        input: Object.freeze([...(raw.modalities?.input ?? ["text"])]),
        output: Object.freeze([...(raw.modalities?.output ?? ["text"])]),
      }),
    });
  }

  function buildProviderCatalog(admitted: AdmittedModelsDocument, providerKey: string, rowLimit: number): readonly ModelsProviderCatalogRow[] {
    let indexes = documentIndexes.get(admitted);
    if (!indexes) {
      indexes = {
        providerNamespaces: admitted.relationshipAuthority === "legacy-provider-scan"
          ? providerNamespaceIndex(admitted.document)
          : new Map(),
        exactRelationships: new Map(),
        modelMap: modelMapIndex(admitted.modelMap),
        providerCatalogs: new Map(),
      };
      documentIndexes.set(admitted, indexes);
    }
    const { document, provenance } = admitted;
    const provider = document[providerKey];
    if (!provider) {
      const empty = Object.freeze([]);
      return empty;
    }
    let cached = indexes.providerCatalogs.get(providerKey);
    if (!cached) {
      cached = { rawRows: validModels(provider.models), exhausted: false, rows: [] };
      indexes.providerCatalogs.set(providerKey, cached);
    }
    const decisionBoundary = rowLimit + 1;
    while (!cached.exhausted && cached.rows.length < decisionBoundary) {
      const next = cached.rawRows.next();
      if (next.done) {
        cached.exhausted = true;
        break;
      }
      const raw = next.value;
        const sourceIdentity = canonicalCatalogModelId(raw.id);
        let dataUse = sourceIdentity.dataUse;
        const canonical = admitted.relationshipAuthority === "model-map"
          ? resolveModelMapRelationship(indexes.modelMap, provider.id ?? providerKey, raw.id)
          : resolveLegacyRelationship(
              document,
              indexes.providerNamespaces,
              indexes.exactRelationships,
              provider.id ?? providerKey,
              raw.id,
              sourceIdentity.modelId,
            );
        if (canonical !== null) dataUse = sourceIdentity.dataUse;
        const npm = raw.provider?.npm ?? provider.npm;
        cached.rows.push(Object.freeze({
          providerId: provider.id ?? providerKey,
          providerName: provider.name,
          wireModelId: raw.id,
          dataUse,
          metadata: Object.freeze(normalize(providerKey, raw, provenance)),
          provenance,
          canonical,
          // models.dev qualifies every canonical_model_id with its owner namespace.
          ...(raw.canonical_model_id === undefined ? {} : {
            snapshotModelId: canonicalCatalogModelId(raw.canonical_model_id.slice(raw.canonical_model_id.indexOf("/") + 1)).modelId,
          }),
          transport: npm ? Object.freeze({ npm }) : null,
        }));
    }
    return Object.freeze(cached.rows.slice(0, decisionBoundary));
  }

  return {
    refresh,
    getTokenizerIdentity(modelId: string): ClaudeTokenizerIdentity | undefined {
      const { document } = loadCurrent();
      const canonical = canonicalModelId(modelId);
      const raw = Object.values(document.anthropic?.models ?? {}).find((candidate) => canonicalModelId(candidate.id) === canonical);
      if (!raw?.family) return undefined;
      const family = canonicalModelId(raw.family);
      const generation = parseCanonicalModelGeneration(canonical, family);
      if (!generation) return undefined;
      if (generation.major === 3) return "ClaudeV3";
      if (generation.major === 4) {
        return family === "claude-opus" && generation.minor >= 7 ? "ClaudeV47" : "ClaudeV3";
      }
      if (generation.major !== 5) return undefined;
      return family === "claude-opus" ? "ClaudeV5" : "ClaudeV5Sonnet";
    },
    getProviderCatalog(providerIds: readonly string[], rowLimit: number): readonly ModelsProviderCatalogRow[] {
      if (!Number.isSafeInteger(rowLimit) || rowLimit <= 0) throw new RangeError("models.dev row limit must be a positive integer");
      const admitted = loadCurrent();
      const rows: ModelsProviderCatalogRow[] = [];
      for (const providerId of providerIds) {
        const remaining = rowLimit - rows.length;
        const providerRows = buildProviderCatalog(admitted, providerId, remaining);
        for (const row of providerRows) {
          rows.push(row);
          if (rows.length > rowLimit) return Object.freeze(rows);
        }
      }
      return Object.freeze(rows);
    },
  };

}

function* validModels(models: RawApi[string]["models"]): Generator<RawModel> {
  for (const key in models) {
    if (!Object.hasOwn(models, key)) continue;
    const model = models[key];
    if (model !== undefined && hasValidModelLimits(model)) yield model;
  }
}

