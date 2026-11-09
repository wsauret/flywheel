/** The access audit of one audited account: which models.dev rows wait for a probe, the probe pass, and the catalog that its results admit. */
import { readSavedProviderModels, recordProviderModelAccess, writeProviderModelCandidates, type CatalogProfile, type ProviderModelAccessSnapshot, type SavedProviderModels } from "../auth/provider-model-catalog-store.js";
import type { AccessProviderAccessOutcome, AccessProviderAccessProbeInput, AccessProviderAccountIdentity, AccessProviderCatalogFetchInput } from "./access-provider.js";
import { enrichCatalogRows, resolveModelCatalog, type CatalogCanonicalRow, type CatalogLimits, type ModelCatalogContribution, type OfferingTransport, type ResolvedModelCatalog } from "./model-catalog-resolution.js";
import { catalogRowsToModelMap, type JoinedCatalogRows, type SharedModelsDevBaseline } from "./model-listing-rows.js";
import type { AccessAuditProgressListener, AccessProviderCandidateModels } from "./model-listing.js";
import { isMovingModelAlias } from "./model-id.js";
import { isListableRoute } from "./provider-model-info.js";

type SavedAudit = NonNullable<SavedProviderModels["audit"]>;
/** Opens the profile for one read or write and closes it after. */
type WithProfile = <T>(use: (profile: CatalogProfile) => T | Promise<T>) => Promise<T>;

/** The usable, stable-id models.dev rows that an audited account lists, less the models its own listing names.
 *  Models compare by canonical identity, because a listed alias names the model that models.dev keys.
 *  The SuperGrok factory selects Responses independently of this catalog metadata. */
export function accessCandidateRows(baselineRows: readonly CatalogCanonicalRow[], listedRows: readonly CatalogCanonicalRow[]): readonly CatalogCanonicalRow[] {
  const named = new Set(listedRows.map((row) => row.modelId));
  return baselineRows.flatMap((row) => {
    if (named.has(row.modelId)) return [];
    const offerings = row.offerings
      .filter((offering) => isListableRoute(offering) && !isMovingModelAlias(offering.wireModelId));
    return offerings.length === 0 ? [] : [{ modelId: row.modelId, offerings }];
  });
}

export async function readSavedAudit(withProfile: WithProfile, account: AccessProviderAccountIdentity, lineage: string, limits: CatalogLimits): Promise<SavedAudit | undefined> {
  return withProfile(({ access }) => readSavedProviderModels(access, account, lineage, limits)?.audit);
}

/** One `audit` pass over one account whose credential is current. */
interface AccessAuditPass {
  readonly probe: (input: AccessProviderAccessProbeInput) => Promise<AccessProviderAccessOutcome>;
  /** What every probe of the account sends besides the model. Its signal ends the pass. */
  readonly probeInput: AccessProviderCatalogFetchInput;
  readonly account: AccessProviderAccountIdentity;
  readonly lineage: string;
  readonly limits: CatalogLimits;
  readonly inconclusiveEndsPass: boolean;
  readonly withProfile: WithProfile;
  readonly onAccessAudit: AccessAuditProgressListener | undefined;
  readonly audit: SavedAudit | undefined;
  /** The rows the account's entry saves, which a manual recheck saves again. */
  readonly entryRows: readonly CatalogCanonicalRow[];
  readonly candidates: readonly CatalogCanonicalRow[];
  /** A manual recheck probes every current candidate again. */
  readonly manual: boolean;
}

/** Probes the models that the saved audit leaves due, and returns the audit that the pass leaves. Each conclusive
 *  result commits before the next probe, so an interrupted pass resumes with the remainder. A pass ended by its
 *  signal returns what it committed; the caller decides whether the abort is an error. */
