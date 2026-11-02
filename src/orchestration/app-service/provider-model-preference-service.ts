import type { ProviderModelPreferenceState } from "../../infra/auth/provider-model-preference-store.js"
import { accessProviderAccountKey, type AccessProviderAccountIdentity } from "../../infra/llm/access-provider.js"
import { resolveAccountProviderModelPreferences, transitionProviderAutoEnableNewModels, type ProviderModelCatalog, type ResolvedProviderModels } from "../../infra/llm/provider-model-preferences.js"
import { subscriptionSpendAccountCorrelationId } from "../../protocol/subscription-spend-consent-protocol-types.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import { createProfileRuntimeStateOwner, type ProfileRuntimeSnapshot } from "./profile-runtime-state.js"
import { providerModelEligibilityDecision, type PickerModelEligibility, type ProviderModelEnabledCandidate, type WorkerProviderModelEligibility } from "../config/provider-model-eligibility.js"
import type { CatalogModelOffering } from "../../infra/llm/model-catalog-resolution.js"
import type { AccessAuditStatus } from "../../infra/llm/model-listing.js"
import type { ProviderModelPreferenceService } from "./app-service.js"
import { TRAINING_ROUTES_REQUIRED, type ProviderCatalogDiscovery, type ProviderModelRow, type ProviderModelTarget, type ProviderModelView, type RuntimeDeselectAllProviderModelsMutation, type RuntimeProviderModelHiddenResult, type RuntimeRecheckProviderModelsMutation, type RuntimeSetProviderAutoEnableNewModelsMutation, type RuntimeSetProviderAutoEnableNewModelsResult, type RuntimeSetProviderFreeRoutesMutation, type RuntimeSetProviderModelMutation, type RuntimeSetProviderModelResult } from "../../protocol/provider-model-preference-protocol-types.js"

const ABSENT_CATALOG: ProviderCatalogDiscovery = { kind: "unavailable", reason: "authentication-absent" }

interface ProviderModelEligibilityInput {
  readonly profileId: string
  readonly autoEnableNewModels?: boolean
  readonly catalogs: ReadonlyMap<string, ResolvedProviderModels>
  readonly accountCatalogs: ReadonlyMap<string, ResolvedProviderModels>
  readonly inventoryCandidates: ReadonlyMap<string, ProviderModelInventoryCandidate>
  readonly authRevision: string
  readonly preferenceRevision: string

  /** ISO release date per model id, from models.dev metadata; models without a
   *  known date sort after dated ones. */
  readonly releaseDates: ReadonlyMap<string, string>
}

export interface ProviderModelInventoryCandidate extends ProviderModelEnabledCandidate {
  readonly inventoryOfferings: ReadonlyMap<string, readonly CatalogModelOffering[]> | null
  readonly preferFreeRoutes?: boolean
  /** Saved-audit status of an audited subscription: probes still due and models refused. */
  readonly audit?: AccessAuditStatus
  /** Models the audit proved; other inventory models of an audited account are pending. */
  readonly verifiedModelIds?: ReadonlySet<string>
}

export interface ProviderModelEligibilityState extends ProviderModelEligibilityInput {
  readonly autoEnableNewModels: boolean
  readonly revision: number
  readonly picker: ReadonlyMap<string, PickerModelEligibility>
  readonly worker: WorkerProviderModelEligibility
  readonly membership: ReadonlyMap<string, ProviderModelView>
  readonly targetAccounts: ReadonlyMap<string, AccessProviderAccountIdentity>
  readonly inventoryCandidates: ReadonlyMap<string, ProviderModelInventoryCandidate>
  readonly enabledCandidates: ReadonlyMap<string, ProviderModelEnabledCandidate>
}

export type RuntimeProviderModelEligibilityState = Pick<ProviderModelEligibilityState, "profileId" | "revision" | "catalogs" | "picker" | "worker" | "enabledCandidates">

