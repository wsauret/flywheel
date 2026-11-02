import type { ModelTier } from "../../protocol/model-assignment-protocol-types.js";
import type { ModelFamily } from "../../infra/llm/model-family.js";
import type { ModelInfo } from "../../infra/llm/models.js";
import { callsToolsOnText } from "../../infra/llm/provider-model-info.js";
import { Log } from "../../infra/log.js";
import { modelTierForReference } from "../../protocol/model-tier-reference.js";
import { clearSharedModelListingClients } from "./llm-clients.js";
import { normalizeSelectableModelId } from "./model-compatibility.js";

type RankedModelTier = Exclude<ModelTier, "default">;

interface ModelPowerSortRank {
  tier: number;
  index: number;
  releaseMs: number;
  cost?: {
    input: number;
    output: number;
    cacheRead?: number;
  };
}

interface ResolvedTierModel {
  family: ModelFamily;
  model: string;
}

const operationFamilyCatalogCache = Symbol("operationFamilyCatalogCache");

export interface TierResolutionOptions {
  readonly userDataRoot: string;
  readonly modelInfos?: Pick<ReadonlyMap<string, ModelInfo>, "get">;
  readonly [operationFamilyCatalogCache]?: Map<string, Promise<FamilyTierCatalog>>;
}

interface CatalogEntry {
  model: string;
  info: ModelInfo;
  tier: RankedModelTier;
  releaseMs: number;
}

interface TierModels {
  powerful: string[];
  mid: string[];
  cheap: string[];
}

interface ReadonlyTierModels {
  readonly powerful: readonly string[];
  readonly mid: readonly string[];
  readonly cheap: readonly string[];
}

interface TierResolutionOrder {
  readonly default: readonly RankedModelTier[];
  readonly powerful: readonly RankedModelTier[];
  readonly mid: readonly RankedModelTier[];
  readonly cheap: readonly RankedModelTier[];
}

interface FamilyTierCatalog {
  tiers: ReadonlyTierModels;
  unranked: readonly string[];
  sortRanks: ReadonlyMap<string, ModelPowerSortRank>;
}

const MODEL_TIER_ORDER: readonly RankedModelTier[] = ["powerful", "mid", "cheap"];
const MODEL_FAMILY_ORDER: readonly ModelFamily[] = ["anthropic", "openai", "google"];
const CHEAP_INPUT_COST_THRESHOLD = 1;
const POWERFUL_INPUT_COST_THRESHOLD = 4;


const TIER_RESOLUTION_ORDER: TierResolutionOrder = {
  default: ["powerful", "mid", "cheap"],
  powerful: ["powerful", "mid", "cheap"],
  mid: ["mid", "cheap", "powerful"],
  cheap: ["cheap", "mid", "powerful"],
};


const log = Log.create({ service: "model-tier-resolution" });

/** Invalidates credential-bound listing generations while retaining process-owned public metadata. */
export function clearTierCache(authDirectory?: string): void {
  clearSharedModelListingClients(authDirectory);
}

/** Starts one role-resolution operation whose family catalog builds are shared
 * across every role in that operation. Process-wide caching remains unchanged. */
export function beginTierResolutionOperation(options: TierResolutionOptions): TierResolutionOptions {
  return { ...options, [operationFamilyCatalogCache]: new Map() };
}

export async function resolveModelTier(
  raw: string | undefined,
  family: ModelFamily,
  availableModels: ReadonlySet<string> | undefined,
  options: TierResolutionOptions,
): Promise<string> {
  const tier = modelTierForReference(raw);
  if (tier) {
    const resolved = await resolveModelForTier(tier, family, availableModels, options);
    log.debug("tier resolved", { raw, tier, family, resolved });
    return resolved;
  }
  if (raw === undefined) throw new Error("No model was configured.");
  return raw;
}

export async function resolveModelForTier(
  tier: ModelTier,
  family: ModelFamily,
  availableModels: ReadonlySet<string> | undefined,
  options: TierResolutionOptions,
): Promise<string> {
  const catalog = await catalogForFamily(family, availableModels, options);
  for (const candidateTier of TIER_RESOLUTION_ORDER[tier]) {
    const model = catalog.tiers[candidateTier][0];
    if (model) return model;
  }
  const unranked = catalog.unranked[0];
  if (unranked) return unranked;
  throw new Error(`No assignable ${family} models were returned by provider listing.`);
}