export async function runAccessAudit(pass: AccessAuditPass): Promise<SavedAudit | undefined> {
  const { account, lineage, limits, withProfile, candidates, probeInput: { signal } } = pass;
  let current = pass.audit;
  if (pass.manual) {
    // A manual recheck makes every current candidate due again but keeps saved outcomes until a conclusive probe replaces them. The store refuses a stale credential lineage under the profile lock, and then nothing is probed.
    const armed = pass.entryRows.length > 0
      && await withProfile((profile) => writeProviderModelCandidates(profile, account, lineage, pass.entryRows, candidates.map((row) => row.modelId), limits, true));
    if (!armed) return pass.audit;
    current = await readSavedAudit(withProfile, account, lineage, limits);
  }
  if (current === undefined) return undefined;
  for (const modelId of current.dueIds) {
    const wireModelId = candidates.find((row) => row.modelId === modelId)?.offerings[0]?.wireModelId;
    if (wireModelId === undefined || signal.aborted) break;
    let outcome: AccessProviderAccessOutcome;
    try {
      outcome = await pass.probe({ ...pass.probeInput, wireModelId });
    } catch (error) {
      if (signal.aborted) break;
      throw error;
    }
    if (outcome === "inconclusive") {
      if (pass.inconclusiveEndsPass) break;
      continue;
    }
    const { generation } = current;
    if (!await withProfile((profile) => recordProviderModelAccess(profile, account, lineage, generation, modelId, outcome, limits))) break;
    current = { ...current, dueIds: current.dueIds.filter((id) => id !== modelId), outcomes: { ...current.outcomes, [modelId]: outcome } };
    await pass.onAccessAudit?.({ account, remaining: current.dueIds.length, modelId, outcome });
  }
  return current;
}

/** What an audited account's listing and audit settled, ready to assemble into its catalog. */
interface AuditedCatalogInput {
  readonly contribution: ModelCatalogContribution;
  readonly defaultChatTransport: OfferingTransport | undefined;
  readonly fallback: SharedModelsDevBaseline;
  /** The models the account's own listing names, which serve at once. */
  readonly listed: readonly CatalogCanonicalRow[];
  readonly listedProvenance: "first-party" | "first-party-cached";
  readonly candidates: readonly CatalogCanonicalRow[];
  readonly audit: SavedAudit | undefined;
  /** The outcomes transferred with an access-only credential, which replace the saved audit. */
  readonly transferred: ProviderModelAccessSnapshot | undefined;
  readonly joined: JoinedCatalogRows | undefined;
  readonly discoveryFailure: ResolvedModelCatalog | undefined;
}

/** Serves the listed models and the candidates whose probe completed, and shows every candidate not refused. */
export function assembleAuditedCatalog(input: AuditedCatalogInput): AccessProviderCandidateModels {
  const { contribution, defaultChatTransport, fallback, listed, candidates, audit, transferred, joined, discoveryFailure } = input;
  const outcomes = transferred?.outcomes ?? audit?.outcomes ?? {};
  const remaining = transferred === undefined ? audit?.dueIds.length ?? candidates.length : candidates.filter((row) => outcomes[row.modelId] === undefined).length;
  const auditStatus = { audit: { remaining, refused: Object.values(outcomes).filter((outcome) => outcome === "refused").length } };
  const served = enrichCatalogRows(listed, fallback.canonicalRows);
  const visibleCandidates = candidates.filter((row) => outcomes[row.modelId] !== "refused");
  const visible = [...served, ...visibleCandidates];
  const admitted = [...served, ...visibleCandidates.filter((row) => outcomes[row.modelId] === "completed")];
  const visibleModels = catalogRowsToModelMap(visible, defaultChatTransport);
  const diagnostics = joined === undefined ? {} : { diagnostics: { baselineGeneration: fallback.generation, unknownWireModelIds: joined.unknownWireModelIds, collisions: joined.collisions } };
  if (discoveryFailure !== undefined) return { models: null, visibleModels, outcome: discoveryFailure, ...auditStatus, ...diagnostics };
  if (visible.length === 0) return { models: null, outcome: { kind: "unavailable", reason: "unusable" }, ...auditStatus, ...diagnostics };
  if (admitted.length === 0) return { models: null, visibleModels, outcome: { kind: "unavailable", reason: "discovery-pending" }, ...auditStatus, ...diagnostics };
  const outcome = resolveModelCatalog(served.length === 0
    ? { authenticated: true, live: { kind: "not-attempted" }, contribution, canonicalFallback: admitted, fallbackProvenance: fallback.provenance }
    : { authenticated: true, live: { kind: "resolved-rows", rows: admitted }, contribution, canonicalFallback: undefined, firstPartyProvenance: input.listedProvenance });
  return { models: catalogRowsToModelMap(admitted, defaultChatTransport), visibleModels, outcome, ...auditStatus, ...diagnostics };
}