export interface ProviderModelPreferenceServiceDeps {
  readonly displayName: (providerId: string) => string
  readonly allowTrainingRoutes: (profileId: string) => boolean
  readonly persist: (mutation: {
    readonly profileId: string
    readonly account: AccessProviderAccountIdentity
    readonly currentAccounts: readonly AccessProviderAccountIdentity[]
    readonly expectedAuthRevision: string
    readonly expectedPreferenceRevision: string
    readonly modelId: string
    readonly checked: boolean
    readonly state: ProviderModelPreferenceState
  }) => Promise<string>
  readonly persistAllDeselected: (mutation: {
    readonly profileId: string
    readonly account: AccessProviderAccountIdentity
    readonly currentAccounts: readonly AccessProviderAccountIdentity[]
    readonly expectedAuthRevision: string
    readonly expectedPreferenceRevision: string
    readonly modelIds: readonly string[]
  }) => Promise<string>
  readonly persistAutoEnableNewModels?: (mutation: {
    readonly profileId: string
    readonly currentAccounts: readonly AccessProviderAccountIdentity[]
    readonly expectedAuthRevision: string
    readonly expectedPreferenceRevision: string
    readonly enabled: boolean
    readonly accountCatalogs: ReadonlyMap<string, { readonly account: AccessProviderAccountIdentity; readonly effectiveModelIds: readonly string[]; readonly catalogModelIds: readonly string[] }>
  }) => Promise<string>
  readonly persistFreeRoutes?: (mutation: {
    readonly profileId: string
    readonly account: AccessProviderAccountIdentity
    readonly currentAccounts: readonly AccessProviderAccountIdentity[]
    readonly expectedAuthRevision: string
    readonly expectedPreferenceRevision: string
    readonly enabled: boolean
  }) => Promise<string>
  /** Called after the request is validated against the current snapshot. Queues the owned recheck of the exact account and returns without waiting for probes. Throws on stale inputs. */
  readonly recheckAccount?: (request: {
    readonly profileId: string
    readonly account: AccessProviderAccountIdentity
    readonly expectedAuthRevision: string
    readonly expectedPreferenceRevision: string
  }) => void
  readonly publish?: (state: ProviderModelEligibilityState) => void
}

export interface ProfileBoundProviderModelPreferenceService extends ProviderModelPreferenceService {
  /** Validates the queried revision and the audited account under the mutation tail, queues the owned recheck, and resolves with the unchanged current view. Saved preferences and prior verified routing stay as they are until a probe result publishes. Rejects a stale revision, an unknown or unaudited account, and an unwired service. */
  recheck(mutation: RuntimeRecheckProviderModelsMutation): Promise<ProviderModelView | RuntimeProviderModelHiddenResult>
  prepare(input: ProviderModelEligibilityInput): ProviderModelEligibilityState
  publish(state: ProviderModelEligibilityState): void
  state(profileId?: string): ProviderModelEligibilityState | undefined
  dispose(): Promise<void>
}