export async function resolveModelForTierAcrossFamilies(
  tier: ModelTier,
  availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>> | undefined,
  options: TierResolutionOptions,
): Promise<ResolvedTierModel> {
  if (!availableModels || availableModels.size === 0) {
    throw new Error("Tier resolution requires provider listing.");
  }
  const families = MODEL_FAMILY_ORDER.filter((family) => (availableModels.get(family)?.size ?? 0) > 0);
  for (const candidateTier of TIER_RESOLUTION_ORDER[tier]) {
    const candidates: Array<ResolvedTierModel & { rank: ModelPowerSortRank }> = [];
    for (const family of families) {
      const catalog = await catalogForFamily(family, availableModels.get(family), options);
      const model = catalog.tiers[candidateTier][0];
      const rank = model ? catalog.sortRanks.get(normalizeSelectableModelId(model)) : undefined;
      if (model && rank) candidates.push({ family, model, rank });
    }
    const best = candidates.sort(compareTierCandidates)[0];
    if (best) return { family: best.family, model: best.model };
  }
  const unranked = (await Promise.all(families.map(async (family) => ({
    family,
    catalog: await catalogForFamily(family, availableModels.get(family), options),
  })))).flatMap(({ family, catalog }) => catalog.unranked.map((model) => ({
    family, model, releaseMs: catalog.sortRanks.get(model)?.releaseMs ?? 0,
  }))).sort((a, b) => b.releaseMs - a.releaseMs || a.model.localeCompare(b.model));
  const bestUnranked = unranked[0];
  if (bestUnranked) return { family: bestUnranked.family, model: bestUnranked.model };
  throw new Error("No assignable models were returned by provider listing.");
}

export async function recommendedModelsForFamily(
  family: ModelFamily,
  availableModels: ReadonlySet<string> | undefined,
  options: TierResolutionOptions,
): Promise<readonly string[]> {
  if (!availableModels || availableModels.size === 0) return [];
  const catalog = await catalogForFamily(family, availableModels, options);
  const seen = new Set<string>();
  const models: string[] = [];
  for (const tier of MODEL_TIER_ORDER) {
    for (const model of catalog.tiers[tier]) {
      if (seen.has(model)) continue;
      seen.add(model);
      models.push(model);
    }
  }
  models.push(...catalog.unranked.filter((model) => !seen.has(model)));
  return models;
}

export async function modelPowerSortRank(
  family: ModelFamily,
  model: string,
  availableModels: ReadonlySet<string> | undefined,
  options: TierResolutionOptions,
): Promise<ModelPowerSortRank | undefined> {
  if (!availableModels || availableModels.size === 0) return undefined;
  const catalog = await catalogForFamily(family, availableModels, options);
  return catalog.sortRanks.get(normalizeSelectableModelId(model));
}

export interface SelectedRouteRankRequest {
  readonly key: string;
  readonly wireModelId: string;
  readonly providerHint: string;
  readonly metadata?: ModelInfo;
}

/** Resolves exact route metadata from the immutable offering snapshot. */
export async function resolveSelectedRouteRanks(
  requests: readonly SelectedRouteRankRequest[],
  _options: TierResolutionOptions,
): Promise<ReadonlyMap<string, ModelPowerSortRank>> {
  return new Map(requests.flatMap((request) => {
    const info = request.metadata;
    return !info || !callsToolsOnText(info) ? [] : [[request.key, routeRank(info)] as const];
  }));
}

function routeRank(info: ModelInfo): ModelPowerSortRank {
  if (info.pricing.status === "unavailable") {
    return { tier: -1, index: 0, releaseMs: releaseTime(info), cost: undefined };
  }
  return {
    tier: MODEL_TIER_ORDER.indexOf(tierForInputCost(info.cost.input)),
    index: 0,
    releaseMs: releaseTime(info),
    cost: {
      input: info.cost.input,
      output: info.cost.output,
      ...(info.cost.cacheRead === undefined ? {} : { cacheRead: info.cost.cacheRead }),
    },
  };
}

async function catalogForFamily(
  family: ModelFamily,
  availableModels: ReadonlySet<string> | undefined,
  options: TierResolutionOptions,
): Promise<FamilyTierCatalog> {
  if (!availableModels || availableModels.size === 0) {
    throw new Error(`Tier resolution requires provider listing for ${family} models.`);
  }

  const key = `${family}\0${Array.from(availableModels).map(normalizeSelectableModelId).sort().join("\0")}`;
  const operationCache = options[operationFamilyCatalogCache];
  const operationCached = operationCache?.get(key);
  if (operationCached) return operationCached;

  const promise = buildFamilyCatalog(family, availableModels, options);
  operationCache?.set(key, promise);
  return promise;
}

