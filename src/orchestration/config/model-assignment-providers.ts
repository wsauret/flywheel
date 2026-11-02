import type { AuthContext } from "../../infra/auth/auth-context.js";
import { AuthProfileDirectoryNotFoundError, openExistingAuthProfileDirectory } from "../../infra/auth/auth-profile-store.js";
import { authStoreObservationKey, loadAuthStoreWithDiagnostics } from "../../infra/auth/auth-store.js";
import { prepareProviderModelPreferences, type AccountProviderModelPreference } from "../../infra/auth/provider-model-preference-store.js";
import { accessProviderAccountIdentity, accessProviderAccountKey, compareAutomaticSelection, type AccessProviderAccountIdentity, type AccessProviderCandidate, type AccessProviderId } from "../../infra/llm/access-provider.js";
import type { ModelFamily } from "../../infra/llm/model-family.js";
import type { AccessAuditProgressListener, AccessAuditStatus, ModelDiscoveryMode, ModelListingClient } from "../../infra/llm/model-listing.js";
import { groupedOfferingIndex, offeringTransport, offeringTransportFamily, type CatalogModelOffering, type ResolvedModelCatalog } from "../../infra/llm/model-catalog-resolution.js";
import { deriveProviderModelPreferences, resolveAccountProviderModelPreferences, type ProviderModelCatalog, type ResolvedProviderModels } from "../../infra/llm/provider-model-preferences.js";
import { getSharedModelListingClient } from "./llm-clients.js";
import { isListableRoute, sharedModelInfos } from "../../infra/llm/provider-model-info.js";
import { customProviderById } from "../../infra/llm/custom-provider-registry.js";
import { composeFirstPartyModules, type FirstPartyModuleSnapshot } from "../modules.js";
import { installedCredentialProviderIds } from "../credential-provider-modules.js";
import { credentialSlotClassifier } from "../auth/credential-slot-classifier.js";

import { accessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js";
import type { LauncherScope } from "../../infra/process-supervisor.js";
interface ProviderModelDeps {
  /** Startup-selected account data root the credential directory and the
   *  models.dev snapshot derive from (ARCH-DIRECTORIES-002). */
  readonly userDataRoot: string;
  readonly authDirectory: () => string;
  readonly moduleSelection?: FirstPartyModuleSnapshot;
  auth: AuthContext;
  signal?: AbortSignal;
  listingClient?: ModelListingClient;
  discoveryMode?: ModelDiscoveryMode;
  /** Reports each conclusive probe of an `audit` listing; scoped to this one call. */
  onAccessAudit?: AccessAuditProgressListener;
  /** Scopes an `audit` listing to one exact account and rechecks all its current candidates. */
  readonly recheckAccount?: AccessProviderAccountIdentity;
  readonly preferencePersistence?: "persist" | "read-only";
  /** The caller's launch authority, for a provider whose listing runs a local process. */
  readonly launcher?: LauncherScope;
}

interface ResolvedProviderModelInventoryCandidate {
  readonly candidate: AccessProviderCandidate;
  readonly configured: boolean;
  readonly currentConnection: boolean;
  readonly enabledOfferings: ReadonlyMap<string, readonly CatalogModelOffering[]> | null;
  readonly inventoryOfferings: ReadonlyMap<string, readonly CatalogModelOffering[]> | null;
  readonly preferFreeRoutes?: boolean;
  readonly outcome?: ResolvedModelCatalog;
  readonly audit?: AccessAuditStatus;
  /** Models whose access an audited subscription proved; the other inventory models are pending. Present with `audit`. */
  readonly verifiedModelIds?: ReadonlySet<string>;
}

export interface ResolvedProviderModelCatalogs {
  readonly autoEnableNewModels?: boolean;
  readonly providers: ReadonlyMap<AccessProviderId, ResolvedProviderModels>;
  readonly accounts: ReadonlyMap<string, ResolvedProviderModels>;
  readonly inventoryCandidates: ReadonlyMap<string, ResolvedProviderModelInventoryCandidate>;
  readonly modelInfos: ReadonlyMap<string, import("../../infra/llm/models.js").ModelInfo>;
  readonly enabledModels: ReadonlyMap<ModelFamily, ReadonlySet<string>>;
}

export type ResolvedEnabledProviderModelCatalog = Pick<ResolvedProviderModelCatalogs, "providers" | "modelInfos" | "enabledModels">

/** Resolves only the enabled exact-account projection for runtime model selection. */
export async function resolveEnabledProviderModelCatalog(deps: ProviderModelDeps): Promise<ResolvedEnabledProviderModelCatalog> {
  const { providers, modelInfos, enabledModels } = await resolveProviderModelCatalog(deps)
  return { providers, modelInfos, enabledModels }
}

export async function resolveProviderModelCatalog(
  deps: ProviderModelDeps,
): Promise<ResolvedProviderModelCatalogs> {
  const modules = deps.moduleSelection?.() ?? composeFirstPartyModules();
  const listing = deps.listingClient ?? getSharedModelListingClient(deps.userDataRoot, deps.authDirectory(), modules);
  const observeAuth = () => loadAuthStoreWithDiagnostics(deps.authDirectory(), installedCredentialProviderIds(), credentialSlotClassifier(modules), false);
  const capturedAuthRevision = deps.auth.observation ?? authStoreObservationKey(observeAuth());
  const listed = listableCatalogs(await listing.getModelCatalogs(deps.auth, {
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(deps.discoveryMode === undefined ? {} : { mode: deps.discoveryMode }),
    ...(deps.onAccessAudit === undefined ? {} : { onAccessAudit: deps.onAccessAudit }),
    ...(deps.recheckAccount === undefined ? {} : { recheckAccount: deps.recheckAccount }),
    ...(deps.launcher === undefined ? {} : { launcher: deps.launcher }),
  }));
  const selection = accessProviderRegistry(modules).selection;
  const liveCatalog = new Map<AccessProviderId, ReadonlySet<string>>();
  for (const entry of listed.candidates.values()) {
    const offerings: ReadonlyMap<string, readonly CatalogModelOffering[]> = entry.models ?? new Map();
    const catalog = new Set(offerings.keys());
    const providerCatalog = liveCatalog.get(entry.candidate.providerId) ?? new Set<string>();
    liveCatalog.set(entry.candidate.providerId, new Set([...providerCatalog, ...catalog]));
  }
  let preferences = new Map<string, AccountProviderModelPreference>();
  let autoEnableNewModels = true;
  try {
    const access = openExistingAuthProfileDirectory(deps.authDirectory());
    try {
      const currentAccounts = new Map<string, AccessProviderAccountIdentity>();
      for (const definition of selection.definitions) {
        if (definition.billing === "metered") {
          const account: AccessProviderAccountIdentity = { kind: "singleton", providerId: definition.id };
          currentAccounts.set(accessProviderAccountKey(account), account);
        }
      }
      for (const entry of listed.candidates.values()) {
        const account = accessProviderAccountIdentity(entry.candidate);
        currentAccounts.set(accessProviderAccountKey(account), account);
      }
      const offeringIndexes = new Map([...listed.candidates.values()].flatMap((entry) => {
        const offerings = entry.visibleModels ?? entry.models;
        if (offerings == null) return [];
        const rows = [...offerings].map(([modelId, modelOfferings]) => ({ modelId, offerings: modelOfferings }));
        return [[accessProviderAccountKey(entry.candidate), groupedOfferingIndex(rows)] as const];
      }));
      const prepared = await prepareProviderModelPreferences(access, capturedAuthRevision, [...currentAccounts.values()], () => authStoreObservationKey(observeAuth()), offeringIndexes, deps.preferencePersistence ?? (deps.auth.conditions?.length ? "read-only" : "persist"));
      preferences = new Map(prepared?.accounts);
      autoEnableNewModels = prepared?.autoEnableNewModels ?? true;
    } finally {
      access.close();
    }
  } catch (error) {
    if (!(error instanceof AuthProfileDirectoryNotFoundError)) throw error;
  }
  const accounts = new Map<string, ResolvedProviderModels>();
  const accountEntries: Array<readonly [AccessProviderAccountIdentity, ResolvedProviderModels]> = [];
  for (const entry of listed.candidates.values()) {
    const account = accessProviderAccountIdentity(entry.candidate);
    const key = accessProviderAccountKey(account);
    const inventory = entry.visibleModels ?? entry.models ?? new Map();
    const accountCatalog = new Set(inventory.keys());
    const preference = preferences.get(key);
    const defaultCatalog = entry.audit === undefined ? accountCatalog : new Set(entry.models?.keys());
    const accountModels = resolveAccountProviderModelPreferences(accountCatalog, defaultCatalog, preference, autoEnableNewModels);
    accounts.set(key, accountModels);
    if (entry.outcome?.kind !== "unavailable") {
      const eligibleCatalog = new Set(entry.models?.keys());
      accountEntries.push([account, resolveAccountProviderModelPreferences(eligibleCatalog, eligibleCatalog, preference, autoEnableNewModels)]);
    }
  }
  const providerCatalogs = new Map<AccessProviderId, ProviderModelCatalog>([...liveCatalog].map(([providerId, catalog]) => [providerId, { catalog, curatedDefault: catalog }]));
  const providerPreferences = deriveProviderModelPreferences(providerCatalogs, accountEntries);
  const providers = new Map([...providerPreferences].map(([providerId, models]) => [providerId, {
    catalog: new Set(models.effective),
    curatedDefault: new Set([...models.curatedDefault].filter((model) => models.effective.has(model))),
    enabled: new Set(models.enabled),
    disabled: new Set<string>(),
    effective: new Set(models.effective),
  }]));
  const inventoryCandidates = new Map([...listed.candidates].map(([key, entry]) => {
    const groupedCatalog = entry.models;
    const inventoryOfferings = entry.visibleModels ?? groupedCatalog ?? null;
    const accountKey = accessProviderAccountKey(entry.candidate);
    const models = accounts.get(accountKey);
    const preferFreeRoutes = preferences.get(accountKey)?.preferFreeRoutes ?? false;
    return [key, {
      candidate: entry.candidate,
      configured: true,
      currentConnection: entry.outcome?.kind !== "unavailable" || entry.outcome.reason !== "authentication-invalid",
      enabledOfferings: models === undefined || groupedCatalog === null || entry.outcome?.kind === "unavailable"
        ? null
        : eligibleOfferingMap(groupedCatalog, models.effective, preferFreeRoutes),
      inventoryOfferings,
      preferFreeRoutes,
      ...(entry.outcome === undefined ? {} : { outcome: entry.outcome }),
      ...(entry.audit === undefined ? {} : { audit: entry.audit, verifiedModelIds: new Set(groupedCatalog?.keys()) }),
    }] as const;
  }));
  const ranks = new Map(selection.definitions.map((definition) => [definition.id, definition.rank]));
  const modelInfos = enabledModelInfos(inventoryCandidates, (providerId) => ranks.get(providerId) ?? Number.MAX_SAFE_INTEGER);
  const enabledModels = enabledModelsByFamily(inventoryCandidates);
  return { autoEnableNewModels, providers, accounts, inventoryCandidates, modelInfos, enabledModels };
}

type ListedCatalogs = Awaited<ReturnType<ModelListingClient["getModelCatalogs"]>>;

/** Flywheel is an agentic coding harness: an account lists a route only when it
 *  is priced for tiering and calls tools on text. A custom provider keeps its
 *  user-authored model IDs, which are its own authority. */
function listableCatalogs(listed: ListedCatalogs): ListedCatalogs {
  const listable = (catalog: ReadonlyMap<string, readonly CatalogModelOffering[]>) => {
    if ([...catalog.values()].every((offerings) => offerings.every(isListableRoute))) return catalog;
    return new Map([...catalog].flatMap(([modelId, offerings]) => {
      const routes = offerings.filter(isListableRoute);
      return routes.length === 0 ? [] : [[modelId, routes.length === offerings.length ? offerings : Object.freeze(routes)] as const];
    }));
  };
  const candidates = new Map([...listed.candidates].map(([key, entry]) => {
    if (customProviderById(entry.candidate.providerId) !== undefined) return [key, entry] as const;
    const models = entry.models === null ? null : listable(entry.models);
    const visibleModels = entry.visibleModels === entry.models ? models ?? undefined : entry.visibleModels && listable(entry.visibleModels);
    return [key, { ...entry, models, ...(visibleModels === undefined ? {} : { visibleModels }) }] as const;
  }));
  const providers = new Map<AccessProviderId, ReadonlySet<string>>();
  for (const entry of candidates.values()) {
    if (entry.models && entry.models.size > 0) providers.set(entry.candidate.providerId, new Set([...providers.get(entry.candidate.providerId) ?? [], ...entry.models.keys()]));
  }
  return { providers, candidates };
}

function eligibleOfferingMap(
  offerings: ReadonlyMap<string, readonly CatalogModelOffering[]>,
  enabled: ReadonlySet<string>,
  preferFreeRoutes: boolean,
): ReadonlyMap<string, readonly CatalogModelOffering[]> {
  return new Map([...offerings].flatMap(([modelId, routes]) => {
    if (!enabled.has(modelId)) return [];
    const eligible = preferFreeRoutes ? routes : routes.filter((route) => route.routeKind !== "free");
    return eligible.length === 0 ? [] : [[modelId, eligible] as const];
  }));
}

/** One shared record per enabled model, merged across every account in the
 *  order automatic selection walks them. Routes never cancel each other out. */
export function enabledModelInfos(
  candidates: ReadonlyMap<string, Pick<ResolvedProviderModelInventoryCandidate, "candidate" | "enabledOfferings">>,
  rank: (providerId: AccessProviderId) => number,
): ReadonlyMap<string, import("../../infra/llm/models.js").ModelInfo> {
  const ordered = [...candidates.values()].toSorted((left, right) => compareAutomaticSelection(
    { spendMode: left.candidate.spendMode, rank: rank(left.candidate.providerId) },
    { spendMode: right.candidate.spendMode, rank: rank(right.candidate.providerId) },
  ));
  return sharedModelInfos(ordered.flatMap((candidate) => [...candidate.enabledOfferings ?? []]));
}

function enabledModelsByFamily(candidates: ReadonlyMap<string, ResolvedProviderModelInventoryCandidate>): ReadonlyMap<ModelFamily, ReadonlySet<string>> {
  const byFamily = new Map<ModelFamily, Set<string>>();
  for (const candidate of candidates.values()) {
    for (const [model, offerings] of candidate.enabledOfferings ?? []) {
      const transport = offerings.map((offering) => offering.transport ?? offeringTransport(offering.metadata)).find((value) => value !== undefined);
      if (transport === undefined) continue;
      const family = offeringTransportFamily(transport);
      const models = byFamily.get(family) ?? new Set<string>();
      models.add(model);
      byFamily.set(family, models);
    }
  }
  return byFamily;
}