/** Owns immutable profile-bound eligibility snapshots. Preparation performs all catalog membership work before publication; queries perform no I/O. */
export function createProviderModelPreferenceService(deps: ProviderModelPreferenceServiceDeps): ProfileBoundProviderModelPreferenceService {
  const runtime = createProfileRuntimeStateOwner<ProviderModelEligibilityState>({
    publish: (snapshot) => { deps.publish?.(snapshot.snapshot) },
  })
  const preparedSnapshots = new WeakMap<ProviderModelEligibilityState, ProfileRuntimeSnapshot<ProviderModelEligibilityState>>()
  const mutations = createOrderedLane()

  const prepare = (input: ProviderModelEligibilityInput): ProviderModelEligibilityState => {
    const prepared = runtime.create(input.profileId, (revision) => {
      const catalogs = immutableCatalogs(input.catalogs)
      const accountCatalogs = immutableCatalogs(input.accountCatalogs)
      const inventoryCandidates = immutableInventoryCandidates(input.inventoryCandidates)
      const enabledCandidates = enabledCandidateProjection(inventoryCandidates)
      const decision = providerModelEligibilityDecision({ profileId: input.profileId, revision, catalogs, enabledCandidates })
      const releaseDates: ReadonlyMap<string, string> = new Map(input.releaseDates)
      return Object.freeze({
        profileId: input.profileId,
        autoEnableNewModels: input.autoEnableNewModels ?? true,
        revision,
        catalogs,
        accountCatalogs,
        authRevision: input.authRevision,
        preferenceRevision: input.preferenceRevision,
        inventoryCandidates,
        enabledCandidates: decision.enabledCandidates,
        picker: decision.picker,
        worker: decision.worker,
        releaseDates,
        membership: buildMembership(input.profileId, revision, accountCatalogs, inventoryCandidates, deps.displayName, releaseDates),
        targetAccounts: targetAccounts(input.profileId, inventoryCandidates),
      })
    })
    preparedSnapshots.set(prepared.snapshot, prepared)
    return prepared.snapshot
  }

  const commit = (state: ProviderModelEligibilityState): void => {
    const prepared = preparedSnapshots.get(state)
    if (!prepared) throw new Error("provider-model state was not prepared by this service")
    runtime.publish(prepared)
  }

  const query = async (profileId: string, target: ProviderModelTarget): Promise<ProviderModelView> => {
    const state = requireState(runtime.current(profileId)?.snapshot)
    const view = state.membership.get(targetKey(target))
    if (view) return projectTrainingRouteAvailability(state, target, view, deps.allowTrainingRoutes(profileId))
    if (target.kind === "subscription") throw new Error("provider-model target is unavailable")
    return Object.freeze({
      profileId: state.profileId,
      eligibilityRevision: state.revision,
      target,
      providerDisplayName: deps.displayName(target.providerId),
      catalog: ABSENT_CATALOG,
      rows: Object.freeze([]),
    })
  }

  const set = (mutation: RuntimeSetProviderModelMutation): Promise<RuntimeSetProviderModelResult> => {
    try {
      requireCurrentMutation(runtime.current(mutation.queriedProfileId)?.snapshot, mutation)
    } catch (error) {
      return Promise.reject(error)
    }
    return mutations.run(async () => {
      const before = requireCurrentMutation(runtime.current(mutation.queriedProfileId)?.snapshot, mutation)
      const account = before.targetAccounts.get(targetKey(mutation.target))
      if (!account) throw new Error("provider-model target is unavailable")
      if (!accountPreferenceAvailable(before, account)) throw new Error("provider-model target is unavailable")
      const models = before.accountCatalogs.get(accessProviderAccountKey(account))
      if (!models?.catalog.has(mutation.modelId)) throw new Error(`provider model is not available: ${account.providerId}/${mutation.modelId}`)
      const preference = preferenceState(models, mutation.modelId, mutation.checked, before.autoEnableNewModels)
      const preferenceRevision = await deps.persist({ profileId: before.profileId, account, currentAccounts: [...before.targetAccounts.values()], expectedAuthRevision: before.authRevision, expectedPreferenceRevision: before.preferenceRevision, modelId: mutation.modelId, checked: mutation.checked, state: preference })

      const live = requireState(runtime.current(mutation.queriedProfileId)?.snapshot)
      const accountCatalogs = withAccountPreference(live.accountCatalogs, account, mutation.modelId, preference, live.autoEnableNewModels)
      const inventoryCandidates = withCandidatePreference(live.inventoryCandidates, account, accountCatalogs.get(accessProviderAccountKey(account)))
      const catalogs = deriveProviderCatalogs(inventoryCandidates)
      const next = prepare({ profileId: live.profileId, autoEnableNewModels: live.autoEnableNewModels, authRevision: live.authRevision, preferenceRevision, catalogs, accountCatalogs, inventoryCandidates, releaseDates: live.releaseDates })
      commit(next)
      const view = next.membership.get(targetKey(mutation.target))
      if (!view) return hiddenMutationResult(next, mutation.target)
      const row = view.rows.find((candidate) => candidate.modelId === mutation.modelId)
      if (!row) return hiddenMutationResult(next, mutation.target)
      const projected = projectTrainingRouteAvailability(next, mutation.target, view, deps.allowTrainingRoutes(next.profileId))
      const projectedRow = projected.rows.find((candidate) => candidate.modelId === mutation.modelId)
      if (!projectedRow) return hiddenMutationResult(next, mutation.target)
      return { profileId: next.profileId, eligibilityRevision: next.revision, target: mutation.target, row: projectedRow }
    })
  }

  const deselectAll = (mutation: RuntimeDeselectAllProviderModelsMutation): Promise<ProviderModelView | RuntimeProviderModelHiddenResult> => {
    try {
      requireCurrentMutation(runtime.current(mutation.queriedProfileId)?.snapshot, mutation)
    } catch (error) {
      return Promise.reject(error)
    }
    return mutations.run(async () => {
      const before = requireCurrentMutation(runtime.current(mutation.queriedProfileId)?.snapshot, mutation)
      const account = before.targetAccounts.get(targetKey(mutation.target))
      if (!account) throw new Error("provider-model target is unavailable")
      if (!accountPreferenceAvailable(before, account)) throw new Error("provider-model target is unavailable")
      const key = accessProviderAccountKey(account)
      const models = before.accountCatalogs.get(key)
      if (!models) throw new Error("provider account catalog is unavailable")
      const modelIds = [...models.catalog]
      const preferenceRevision = await deps.persistAllDeselected({ profileId: before.profileId, account, currentAccounts: [...before.targetAccounts.values()], expectedAuthRevision: before.authRevision, expectedPreferenceRevision: before.preferenceRevision, modelIds })
      const live = requireState(runtime.current(mutation.queriedProfileId)?.snapshot)
      const accountCatalogs = new Map(live.accountCatalogs)
      const currentModels = accountCatalogs.get(key)
      if (currentModels !== undefined) {
        const disabled = new Set([...currentModels.disabled, ...modelIds.filter((modelId) => currentModels.catalog.has(modelId))])
        const enabled = new Set([...currentModels.enabled].filter((modelId) => !disabled.has(modelId)))
        const effective = new Set([...currentModels.effective].filter((modelId) => !disabled.has(modelId)))
        accountCatalogs.set(key, Object.freeze({ ...currentModels, enabled, disabled, effective }))
      }
      const inventoryCandidates = withCandidatePreference(live.inventoryCandidates, account, accountCatalogs.get(key))
      const catalogs = deriveProviderCatalogs(inventoryCandidates)
      const next = prepare({ profileId: live.profileId, autoEnableNewModels: live.autoEnableNewModels, authRevision: live.authRevision, preferenceRevision, catalogs, accountCatalogs, inventoryCandidates, releaseDates: live.releaseDates })
      commit(next)
      const view = next.membership.get(targetKey(mutation.target))
      if (!view) return hiddenMutationResult(next, mutation.target)
      return projectTrainingRouteAvailability(next, mutation.target, view, deps.allowTrainingRoutes(next.profileId))
    })
  }

  const setFreeRoutes = (mutation: RuntimeSetProviderFreeRoutesMutation): Promise<ProviderModelView | RuntimeProviderModelHiddenResult> => {
    try {
      requireCurrentMutation(runtime.current(mutation.queriedProfileId)?.snapshot, mutation)
    } catch (error) {
      return Promise.reject(error)
    }
    return mutations.run(async () => {
      const before = requireCurrentMutation(runtime.current(mutation.queriedProfileId)?.snapshot, mutation)
      const account = before.targetAccounts.get(targetKey(mutation.target))
      if (!account || !freeRoutePreferenceAvailable(before, account)) {
        throw new Error("free-route target is unavailable")
      }
      if (deps.persistFreeRoutes === undefined) throw new Error("free-route persistence is unavailable")
      const preferenceRevision = await deps.persistFreeRoutes({
        profileId: before.profileId,
        account,
        currentAccounts: [...before.targetAccounts.values()],
        expectedAuthRevision: before.authRevision,
        expectedPreferenceRevision: before.preferenceRevision,
        enabled: mutation.enabled,
      })
      const live = requireState(runtime.current(mutation.queriedProfileId)?.snapshot)
      const inventoryCandidates = withFreeRoutePreference(live.inventoryCandidates, account, mutation.enabled, live.accountCatalogs.get(accessProviderAccountKey(account)))
      const catalogs = deriveProviderCatalogs(inventoryCandidates)
      const next = prepare({ profileId: live.profileId, autoEnableNewModels: live.autoEnableNewModels, authRevision: live.authRevision, preferenceRevision, catalogs, accountCatalogs: live.accountCatalogs, inventoryCandidates, releaseDates: live.releaseDates })
      commit(next)
      const view = next.membership.get(targetKey(mutation.target))
      if (!view) return hiddenMutationResult(next, mutation.target)
      return projectTrainingRouteAvailability(next, mutation.target, view, deps.allowTrainingRoutes(next.profileId))
    })
  }

  const setAutoEnableNewModels = (mutation: RuntimeSetProviderAutoEnableNewModelsMutation): Promise<RuntimeSetProviderAutoEnableNewModelsResult> => {
    try {
      requireCurrentMutation(runtime.current(mutation.queriedProfileId)?.snapshot, mutation)
    } catch (error) {
      return Promise.reject(error)
    }
    return mutations.run(async () => {
      const before = requireCurrentMutation(runtime.current(mutation.queriedProfileId)?.snapshot, mutation)
      if (deps.persistAutoEnableNewModels === undefined) throw new Error("automatic model enablement persistence is unavailable")
      const accountSnapshots = new Map([...before.targetAccounts.values()].flatMap((account) => {
        const key = accessProviderAccountKey(account)
        const models = before.accountCatalogs.get(key)
        return models === undefined ? [] : [[key, { account, effectiveModelIds: [...models.effective], catalogModelIds: [...models.catalog] }] as const]
      }))
      const preferenceRevision = await deps.persistAutoEnableNewModels({
        profileId: before.profileId,
        currentAccounts: [...before.targetAccounts.values()],
        expectedAuthRevision: before.authRevision,
        expectedPreferenceRevision: before.preferenceRevision,
        enabled: mutation.enabled,
        accountCatalogs: accountSnapshots,
      })
      const live = requireState(runtime.current(mutation.queriedProfileId)?.snapshot)
      const accountCatalogs = withAutoEnableNewModels(live.accountCatalogs, live.targetAccounts.values(), mutation.enabled)
      let inventoryCandidates = live.inventoryCandidates
      for (const account of live.targetAccounts.values()) inventoryCandidates = withCandidatePreference(inventoryCandidates, account, accountCatalogs.get(accessProviderAccountKey(account)))
      const catalogs = deriveProviderCatalogs(inventoryCandidates)
      const next = prepare({ profileId: live.profileId, autoEnableNewModels: mutation.enabled, authRevision: live.authRevision, preferenceRevision, catalogs, accountCatalogs, inventoryCandidates, releaseDates: live.releaseDates })
      commit(next)
      return { profileId: next.profileId, eligibilityRevision: next.revision, autoEnableNewModels: next.autoEnableNewModels }
    })
  }

  const recheck = (mutation: RuntimeRecheckProviderModelsMutation): Promise<ProviderModelView | RuntimeProviderModelHiddenResult> => {
    try {
      requireCurrentMutation(runtime.current(mutation.queriedProfileId)?.snapshot, mutation)
    } catch (error) {
      return Promise.reject(error)
    }
    return mutations.run(() => {
      const before = requireCurrentMutation(runtime.current(mutation.queriedProfileId)?.snapshot, mutation)
      const account = before.targetAccounts.get(targetKey(mutation.target))
      const candidate = account === undefined ? undefined : before.inventoryCandidates.get(accessProviderAccountKey(account))
      if (account === undefined || candidate?.audit === undefined) throw new Error("provider-model recheck target is unavailable")
      if (deps.recheckAccount === undefined) throw new Error("provider-model recheck is unavailable")
      deps.recheckAccount({ profileId: before.profileId, account, expectedAuthRevision: before.authRevision, expectedPreferenceRevision: before.preferenceRevision })
      const view = before.membership.get(targetKey(mutation.target))
      return view === undefined ? hiddenMutationResult(before, mutation.target) : projectTrainingRouteAvailability(before, mutation.target, view, deps.allowTrainingRoutes(before.profileId))
    })
  }

  return { prepare, publish: commit, query, set, deselectAll, setAutoEnableNewModels, setFreeRoutes, recheck, state: (profileId) => runtime.current(profileId)?.snapshot, dispose: () => runtime.dispose() }
}

