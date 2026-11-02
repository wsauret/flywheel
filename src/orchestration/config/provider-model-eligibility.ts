import { accessProviderAccountKey, type AccessProviderCandidate, type AccessProviderCandidateAttribution, type AccessProviderModelEligibility } from "../../infra/llm/access-provider.js";
import type { ProviderCatalogDiscovery } from "../../protocol/provider-model-preference-protocol-types.js";
import { offeringTransport, type CatalogModelOffering, type OfferingTransport } from "../../infra/llm/model-catalog-resolution.js";
import type { IdleFreePlanMark } from "../../infra/llm/free-plan-accounts.js";

interface ProviderCatalogEligibility {
  readonly effective: ReadonlySet<string>;
  readonly enabled: ReadonlySet<string>;
}

export interface ProviderModelEnabledCandidate {
  readonly candidate: AccessProviderCandidate;
  readonly configured: boolean;
  readonly currentConnection: boolean;
  readonly enabledOfferings: ReadonlyMap<string, readonly CatalogModelOffering[]> | null;
  readonly catalog: ProviderCatalogDiscovery;
  readonly preferFreeRoutes?: boolean;
  /** A free-plan account beside another account of its provider. It stays connected and never serves (PI-MODEL-038). */
  readonly idleFreePlan?: IdleFreePlanMark;
}

type AvailableProviderModelEnabledCandidate = ProviderModelEnabledCandidate & {
  readonly enabledOfferings: ReadonlyMap<string, readonly CatalogModelOffering[]>;
  readonly catalog: Extract<ProviderCatalogDiscovery, { readonly kind: "available" }>;
};

interface WorkerProviderModelEligibilityState {
  readonly profileId?: string;
  readonly revision?: number;
  readonly catalogs: ReadonlyMap<string, ProviderCatalogEligibility>;
  readonly enabledCandidates: ReadonlyMap<string, ProviderModelEnabledCandidate>;
}

export interface ProviderModelEligibilityDecisionInput {
  readonly profileId: string;
  readonly revision: number;
  readonly catalogs: ReadonlyMap<string, ProviderCatalogEligibility>;
  readonly enabledCandidates: ReadonlyMap<string, ProviderModelEnabledCandidate>;
}

export interface WorkerProviderModelEligibility extends AccessProviderModelEligibility {
  readonly profileId?: string;
  readonly revision?: number;
}

export interface PickerModelEligibility {
  readonly explicitlyEnabled: boolean;
  readonly catalog?: ProviderCatalogDiscovery;
  readonly transport?: OfferingTransport;
}

export interface ProviderModelEligibilityDecision {
  readonly profileId: string;
  readonly revision: number;
  readonly enabledCandidates: ReadonlyMap<string, ProviderModelEnabledCandidate>;
  readonly picker: ReadonlyMap<string, PickerModelEligibility>;
  readonly availability: ReadonlyMap<string, ReadonlyMap<string, PickerModelEligibility>>;
  readonly worker: WorkerProviderModelEligibility;
}

/** Makes one immutable decision for display and exact-candidate admission. */
export function providerModelEligibilityDecision(input: ProviderModelEligibilityDecisionInput): ProviderModelEligibilityDecision {
  const enabledCandidates = input.enabledCandidates;
  const worker = buildWorkerProviderModelEligibility({ profileId: input.profileId, revision: input.revision, catalogs: input.catalogs, enabledCandidates });
  const availability = new Map<string, Map<string, PickerModelEligibility>>();
  const picker = new Map<string, PickerModelEligibility>();
  for (const entry of enabledCandidates.values()) {
    if (!isAvailableCandidate(entry)) continue;
    const provider = input.catalogs.get(entry.candidate.providerId);
    if (!provider) continue;
    const providerAvailability = availability.get(entry.candidate.providerId) ?? new Map<string, PickerModelEligibility>();
    availability.set(entry.candidate.providerId, providerAvailability);
    for (const [model, offerings] of entry.enabledOfferings) {
      const explicitlyEnabled = provider.enabled.has(model);
      const transport = offerings.map((offering) => offering.transport ?? offeringTransport(offering.metadata)).find((value) => value !== undefined);
      const eligibility = Object.freeze({ explicitlyEnabled, catalog: entry.catalog, ...(transport === undefined ? {} : { transport }) });
      const previousProvider = providerAvailability.get(model);
      if (!previousProvider || (explicitlyEnabled && !previousProvider.explicitlyEnabled)) providerAvailability.set(model, eligibility);
      const previous = picker.get(model);
      if (!previous || (explicitlyEnabled && !previous.explicitlyEnabled)) picker.set(model, eligibility);
    }
  }
  return Object.freeze({ profileId: input.profileId, revision: input.revision, enabledCandidates, availability, picker, worker });
}

/** Builds the immutable profile-bound eligibility captured by one request. */
export function workerProviderModelEligibilityFromState(state: WorkerProviderModelEligibilityState): WorkerProviderModelEligibility {
  return buildWorkerProviderModelEligibility(state);
}