async function buildFamilyCatalog(
  family: ModelFamily,
  availableModels: ReadonlySet<string>,
  options: TierResolutionOptions,
): Promise<FamilyTierCatalog> {
  const available = new Set(Array.from(availableModels).map(normalizeSelectableModelId));
  const partialEntries: Omit<CatalogEntry, "tier">[] = [];
  // Only a user-authored custom provider model is eligible without metadata.
  // It carries no tier evidence, so it is the last resort after ranked models.
  const undescribed: string[] = [];

  for (const model of available) {
    const info = resolveModelInfo(model, options.modelInfos);
    if (!info) {
      undescribed.push(model);
      continue;
    }
    if (!callsToolsOnText(info)) continue;
    partialEntries.push({
      model,
      info,
      releaseMs: releaseTime(info),
    });
  }

  const entries = partialEntries.filter((entry) => entry.info.pricing.status === "available").map((entry): CatalogEntry => ({
    ...entry,
    tier: tierForInputCost(entry.info.cost.input),
  }));

  const powerful: CatalogEntry[] = [];
  const mid: CatalogEntry[] = [];
  const cheap: CatalogEntry[] = [];
  const tierEntries = { powerful, mid, cheap };
  for (const entry of entries.sort(compareCatalogEntries)) {
    tierEntries[entry.tier].push(entry);
  }

  const tiers: TierModels = { powerful: [], mid: [], cheap: [] };
  const sortRanks = new Map<string, ModelPowerSortRank>();
  for (const [tierIndex, tier] of MODEL_TIER_ORDER.entries()) {
    for (const [index, entry] of tierEntries[tier].entries()) {
      tiers[tier].push(entry.model);
      sortRanks.set(normalizeSelectableModelId(entry.model), {
        tier: tierIndex,
        index,
        releaseMs: entry.releaseMs,
        cost: {
          input: entry.info.cost.input,
          output: entry.info.cost.output,
          ...(entry.info.cost.cacheRead === undefined ? {} : { cacheRead: entry.info.cost.cacheRead }),
        },
      });
    }
  }
  const unranked = partialEntries
    .filter((entry) => entry.info.pricing.status === "unavailable")
    .map((entry) => {
      sortRanks.set(normalizeSelectableModelId(entry.model), routeRank(entry.info));
      return entry.model;
    });
  return {
    tiers,
    unranked: [...unranked, ...undescribed].sort((a, b) =>
      (sortRanks.get(b)?.releaseMs ?? 0) - (sortRanks.get(a)?.releaseMs ?? 0) || a.localeCompare(b)),
    sortRanks,
  };
}

function resolveModelInfo(model: string, modelInfos: TierResolutionOptions["modelInfos"]): ModelInfo | null {
  return modelInfos?.get(normalizeSelectableModelId(model)) ?? null;
}

function tierForInputCost(inputCost: number): RankedModelTier {
  if (inputCost <= CHEAP_INPUT_COST_THRESHOLD) return "cheap";
  if (inputCost < POWERFUL_INPUT_COST_THRESHOLD) return "mid";
  return "powerful";
}

function compareCatalogEntries(a: CatalogEntry, b: CatalogEntry): number {
  return (
    b.releaseMs - a.releaseMs ||
    a.info.cost.input - b.info.cost.input ||
    a.model.localeCompare(b.model)
  );
}

function compareTierCandidates(
  a: ResolvedTierModel & { rank: ModelPowerSortRank },
  b: ResolvedTierModel & { rank: ModelPowerSortRank },
): number {
  return (
    b.rank.releaseMs - a.rank.releaseMs ||
    MODEL_FAMILY_ORDER.indexOf(a.family) - MODEL_FAMILY_ORDER.indexOf(b.family) ||
    (a.rank.cost?.input ?? Number.POSITIVE_INFINITY) - (b.rank.cost?.input ?? Number.POSITIVE_INFINITY) ||
    a.model.localeCompare(b.model)
  );
}

function releaseTime(info: ModelInfo): number {
  const raw = info.releaseDate ?? info.lastUpdated;
  if (!raw) return 0;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}

export type { ModelPowerSortRank };