function requireState(state: ProviderModelEligibilityState | undefined): ProviderModelEligibilityState {
  if (!state) throw new Error("provider-model eligibility is unavailable")
  return state
}

function requireCurrentMutation(state: ProviderModelEligibilityState | undefined, mutation: Pick<RuntimeSetProviderModelMutation, "queriedProfileId" | "queriedEligibilityRevision">): ProviderModelEligibilityState {
  if (!state || state.profileId !== mutation.queriedProfileId || state.revision !== mutation.queriedEligibilityRevision) {
    throw new Error("stale provider-model preference mutation")
  }
  return state
}

/** Preferences are editable for any configured account that has inventory, including an auth-rejected account or one whose catalog discovery failed. Request admission stays strict in `provider-model-eligibility.ts`. */
function hasEditableInventory(candidate: ProviderModelInventoryCandidate | undefined): candidate is ProviderModelInventoryCandidate & { readonly inventoryOfferings: ReadonlyMap<string, readonly CatalogModelOffering[]> } {
  return candidate?.configured === true && candidate.inventoryOfferings !== null
}

function accountPreferenceAvailable(state: ProviderModelEligibilityState, account: AccessProviderAccountIdentity): boolean {
  return hasEditableInventory(state.inventoryCandidates.get(accessProviderAccountKey(account)))
}