function buildWorkerProviderModelEligibility(state: WorkerProviderModelEligibilityState): WorkerProviderModelEligibility {
  const catalogs = new Map([...state.catalogs].map(([providerId, catalog]) => [providerId, {
    effective: new Set(catalog.effective),
    enabled: new Set(catalog.enabled),
  }]));
  const enabledCandidates = state.enabledCandidates;
  return Object.freeze({
    modelIds: new Set([...enabledCandidates.values()].flatMap((entry) => [...entry.enabledOfferings?.keys() ?? []])),
    ...(state.profileId === undefined ? {} : { profileId: state.profileId }),
    ...(state.revision === undefined ? {} : { revision: state.revision }),
    modelUnavailableReason(provider: string, model: string) {
      return catalogs.get(provider)?.effective.has(model) === true
        ? undefined
        : `${provider} is disabled for ${model} in the active profile.`;
    },
    candidateModelUnavailableReason(candidate: AccessProviderCandidate, model: string) {
      const accountCatalog = enabledCandidates.get(accessProviderAccountKey(candidate));
      if (accountCatalog?.idleFreePlan !== undefined) {
        return `${candidate.providerId} account ${candidate.kind === "subscription" ? candidate.instanceId : "singleton"} is a free plan beside another account of its provider, and only paid accounts rotate.`;
      }
      if (accountCatalog !== undefined && !accountCatalog.currentConnection) {
        return `${candidate.providerId} account ${candidate.kind === "subscription" ? candidate.instanceId : "singleton"} has no current connection.`;
      }
      return accountCatalog !== undefined && isAvailableCandidate(accountCatalog) && accountCatalog.enabledOfferings.has(model)
        ? undefined
        : `${candidate.providerId} account ${candidate.kind === "subscription" ? candidate.instanceId : "singleton"} cannot serve ${model}.`;
    },
    candidateOffering(candidate: AccessProviderCandidate, model: string, allowTrainingRoutes: boolean) {
      const accountCatalog = enabledCandidates.get(accessProviderAccountKey(candidate));
      return accountCatalog === undefined ? undefined : selectCandidateOfferings(accountCatalog, model, allowTrainingRoutes)[0];
    },
    candidateOfferings(candidate: AccessProviderCandidate, model: string, allowTrainingRoutes: boolean) {
      const accountCatalog = enabledCandidates.get(accessProviderAccountKey(candidate));
      return accountCatalog === undefined ? Object.freeze([]) : selectCandidateOfferings(accountCatalog, model, allowTrainingRoutes);
    },
    accessPending(allowTrainingRoutes = false) {
      const accounts = [...enabledCandidates.values()].filter(({ configured, currentConnection }) => configured && currentConnection);
      return accounts.some(({ catalog }) => catalog.kind === "unavailable" && catalog.reason === "discovery-pending")
        && !providerModelsCanServeRequest(accounts, allowTrainingRoutes);
    },
  });
}

/** True only when a configured current account has an enabled offering admitted by profile policy. */
export function providerModelsCanServeRequest(candidates: Iterable<ProviderModelEnabledCandidate>, allowTrainingRoutes: boolean): boolean {
  return [...candidates].some((candidate) => isAvailableCandidate(candidate)
    && [...candidate.enabledOfferings.keys()].some((model) => selectCandidateOfferings(candidate, model, allowTrainingRoutes).length > 0));
}

function selectCandidateOfferings(entry: ProviderModelEnabledCandidate, model: string, allowTrainingRoutes: boolean): readonly AccessProviderCandidateAttribution[] {
  if (entry.catalog.kind !== "available" || entry.idleFreePlan !== undefined) return Object.freeze([]);
  const catalog = entry.catalog;
  const offerings = entry.enabledOfferings?.get(model) ?? [];
  const ordinary = offerings.filter(({ dataUse, routeKind }) => dataUse === "standard" && routeKind !== "free");
  const free = offerings.filter(({ dataUse, routeKind }) => dataUse === "standard" && routeKind === "free");
  const contributor = allowTrainingRoutes ? offerings.filter(({ dataUse }) => dataUse === "contributor") : [];
  const standard = entry.preferFreeRoutes === true ? [...free, ...ordinary] : ordinary;
  const selected = standard.length > 0 ? standard : contributor;
  return Object.freeze(selected.map((offering) => Object.freeze({
    candidate: entry.candidate,
    wireModelId: offering.wireModelId,
    dataUse: offering.dataUse,
    ...(offering.routeKind === undefined ? {} : { routeKind: offering.routeKind }),
    ...(offering.transport === undefined ? {} : { transport: offering.transport }),
    catalogMetadata: offering.metadata,
    ...(offering.resolvedMetadata === undefined ? {} : { resolvedModelMetadata: offering.resolvedMetadata }),
    catalogProvenance: catalog.provenance === "models-dev-bundled"
      ? "bundled"
      : catalog.provenance === "models-dev-archive" || catalog.provenance === "first-party-cached"
        ? "last-known-good"
      : catalog.provenance === "static"
        ? "static"
        : "live",
  })));
}

function isAvailableCandidate(entry: ProviderModelEnabledCandidate): entry is AvailableProviderModelEnabledCandidate {
  return entry.configured && entry.currentConnection && entry.idleFreePlan === undefined && entry.catalog.kind === "available" && entry.enabledOfferings !== null;
}