function freeRoutePreferenceAvailable(state: ProviderModelEligibilityState, account: AccessProviderAccountIdentity): boolean {
  const candidate = state.inventoryCandidates.get(accessProviderAccountKey(account))
  return accountPreferenceAvailable(state, account)
    && [...candidate?.inventoryOfferings?.values() ?? []].some((offerings) => offerings.some(({ routeKind }) => routeKind === "free"))
}

function hiddenMutationResult(state: ProviderModelEligibilityState, target: ProviderModelTarget): RuntimeProviderModelHiddenResult {
  return { profileId: state.profileId, eligibilityRevision: state.revision, target, hidden: true }
}

function buildMembership(profileId: string, revision: number, accountCatalogs: ReadonlyMap<string, ResolvedProviderModels>, candidates: ReadonlyMap<string, ProviderModelInventoryCandidate>, displayName: (providerId: string) => string, releaseDates: ReadonlyMap<string, string>): ReadonlyMap<string, ProviderModelView> {
  const accounts = targetAccounts(profileId, candidates)
  return new Map([...accounts].map(([key, account]) => {
    const models = accountCatalogs.get(accessProviderAccountKey(account))
    if (!models) throw new Error(`provider account catalog is unavailable: ${account.providerId}`)
    const candidate = candidates.get(accessProviderAccountKey(account))
    const available = hasEditableInventory(candidate)
    const rows = Object.freeze([...models.catalog].sort(byReleaseDateDescending(releaseDates)).map((modelId): ProviderModelRow => Object.freeze({
      modelId,
      checked: models.effective.has(modelId),
      optInAvailable: available && candidate.inventoryOfferings.has(modelId),
      configured: candidate?.configured === true,
      ...(candidate?.audit === undefined ? {} : { accessState: candidate.verifiedModelIds?.has(modelId) === true ? "verified" as const : "pending" as const }),
    })))
    const target = protocolTarget(profileId, account)
    const hasFreeRoutes = [...candidate?.inventoryOfferings?.values() ?? []].some((offerings) => offerings.some(({ routeKind }) => routeKind === "free"))
    return [key, Object.freeze({
      profileId,
      eligibilityRevision: revision,
      target,
      providerDisplayName: displayName(account.providerId),
      catalog: candidate?.catalog ?? ABSENT_CATALOG,
      rows,
      preferenceAvailable: available,
      ...(candidate?.audit === undefined ? {} : { recheckAvailable: true, audit: candidate.audit }),
      ...(hasFreeRoutes ? { freeRoutes: { enabled: candidate?.preferFreeRoutes === true } } : {}),
    })]
  }))
}

function contributorOnly(offerings: readonly { readonly dataUse: "standard" | "contributor" }[] | undefined): boolean {
  return offerings?.some(({ dataUse }) => dataUse === "contributor") === true
    && offerings.every(({ dataUse }) => dataUse !== "standard")
}

function projectTrainingRouteAvailability(
  state: ProviderModelEligibilityState,
  target: ProviderModelTarget,
  view: ProviderModelView,
  allowTrainingRoutes: boolean,
): ProviderModelView {
  if (allowTrainingRoutes) return view
  const account = state.targetAccounts.get(targetKey(target))
  const candidate = account === undefined ? undefined : state.inventoryCandidates.get(accessProviderAccountKey(account))
  return Object.freeze({
    ...view,
    rows: Object.freeze(view.rows.map((row) => contributorOnly(candidate?.inventoryOfferings?.get(row.modelId))
      ? Object.freeze({ ...row, unavailableReason: TRAINING_ROUTES_REQUIRED })
      : row)),
  })
}

function targetAccounts(profileId: string, candidates: ReadonlyMap<string, ProviderModelInventoryCandidate>): ReadonlyMap<string, AccessProviderAccountIdentity> {
  const accounts = new Map<string, AccessProviderAccountIdentity>()
  for (const candidate of candidates.values()) {
    const account: AccessProviderAccountIdentity = candidate.candidate.kind === "subscription"
      ? { kind: "subscription", providerId: candidate.candidate.providerId, instanceId: candidate.candidate.instanceId }
      : { kind: "singleton", providerId: candidate.candidate.providerId }
    accounts.set(targetKey(protocolTarget(profileId, account)), account)
  }
  return accounts
}

function protocolTarget(profileId: string, account: AccessProviderAccountIdentity): ProviderModelTarget {
  return account.kind === "singleton"
    ? account
    : { kind: "subscription", providerId: account.providerId, accountCorrelationId: subscriptionSpendAccountCorrelationId(profileId, account.providerId, account.instanceId) }
}

function targetKey(target: ProviderModelTarget): string {
  return target.kind === "singleton" ? `singleton:${target.providerId}` : `subscription:${target.providerId}:${target.accountCorrelationId}`
}

/** Newest models first so the curated (usually current) models sit at the top
 *  of long provider catalogs; undated models sort last, ties alphabetical. */
function byReleaseDateDescending(releaseDates: ReadonlyMap<string, string>): (a: string, b: string) => number {
  return (a, b) => {
    const dateA = releaseDates.get(a)
    const dateB = releaseDates.get(b)
    if (dateA !== dateB) {
      if (dateA === undefined) return 1
      if (dateB === undefined) return -1
      return dateB.localeCompare(dateA)
    }
    return a.localeCompare(b)
  }
}

function preferenceState(models: ResolvedProviderModels, modelId: string, checked: boolean, autoEnableNewModels: boolean): ProviderModelPreferenceState {
  if (!autoEnableNewModels) return checked ? "enabled" : "disabled"
  if (checked) return models.curatedDefault.has(modelId) ? "default" : "enabled"
  return "disabled"
}


function withAccountPreference(all: ReadonlyMap<string, ResolvedProviderModels>, account: AccessProviderAccountIdentity, modelId: string, state: ProviderModelPreferenceState, autoEnableNewModels = true): ReadonlyMap<string, ResolvedProviderModels> {
  const key = accessProviderAccountKey(account)
  const previous = all.get(key)
  if (!previous) return all
  const enabled = new Set(previous.enabled)
  const disabled = new Set(previous.disabled)
  enabled.delete(modelId)
  disabled.delete(modelId)
  if (state === "enabled") enabled.add(modelId)
  if (state === "disabled") disabled.add(modelId)
  const next = new Map(all)
  next.set(key, resolveAccountProviderModelPreferences(previous.catalog, previous.curatedDefault, { enabled, disabled }, autoEnableNewModels))
  return next
}

function withAutoEnableNewModels(all: ReadonlyMap<string, ResolvedProviderModels>, accounts: Iterable<AccessProviderAccountIdentity>, autoEnableNewModels: boolean): ReadonlyMap<string, ResolvedProviderModels> {
  const next = new Map(all)
  for (const account of accounts) {
    const key = accessProviderAccountKey(account)
    const previous = all.get(key)
    if (!previous) continue
    next.set(key, resolveAccountProviderModelPreferences(previous.catalog, previous.curatedDefault, transitionProviderAutoEnableNewModels(previous, previous.effective, previous.catalog, autoEnableNewModels), autoEnableNewModels))
  }
  return next
}

function withCandidatePreference(all: ReadonlyMap<string, ProviderModelInventoryCandidate>, account: AccessProviderAccountIdentity, models: ResolvedProviderModels | undefined): ReadonlyMap<string, ProviderModelInventoryCandidate> {
  const key = accessProviderAccountKey(account)
  const previous = all.get(key)
  if (!previous || !models) return all
  const next = new Map(all)
  next.set(key, { ...previous, enabledOfferings: nextEnabledOfferings(previous, models.effective, previous.preferFreeRoutes ?? false) })
  return next
}

function withFreeRoutePreference(
  all: ReadonlyMap<string, ProviderModelInventoryCandidate>,
  account: AccessProviderAccountIdentity,
  enabled: boolean,
  models: ResolvedProviderModels | undefined,
): ReadonlyMap<string, ProviderModelInventoryCandidate> {
  const key = accessProviderAccountKey(account)
  const previous = all.get(key)
  if (!previous || !models) return all
  const next = new Map(all)
  next.set(key, {
    ...previous,
    preferFreeRoutes: enabled,
    enabledOfferings: nextEnabledOfferings(previous, models.effective, enabled),
  })
  return next
}

/** An account without enabled offerings (auth-rejected or discovery failed) keeps none: editing its preferences must not add offerings to the provider aggregate. */
function nextEnabledOfferings(candidate: ProviderModelInventoryCandidate, enabledModels: ReadonlySet<string>, preferFreeRoutes: boolean): ReadonlyMap<string, readonly CatalogModelOffering[]> | null {
  const verified = candidate.verifiedModelIds
  const admittedModels = verified === undefined ? enabledModels : new Set([...enabledModels].filter((modelId) => verified.has(modelId)))
  return candidate.enabledOfferings === null ? null : eligibleOfferings(candidate.inventoryOfferings, admittedModels, preferFreeRoutes)
}

function eligibleOfferings(
  inventory: ReadonlyMap<string, readonly CatalogModelOffering[]> | null,
  enabledModels: ReadonlySet<string>,
  preferFreeRoutes: boolean,
): ReadonlyMap<string, readonly CatalogModelOffering[]> | null {
  if (inventory === null) return null
  return new Map([...inventory].flatMap(([modelId, offerings]) => {
    if (!enabledModels.has(modelId)) return []
    const eligible = preferFreeRoutes ? offerings : offerings.filter(({ routeKind }) => routeKind !== "free")
    return eligible.length === 0 ? [] : [[modelId, eligible] as const]
  }))
}

function deriveProviderCatalogs(candidates: ReadonlyMap<string, ProviderModelInventoryCandidate>): ReadonlyMap<string, ResolvedProviderModels> {
  const bases = new Map<string, ProviderModelCatalog>()
  for (const candidate of candidates.values()) {
    const enabledModels = [...candidate.enabledOfferings?.keys() ?? []]
    const base = bases.get(candidate.candidate.providerId)
    bases.set(candidate.candidate.providerId, {
      catalog: new Set([...(base?.catalog ?? []), ...enabledModels]),
      curatedDefault: new Set([...(base?.curatedDefault ?? []), ...enabledModels]),
    })
  }
  return new Map([...bases].map(([providerId, base]) => [providerId, {
    ...base,
    enabled: new Set(base.catalog),
    disabled: new Set<string>(),
    effective: new Set(base.catalog),
  }]))
}


function immutableCatalogs(source: ReadonlyMap<string, ResolvedProviderModels>): ReadonlyMap<string, ResolvedProviderModels> {
  return new Map([...source].map(([id, value]) => [id, Object.freeze({
    catalog: new Set(value.catalog),
    curatedDefault: new Set(value.curatedDefault),
    enabled: new Set(value.enabled),
    disabled: new Set(value.disabled),
    effective: new Set(value.effective),
  })]))
}

function immutableInventoryCandidates(source: ReadonlyMap<string, ProviderModelInventoryCandidate>): ReadonlyMap<string, ProviderModelInventoryCandidate> {
  return new Map([...source].map(([key, candidate]) => [key, Object.freeze({
    ...candidate,
    candidate: Object.freeze({ ...candidate.candidate }),
    catalog: Object.freeze({ ...candidate.catalog }),
    enabledOfferings: immutableOfferings(candidate.enabledOfferings),
    inventoryOfferings: immutableOfferings(candidate.inventoryOfferings),
    ...(candidate.preferFreeRoutes === undefined ? {} : { preferFreeRoutes: candidate.preferFreeRoutes }),
    ...(candidate.audit === undefined ? {} : { audit: Object.freeze({ ...candidate.audit }) }),
    ...(candidate.verifiedModelIds === undefined ? {} : { verifiedModelIds: new Set(candidate.verifiedModelIds) }),
  })]))
}

function enabledCandidateProjection(source: ReadonlyMap<string, ProviderModelInventoryCandidate>): ReadonlyMap<string, ProviderModelEnabledCandidate> {
  return new Map([...source].map(([key, value]) => [key, Object.freeze({
    candidate: value.candidate,
    configured: value.configured,
    currentConnection: value.currentConnection,
    enabledOfferings: value.enabledOfferings,
    catalog: value.catalog,
    ...(value.preferFreeRoutes === undefined ? {} : { preferFreeRoutes: value.preferFreeRoutes }),
    ...(value.idleFreePlan === undefined ? {} : { idleFreePlan: value.idleFreePlan }),
  })]))
}

function immutableOfferings(source: ReadonlyMap<string, readonly CatalogModelOffering[]> | null): ReadonlyMap<string, readonly CatalogModelOffering[]> | null {
  return source === null ? null : new Map([...source].map(([model, offerings]) => [
    model,
    Object.freeze([...offerings]),
  ]))
}
