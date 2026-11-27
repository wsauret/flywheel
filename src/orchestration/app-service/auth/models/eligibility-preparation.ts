import { resolveAuthContext, type AuthContext } from "../../../../infra/providers/auth/auth-context.js"
import { authStoreObservedRevision, type AuthStoreLoadResult } from "../../../../infra/providers/auth/store/auth-store.js"
import { AUTH_STORE_FILE } from "../../../../infra/providers/auth/store/auth-store-types.js"
import { openExistingAuthProfileDirectory } from "../../../../infra/providers/auth/store/auth-profile-store.js"
import { PROVIDER_MODEL_PREFERENCES_FILE, providerModelPreferencesRevision, type EligibilityInputRevision } from "../../../../infra/providers/auth/provider-models/provider-model-preference-store.js"
import type { KeyResolver } from "../../../../infra/providers/auth/resolve-key.js"
import type { LauncherScope } from "../../../../infra/process-supervisor.js"
import { resolveProviderModelCatalog } from "../../../config/models/model-assignment-providers.js"
import type { ProviderCatalogDiscovery } from "../../../../protocol/auth/provider-model-preference-protocol-types.js"
import { type FirstPartyModuleSnapshot, type FirstPartyModuleComposition, credentialSlotClassifier } from "../../../module-contract/module-catalog.js"
import type { ProviderModelEligibilitySnapshots, ProviderModelEligibilityState, ProviderModelInventoryCandidate } from "./provider-model-preference-service.js"
import { idleFreePlanAccounts, type IdleFreePlanMark, type PlanAccount, type PlanEvidence } from "../../../../infra/providers/llm/access/free-plan-accounts.js"
import { createUsageAuthority, type UsageAuthority } from "../../../../infra/providers/llm/usage/usage-authority.js"
import type { SubscriptionUsagePublishedSnapshot } from "../../../auth/provider-observations/subscription-usage-service.js"
import { deriveProviderModelPreferences } from "../../../../infra/providers/auth/provider-models/provider-model-preferences.js"
import type { ResolvedModelCatalog } from "../../../../infra/providers/llm/catalog/model-catalog-resolution.js"
import type { CatalogJsonValue, CatalogModelOffering } from "../../../../infra/providers/catalog-model-offering.js"
import { LISTING_SETTLEMENT_MS, type ModelDiscoveryMode } from "../../../../infra/providers/llm/access/model-listing.js"
import { awaitWithAbortSignal } from "../../../../infra/timing/abort.js"
import { errorMessage } from "../../../../infra/diagnostics/error-message.js"
import { Log } from "../../../../infra/diagnostics/log.js"
import { heldDirectoryDerivation } from "../../../../infra/platform/files/watched-directory-values.js"
import { createOrderedLane } from "../../../../infra/async/ordered-lane.js"
import { accessProviderRegistry } from "../../../config/models/access-provider-registry.js"
import type { ModelRefusalRecord } from "../../../agent-runtime/llm/routing/client-factory.js"
import { getSharedModelListingClient } from "../../../config/models/llm-clients.js"
import { providerModelsCanServeRequest } from "../../../config/models/provider-model-eligibility.js"
import { createDiscoveryCadence } from "./discovery-cadence.js"
import { type AccessProviderAccountIdentity, accessProviderAccountKey } from "../../../../infra/providers/auth/provider-account.js"

const log = Log.create({ service: "eligibility-preparation" })
const PROFILE_INPUT_PREPARATION_ATTEMPTS = 2
interface EligibilityPreparationDeps {
  readonly userDataRoot: string
  readonly resolveKey: KeyResolver
  readonly allowTrainingRoutes: (profileId: string) => boolean
  /** The providers that the profile's settings keep off (`profileOptIn`), read at each preparation. Their accounts
   *  read only their saved listing and never serve (ARCH-PROVIDERS-088). */
  readonly turnedOffProviders: (profileId: string) => ReadonlySet<string>
  /** The owner's launch authority, for a provider whose listing runs a local process. */
  readonly launcher?: LauncherScope
  readonly moduleSelection: FirstPartyModuleSnapshot
  readonly prepare: ProviderModelEligibilitySnapshots["prepare"]
  readonly publish: ProviderModelEligibilitySnapshots["publish"]
  readonly current: ProviderModelEligibilitySnapshots["state"]
  readonly inputRevision: (profile: EligibilityProfile) => EligibilityInputRevision
  readonly resolveAuth?: (profile: EligibilityProfile, signal: AbortSignal) => Promise<AuthContext>
  readonly resolveCatalog?: typeof resolveProviderModelCatalog
  readonly refreshMetadata?: (signal: AbortSignal) => Promise<void>
  readonly now?: () => number
  /** Opens the profile's usage authority, which keeps the plan of each account's latest usage reading. */
  readonly openUsage?: (profile: EligibilityProfile) => Pick<UsageAuthority, "current" | "dispose">
  /** Brings the profile's files to the shape this release writes before any read. */
  readonly normalizeProfile?: (profile: EligibilityProfile, signal: AbortSignal) => Promise<void>
  readonly observeAuth: (profile: EligibilityProfile) => AuthStoreLoadResult
  /** Saves a refusal that a request proved; the process-shared listing of the profile by default. Resolves false
   *  when nothing was saved. */
  readonly saveModelRefusal?: (record: ModelRefusalRecord) => Promise<boolean>
  /** Brings a state that background work published to the profile's sessions: a discovery that ended with a new
   *  state, or a saved refusal. Nothing waits for it, and a failure is a warning. */
  readonly apply?: (profileId: string) => Promise<void>
  /** How long a caller about to route requests waits for the access audit after the listing; the listing's own
   *  settlement deadline by default. */
  readonly settlementTimeoutMs?: number
  /** How long a profile goes without discovery before background discovery runs; an hour by default. */
  readonly backgroundDiscoveryIntervalMs?: number
  /** Whether the owner still holds the profile open, which background discovery asks each time it is due. An owner
   *  that gives none runs no background discovery. */
  readonly holdsProfile?: (profile: EligibilityProfile) => boolean
}

interface EligibilityProfile {
  readonly id: string
  readonly directory: string
}

/** Publishes saved-only views while an audit probes. A result's publication
 *  completes before the next probe, so no committed intermediate state is skipped. */
interface AuditProjection {
  readonly notify: () => Promise<void>
  readonly settled: () => Promise<void>
}

/** Marks a preparation that belongs to an owned audit; `projection` is present only for the probing pass, and `recheck` scopes the pass to one exact account the user asked to probe again. */
interface AuditRun {
  readonly projection?: AuditProjection
  readonly recheck?: AccessProviderAccountIdentity
}

interface EligibilityPreparationOptions {
  readonly refreshSavedCatalogs?: boolean
  /** Forced modes only: probing is owned background work that follows them, never a mode a caller awaits. */
  readonly mode?: Exclude<ModelDiscoveryMode, "audit">
  readonly force?: boolean
  readonly signal?: AbortSignal
  /** Resolve once the owned discovery has listed every account. A cached-first
   * state is published at once for display, but an account with no saved catalog
   * is still pending, and a caller that is about to route requests waits for the
   * listing that settles it instead of reading an account as unusable. The access
   * audit that follows the listing is background work: the caller waits for it
   * only while no account can serve a request, until one can, and for at most
   * the listing's settlement deadline. */
  readonly settled?: boolean
  /** A forced login listing retains its admitted providers; later background discovery uses the live selection. */
  readonly composition?: FirstPartyModuleComposition
}

/** Builds and publishes one profile-bound eligibility state. Saved catalogs
 * satisfy the initial call and remain available while a forced refresh fails. */
export interface EligibilityPreparation {
  (profile: EligibilityProfile, options?: EligibilityPreparationOptions): Promise<ProviderModelEligibilityState>
  /** Captures inputs against validated eligibility. The synchronous callback may run again if auth or preferences change. Saved-only mode reads cached catalogs without scheduling discovery or audits; the default waits for discovery when no usable catalog exists. Cancellation rejects the capture without cancelling shared preparation or key resolution. */
  capture<T>(profile: EligibilityProfile, capture: (state: ProviderModelEligibilityState, auth: AuthContext, composition: FirstPartyModuleComposition) => T, signal?: AbortSignal, mode?: "saved-only"): Promise<T>
  /** Schedules catalog-only discovery without waiting for the network. Active work
   * is shared; attempts, including failures, hold for five minutes from admission.
   * Throws after disposal. Saved eligibility remains readable throughout. */
  scheduleRefresh(profile: EligibilityProfile): void
  /** Queues a manual recheck of one exact subscription account: every current candidate of that account is probed again, while saved outcomes stay until a conclusive result replaces them, and no other account is probed. It supersedes an active audit and follows any owned discovery, ignores the five-minute hold, and returns without waiting for probes. Throws after disposal, and throws when `expected` is not the profile's current input revision. The queued work drops itself, without writing, publishing, or probing, when the inputs change before it starts; the store refuses a stale credential lineage under its lock. */
  recheckAccount(profile: EligibilityProfile, account: AccessProviderAccountIdentity, expected: EligibilityInputRevision): void
  /** Publishes the profile's saved evidence again with unchanged inputs, after any owned discovery: a request proved a
   *  refusal that the saved catalog now holds, and the next request must read it. It probes and fetches nothing. The
   *  published state has a new revision, so a provider adapter that a previous state built is not reused. */
  republish(profile: EligibilityProfile): Promise<void>
  /** Publishes the profile's state again with new free-plan marks, and applies it to its sessions, when the plans of
   *  a usage publication change which free-plan accounts may serve (PI-MODEL-038). It reads only the publication,
   *  never a durable store, and does nothing when the published state already agrees. */
  reconcileFreePlans(profile: EligibilityProfile, publication: SubscriptionUsagePublishedSnapshot | undefined): Promise<void>
  /** Saves a refusal that a request proved for its exact account lineage and republishes the profile, so the
   *  refused model leaves the eligibility and a refused extended window narrows to the standard one, then applies
   *  that state to the profile's sessions. It returns at once, the request does not wait, and a failure is a warning. */
  recordModelRefusal(record: ModelRefusalRecord): void
  /** Resolves when the profile's owned discovery, its listing and its access audit, has ended, and at once when none
   *  runs. Rejects with the discovery's error, or with the reason of `signal` when it aborts first; the discovery
   *  itself continues. */
  awaitDiscovery(profile: EligibilityProfile, signal: AbortSignal): Promise<void>
  dispose(): Promise<void>
}

/** Where one owned discovery stands. Its access audit starts only from `listing`, so a forced run that arrives
 *  first keeps the audit from starting, and one that arrives later aborts it. */
type DiscoveryStep =
  | { readonly kind: "listing" }
  | { readonly kind: "auditing"; readonly superseded: AbortController }
  /** `by` is the discovery that takes over the audit, and the readiness that this one has not reached. */
  | { readonly kind: "superseded"; readonly by: OwnedDiscovery }

/** `audit-started`: the discovery reached its audit. `forced-run`: a login or forced refresh supersedes the audit,
 *  started or not, because the forced run's own discovery audits after it. `recheck`: a manual recheck supersedes
 *  only an audit that runs, and otherwise follows the discovery. */
type DiscoveryEvent = { readonly kind: "audit-started" } | { readonly kind: "forced-run" | "recheck"; readonly by: OwnedDiscovery }

function nextDiscoveryStep(step: DiscoveryStep, event: DiscoveryEvent): DiscoveryStep {
  if (step.kind === "superseded") return step
  if (event.kind === "audit-started") return step.kind === "listing" ? { kind: "auditing", superseded: new AbortController() } : step
  if (step.kind === "auditing" || event.kind === "forced-run") return { kind: "superseded", by: event.by }
  return step
}

/** A manual recheck of one account, with the inputs it was asked against. */
interface QueuedRecheck { readonly account: AccessProviderAccountIdentity; readonly expected: EligibilityInputRevision }

/** One owned background discovery of a profile: the listing, then the access audit. */
interface OwnedDiscovery {
  /** Written only by `advanceDiscovery`. */
  step: DiscoveryStep
  /** Present when the audit is a manual recheck, which the store arms only when the audit starts. */
  readonly recheck?: QueuedRecheck
  /** Every step of the discovery. Later owned work for the profile orders after it. */
  readonly done: Promise<ProviderModelEligibilityState>
  /** The first state that a caller about to route requests can use: the listing is
   *  published and some account can serve a request, the settlement deadline after
   *  the listing has passed, or the discovery has ended. A superseded discovery
   *  ends without its audit, so its successor's readiness stands in for that end. */
  readonly ready: Promise<ProviderModelEligibilityState>
}

export function createEligibilityPreparation(deps: EligibilityPreparationDeps): EligibilityPreparation {
  const canServeRequest = (state: ProviderModelEligibilityState): boolean =>
    providerModelsCanServeRequest(state.enabledCandidates.values(), deps.allowTrainingRoutes(state.profileId))
  const cachedPreparations = new Map<string, Promise<ProviderModelEligibilityState>>()
  /** The profile's owned discoveries that have not ended, oldest first. Each one orders after the one before it. */
  const discoveries = new Map<string, readonly OwnedDiscovery[]>()
  const latestDiscovery = (profileId: string): OwnedDiscovery | undefined => discoveries.get(profileId)?.at(-1)
  /** The one writer of a discovery step; returns the new step. Leaving `auditing` aborts the audit. */
  const advanceDiscovery = (discovery: OwnedDiscovery, event: DiscoveryEvent): DiscoveryStep => {
    const previous = discovery.step
    discovery.step = nextDiscoveryStep(previous, event)
    if (previous.kind === "auditing" && discovery.step.kind !== "auditing") previous.superseded.abort(new DOMException("Audit superseded", "AbortError"))
    return discovery.step
  }
  /** Supersedes the audits of every owned discovery of the profile other than `event.by`, and returns the manual
   *  rechecks whose audit had not started, so the store never armed them; the caller queues them again. */
  const supersedeAudits = (profileId: string, event: Exclude<DiscoveryEvent, { readonly kind: "audit-started" }>): readonly QueuedRecheck[] => {
    const unarmed: QueuedRecheck[] = []
    for (const discovery of discoveries.get(profileId) ?? []) {
      if (discovery === event.by) continue
      const before = discovery.step.kind
      const after = advanceDiscovery(discovery, event)
      if (before === "listing" && after.kind === "superseded" && discovery.recheck !== undefined) unarmed.push(discovery.recheck)
    }
    return unarmed
  }
  const controllers = new Map<Promise<unknown>, AbortController>()
  const now = deps.now ?? Date.now
  const settlementTimeoutMs = deps.settlementTimeoutMs ?? LISTING_SETTLEMENT_MS
  let closed = false
  let disposal: Promise<void> | undefined
  const cadence = createDiscoveryCadence<EligibilityProfile>(now, (profile) => prepareEligibility.scheduleRefresh(profile), (profile) => deps.holdsProfile?.(profile) === true, deps.backgroundDiscoveryIntervalMs)
  const resolveAuth = (profile: EligibilityProfile, signal: AbortSignal, composition: FirstPartyModuleComposition, load = deps.observeAuth(profile)) =>
    deps.resolveAuth?.(profile, signal) ?? resolveAuthContext({ authDir: profile.directory, resolveKey: deps.resolveKey, load, definitions: accessProviderRegistry(composition).selection.definitions, credentialSlotClassifier: credentialSlotClassifier(composition) })
  const definitionOf = (composition: FirstPartyModuleComposition) => {
    const { definitions } = accessProviderRegistry(composition).selection
    return (providerId: string) => definitions.find(({ id }) => id === providerId)
  }
  /** The free-plan accounts of the profile that sit beside another account of their provider (PI-MODEL-038), from the
   *  latest usage reading of each account's current identity. A preparation runs on an input change, a discovery or
   *  an audit result, not per request, so it may read the usage authority, and it opens it only when a provider with
   *  a free plan holds more than one account. */
  const idleFreePlans = (profile: EligibilityProfile, auth: AuthContext, composition: FirstPartyModuleComposition, previous: ReadonlyMap<string, IdleFreePlanMark>): ReadonlyMap<string, IdleFreePlanMark> => {
    let usage: Pick<UsageAuthority, "current" | "dispose"> | undefined
    let failed = false
    const evidence = ({ identity, ...account }: PlanAccount): PlanEvidence => {
      if (identity === undefined) return { kind: "unavailable" }
      try {
        usage ??= (deps.openUsage ?? openProfileUsage)(profile)
        const reading = usage.current({ ...account, identity })
        return reading === undefined ? { kind: "unavailable" } : { kind: "read", reading }
      } catch (error) {
        if (!failed) log.info("free-plan accounts keep their marks because the usage authority was not read", { profileId: profile.id, error: errorMessage(error) })
        failed = true
        return { kind: "unavailable" }
      }
    }
    try {
      const accounts = [...auth.subscriptionCredentials ?? []].flatMap(([providerId, captured]) => captured.map(({ instanceId, identity }) => ({ providerId, instanceId, ...(identity === undefined ? {} : { identity }) })))
      return idleFreePlanAccounts(accounts, evidence, definitionOf(composition), previous)
    } finally {
      usage?.dispose()
    }
  }
  /** Whether `state` was prepared from the profile's current inputs: its auth and preference revisions, and the
   *  providers that its settings keep off, so a state prepared before a provider turned on or off never serves. */
  const isCurrent = (profile: EligibilityProfile, state: ProviderModelEligibilityState): boolean =>
    sameInputRevision(state.inputRevision, deps.inputRevision(profile)) && marksTurnedOff(state, deps.turnedOffProviders(profile.id))
  const prepare = async (profile: EligibilityProfile, discoveryMode: ModelDiscoveryMode, signal: AbortSignal, audit?: AuditRun, capturedComposition?: FirstPartyModuleComposition): Promise<ProviderModelEligibilityState> => {
    for (let attempt = 0; attempt < PROFILE_INPUT_PREPARATION_ATTEMPTS; attempt += 1) {
      signal.throwIfAborted()
      const initialState = deps.current(profile.id)
      const observed = deps.observeAuth(profile)
      if (observed.conditions.length === 0) await deps.normalizeProfile?.(profile, signal)
      signal.throwIfAborted()
      const inputRevision = deps.inputRevision(profile)
      const composition = capturedComposition ?? deps.moduleSelection()
      const turnedOff = deps.turnedOffProviders(profile.id)
      const auth = await resolveAuth(profile, signal, composition)
      signal.throwIfAborted()
      const resolved = await (deps.resolveCatalog ?? resolveProviderModelCatalog)({ userDataRoot: deps.userDataRoot, authDirectory: () => profile.directory, moduleSelection: () => composition, auth, discoveryMode, signal, savedOnlyProviders: turnedOff, ...(deps.launcher === undefined ? {} : { launcher: deps.launcher }), ...(audit?.projection === undefined ? {} : { onAccessAudit: audit.projection.notify }), ...(audit?.recheck === undefined ? {} : { recheckAccount: audit.recheck }) })
      // Every projected result publishes before this final state, so an older view never replaces it.
      await audit?.projection?.settled()
      signal.throwIfAborted()
      if (!sameInputRevision(inputRevision, deps.inputRevision(profile)) || !sameProviders(turnedOff, deps.turnedOffProviders(profile.id))) {
        continue
      }
      const current = deps.current(profile.id)
      if (discoveryMode === "cached-first" && current !== initialState) {
        if (current !== undefined && sameInputRevision(current.inputRevision, inputRevision) && marksTurnedOff(current, turnedOff)) return current
        continue
      }
      const accounts = new Map(resolved.accounts)
      let reused = false
      const inventoryCandidates = new Map([...resolved.inventoryCandidates].map(([key, candidate]) => {
        const discovery = catalogDiscovery(candidate.outcome)
        // First-party fallback is not saved as a successful listing. An audit must keep
        // its settled account evidence, not just its label, within the same input revision.
        const kept = audit !== undefined && current !== undefined && sameInputRevision(current.inputRevision, inputRevision) && marksTurnedOff(current, turnedOff)
          && candidate.audit === undefined && discovery.kind === "unavailable" && discovery.reason === "discovery-pending"
          ? current.inventoryCandidates.get(key)
          : undefined
        if (kept !== undefined && !(kept.catalog.kind === "unavailable" && kept.catalog.reason === "discovery-pending")) {
          const accountKey = accessProviderAccountKey(candidate.candidate)
          const account = current?.accountCatalogs.get(accountKey)
          if (account !== undefined) accounts.set(accountKey, account)
          reused = true
          return [key, kept]
        }
        return [key, {
          candidate: candidate.candidate,
          configured: candidate.configured,
          currentConnection: candidate.currentConnection,
          enabledOfferings: candidate.enabledOfferings,
          inventoryOfferings: candidate.inventoryOfferings,
          ...(candidate.preferFreeRoutes === undefined ? {} : { preferFreeRoutes: candidate.preferFreeRoutes }),
          ...(candidate.audit === undefined ? {} : { audit: candidate.audit }),
          ...(candidate.verifiedModelIds === undefined ? {} : { verifiedModelIds: candidate.verifiedModelIds }),
          catalog: discovery,
        }]
      }))
      const catalogs = reused
        ? new Map([...deriveProviderModelPreferences(resolved.providers, [...inventoryCandidates.values()].flatMap((candidate) => {
          const account = accounts.get(accessProviderAccountKey(candidate.candidate))
          return account === undefined ? [] : [[candidate.candidate, {
            ...account,
            effective: new Set(candidate.enabledOfferings?.keys()),
          }] as const]
        }))].map(([providerId, models]) => [providerId, { ...models, catalog: models.effective, curatedDefault: models.effective }]))
        : resolved.providers
      const releaseDates = resolveReleaseDates(inventoryCandidates)
      const idle = idleFreePlans(profile, auth, composition, idleOf(current))
      signal.throwIfAborted()
      const state = deps.prepare({ profileId: profile.id, autoEnableNewModels: resolved.autoEnableNewModels, inputRevision, catalogs: new Map(catalogs), accountCatalogs: accounts, inventoryCandidates: withIdleFreePlans(withTurnedOff(inventoryCandidates, turnedOff), idle), releaseDates })
      signal.throwIfAborted()
      deps.publish(state)
      return state
    }
    throw new Error("auth profile inputs did not stabilize during provider-model eligibility preparation")
  }
  const settle = async (profile: EligibilityProfile, published: Promise<ProviderModelEligibilityState>, options?: EligibilityPreparationOptions): Promise<ProviderModelEligibilityState> => {
    const state = await published
    if (options?.settled !== true || !hasPendingDiscovery(state)) return state
    const running = latestDiscovery(profile.id)
    // A discovery that ends pending publishes a new state, and the sessions that take it admit settled again, so
    // only the cooldown keeps a state that stays pending from discovering without end (PI-MODEL-046).
    if (running === undefined && cadence.coolingDown(profile)) return state
    return awaitWithAbortSignal((running ?? discoverAfter(profile, Promise.resolve(state), "pending")).ready, options.signal)
  }
  /** Serializes saved-only publications after conclusive probes. Each probe
   * waits for its own complete profile view before another result can commit. */
  const auditProjection = (profile: EligibilityProfile, signal: AbortSignal, published: (state: ProviderModelEligibilityState) => void): AuditProjection => {
    const publications = createOrderedLane()
    return {
      notify: () => publications.run(async () => {
        try {
          published(await prepare(profile, "cached-first", signal, {}))
        } catch (error) {
          if (!signal.aborted) log.warn("audit progress was not published", { profileId: profile.id, error: errorMessage(error) })
        }
      }),
      settled: publications.settled,
    }
  }
  /** Probes what saved audits leave due, and checks refused models again, and returns the final state; `published`
   * receives each state that a conclusive probe published. A forced run
   * supersedes it without an error: results already committed persist and the
   * next audit resumes with the remainder. */
  const audit = async (profile: EligibilityProfile, discovery: OwnedDiscovery, state: ProviderModelEligibilityState, signal: AbortSignal, published: (state: ProviderModelEligibilityState) => void, recheck?: AccessProviderAccountIdentity): Promise<ProviderModelEligibilityState> => {
    if (recheck === undefined && ![...state.inventoryCandidates.values()].some((candidate) => (candidate.audit?.remaining ?? 0) > 0 || (candidate.audit?.refused ?? 0) > 0)) return state
    const step = advanceDiscovery(discovery, { kind: "audit-started" })
    if (step.kind !== "auditing") return state
    const { superseded } = step
    const auditSignal = AbortSignal.any([signal, superseded.signal])
    const projection = auditProjection(profile, auditSignal, published)
    try {
      return await prepare(profile, "audit", auditSignal, { projection, ...(recheck === undefined ? {} : { recheck }) })
    } catch (error) {
      if (superseded.signal.aborted && !signal.aborted) return deps.current(profile.id) ?? state
      throw error
    } finally {
      await projection.settled()
    }
  }
  /** Owns one background discovery for the profile. With `refresh`, it first
   * refreshes metadata and fetches every provider listing; the audit then probes
   * what listing left due. Without it, only the audit follows `operation`; a
   * `recheck` account limits that audit to it and probes it again in full. A
   * discovery that ends with a new state applies it to the profile's sessions. */
  const discoverAfter = (profile: EligibilityProfile, operation: Promise<ProviderModelEligibilityState>, refresh: boolean | "pending", recheck?: QueuedRecheck): OwnedDiscovery => {
    if (refresh !== "pending") cadence.admit(profile)
    const refreshController = new AbortController()
    const ready = Promise.withResolvers<ProviderModelEligibilityState>()
    // Only a settled caller observes readiness, so an unobserved failure is not an unhandled rejection.
    ready.promise.catch(() => {})
    let deadline: ReturnType<typeof setTimeout> | undefined
    const readied = (state: ProviderModelEligibilityState): void => {
      clearTimeout(deadline)
      ready.resolve(state)
    }
    const published = (state: ProviderModelEligibilityState): void => {
      if (canServeRequest(state)) readied(state)
    }
    let started: ProviderModelEligibilityState | undefined
    // The refresh settles every account the saved evidence left pending.
    // Failure publishes a terminal view while preserving the caller's error.
    const discover = async (): Promise<ProviderModelEligibilityState> => {
      // A forced run reports its own failure; only what follows it is discovery.
      let forcedRunPending = !refresh
      try {
        const settled = await operation
        forcedRunPending = false
        started = settled
        refreshController.signal.throwIfAborted()
        if (refresh === "pending" && !hasPendingDiscovery(settled)) return settled
        if (refresh === "pending") cadence.admit(profile)
        if (refresh) await deps.refreshMetadata?.(refreshController.signal)
        refreshController.signal.throwIfAborted()
        const listed = refresh ? await prepare(profile, "refresh", refreshController.signal) : settled
        published(listed)
        // A first message never waits minutes for probes: past the deadline, routing proceeds with the listing.
        if (!canServeRequest(listed)) deadline = setTimeout(() => {
          log.info("request routing proceeds without the access audit at the settlement deadline", { profileId: profile.id, deadlineMs: settlementTimeoutMs })
          ready.resolve(listed)
        }, settlementTimeoutMs)
        return await audit(profile, discovery, listed, refreshController.signal, published, recheck?.account)
      } catch (error) {
        if (!closed && !forcedRunPending) {
          const current = deps.current(profile.id)
          if (latestDiscovery(profile.id) === discovery && current !== undefined && hasPendingDiscovery(current)) {
            const failed = deps.prepare({
              profileId: current.profileId,
              autoEnableNewModels: current.autoEnableNewModels,
              catalogs: current.catalogs,
              accountCatalogs: current.accountCatalogs,
              inputRevision: current.inputRevision,
              releaseDates: current.releaseDates,
              inventoryCandidates: new Map([...current.inventoryCandidates].map(([key, candidate]) => [
                key,
                candidate.catalog.kind === "unavailable" && candidate.catalog.reason === "discovery-pending"
                  ? { ...candidate, catalog: { kind: "unavailable" as const, reason: "discovery-failed" as const } }
                  : candidate,
              ])),
            })
            deps.publish(failed)
          }
          log.warn("provider catalog discovery failed after the saved catalogs were published", { profileId: profile.id, error: errorMessage(error) })
        }
        throw error
      }
    }
    const refreshOperation = discover()
    controllers.set(refreshOperation, refreshController)
    const discovery: OwnedDiscovery = { step: { kind: "listing" }, done: refreshOperation, ready: ready.promise, ...(recheck === undefined ? {} : { recheck }) }
    discoveries.set(profile.id, [...discoveries.get(profile.id) ?? [], discovery])
    // A superseded discovery ends without the audit that its readiness waited for, so the discovery that took the
    // audit over decides that readiness. Its own deadline still bounds the wait, and when the successor fails the
    // caller reads this discovery's own state instead of the other run's error.
    const readiness = async (): Promise<ProviderModelEligibilityState> => {
      const state = await refreshOperation
      const { step } = discovery
      return step.kind === "superseded" ? step.by.ready.catch(() => state) : state
    }
    void readiness().then(readied, (error: unknown) => {
      clearTimeout(deadline)
      ready.reject(error)
    })
    const release = () => {
      controllers.delete(refreshOperation)
      const remaining = (discoveries.get(profile.id) ?? []).filter((owned) => owned !== discovery)
      if (remaining.length === 0) discoveries.delete(profile.id)
      else discoveries.set(profile.id, remaining)
    }
    // The sessions take the new state after the release, so a session admission
    // that this starts never waits for this discovery.
    void refreshOperation.then(release, release).then(() => {
      if (!closed && started !== undefined && deps.current(profile.id) !== started) applyToSessions(profile.id)
    })
    return discovery
  }
  const applyToSessions = (profileId: string): void => {
    void deps.apply?.(profileId).catch((error: unknown) => {
      if (!closed) log.warn("a published eligibility did not reach the sessions", { profileId, error: errorMessage(error) })
    })
  }
  const prepareEligibility = (profile: EligibilityProfile, options?: EligibilityPreparationOptions): Promise<ProviderModelEligibilityState> => {
    if (closed) return Promise.reject(new Error("eligibility preparation is disposed"))
    const discoveryMode = options?.mode ?? (options?.force === true ? "refresh" : "cached-first")
    if (discoveryMode === "cached-first") {
      const current = deps.current(profile.id)
      if (current && isCurrent(profile, current)) return settle(profile, Promise.resolve(current), options)
    }
    const existing = cachedPreparations.get(profile.id)
    if (existing && discoveryMode === "cached-first") return settle(profile, awaitWithAbortSignal(existing, options?.signal), options)
    const controller = new AbortController()
    const initialPreparation = deps.current(profile.id) === undefined
    // Forced account/auth changes must run after any catalog discovery already
    // owned here, rather than racing its publication. A forced run supersedes
    // the audits of those discoveries below, so each one ends with its listing.
    const preceding = discoveryMode === "cached-first" ? undefined : latestDiscovery(profile.id)?.done ?? existing
    const execute = () => {
      controller.signal.throwIfAborted()
      if (discoveryMode !== "cached-first") cadence.admit(profile)
      return prepare(profile, discoveryMode, controller.signal, undefined, options?.composition)
    }
    const operation = preceding === undefined ? execute() : preceding.then(execute, execute)
    controllers.set(operation, controller)
    if (discoveryMode === "cached-first") cachedPreparations.set(profile.id, operation)
    const release = () => {
      controllers.delete(operation)
      if (cachedPreparations.get(profile.id) === operation) cachedPreparations.delete(profile.id)
    }
    void operation.then(release, release)
    if (discoveryMode === "cached-first" && !discoveries.has(profile.id)) discoverAfter(profile, operation, initialPreparation || options?.refreshSavedCatalogs === true ? true : "pending")
    // A login or account change returns once the listing is validated; probing continues in the background.
    else if (discoveryMode !== "cached-first") {
      // The forced run's own discovery takes over every earlier audit, started or not, and leaves the committed
      // results in place for it to resume. A recheck that it supersedes before its audit armed it queues again
      // behind the forced run, and drops itself, as any queued recheck does, when the forced run changed the
      // inputs it was asked against.
      const successor = discoverAfter(profile, operation, false)
      for (const recheck of supersedeAudits(profile.id, { kind: "forced-run", by: successor })) {
        try {
          prepareEligibility.recheckAccount(profile, recheck.account, recheck.expected)
        } catch (error) {
          log.info("manual provider-model recheck dropped because the auth profile inputs changed", { profileId: profile.id, error: errorMessage(error) })
        }
      }
    }
    return settle(profile, awaitWithAbortSignal(operation, options?.signal), options)
  }
  prepareEligibility.scheduleRefresh = (profile: EligibilityProfile): void => {
    if (closed) throw new Error("eligibility preparation is disposed")
    if (cachedPreparations.has(profile.id) || discoveries.has(profile.id)) return
    if (cadence.coolingDown(profile)) return
    const current = deps.current(profile.id)
    if (current === undefined) {
      // discoverAfter owns failure reporting and terminal pending-catalog publication.
      void prepareEligibility(profile, { refreshSavedCatalogs: true }).catch(() => {})
    } else {
      discoverAfter(profile, Promise.resolve(current), true)
    }
  }
  prepareEligibility.recheckAccount = (profile: EligibilityProfile, account: AccessProviderAccountIdentity, expected: EligibilityInputRevision): void => {
    if (closed) throw new Error("eligibility preparation is disposed")
    if (!sameInputRevision(expected, deps.inputRevision(profile))) throw new Error("provider-model recheck was requested against stale auth profile inputs")
    const preceding = latestDiscovery(profile.id)?.done ?? cachedPreparations.get(profile.id)
    const admit = (): Promise<ProviderModelEligibilityState> => {
      const current = deps.current(profile.id)
      if (current === undefined || !sameInputRevision(expected, deps.inputRevision(profile))) {
        log.info("manual provider-model recheck dropped because the auth profile inputs changed", { profileId: profile.id })
        return Promise.reject(new Error("provider-model recheck dropped"))
      }
      return Promise.resolve(current)
    }
    const successor = discoverAfter(profile, preceding === undefined ? Promise.resolve().then(admit) : preceding.then(admit, admit), false, { account, expected })
    // Committed probe results persist; the recheck makes every candidate due again, so an active audit has nothing
    // left to finish first, and a discovery that has not reached its audit is followed instead.
    supersedeAudits(profile.id, { kind: "recheck", by: successor })
  }
  prepareEligibility.republish = (profile: EligibilityProfile): Promise<void> => {
    if (closed) return Promise.reject(new Error("eligibility preparation is disposed"))
    const controller = new AbortController()
    const execute = () => prepare(profile, "cached-first", controller.signal, {})
    const preceding = latestDiscovery(profile.id)?.done ?? cachedPreparations.get(profile.id)
    const operation = preceding === undefined ? execute() : preceding.then(execute, execute)
    controllers.set(operation, controller)
    void operation.then(() => controllers.delete(operation), () => controllers.delete(operation))
    return operation.then(() => undefined)
  }
  prepareEligibility.reconcileFreePlans = async (profile: EligibilityProfile, publication: SubscriptionUsagePublishedSnapshot | undefined): Promise<void> => {
    const state = deps.current(profile.id)
    if (state === undefined || publication === undefined || closed) return
    // The usage service reads each account as its current identity, so a snapshot in the publication is that
    // identity's latest reading; an account the publication does not read is still the identity its mark was
    // decided for, and keeps the mark.
    const observed = new Map(publication.accounts.flatMap((entry) => "snapshot" in entry && entry.snapshot !== undefined
      ? [[accessProviderAccountKey({ kind: "subscription", providerId: entry.account.providerId, instanceId: entry.account.instanceId }), entry] as const]
      : []))
    const evidence = (account: PlanAccount): PlanEvidence => {
      const snapshot = observed.get(accessProviderAccountKey({ kind: "subscription", ...account }))?.snapshot
      return snapshot === undefined ? { kind: "unavailable" } : { kind: "read", reading: snapshot }
    }
    const previous = idleOf(state)
    const accounts = [...state.inventoryCandidates.values()].flatMap(({ candidate }) => {
      if (candidate.kind !== "subscription") return []
      const key = accessProviderAccountKey(candidate)
      const identity = observed.has(key) ? observed.get(key)?.account.identity : previous.get(key)?.identity
      return [{ providerId: candidate.providerId, instanceId: candidate.instanceId, ...(identity === undefined ? {} : { identity }) }]
    })
    const desired = idleFreePlanAccounts(accounts, evidence, definitionOf(deps.moduleSelection()), previous)
    if (sameMarks(desired, previous)) return
    log.info("free-plan accounts changed", { profileId: profile.id, idle: desired.size, previous: previous.size })
    deps.publish(deps.prepare({
      profileId: state.profileId, autoEnableNewModels: state.autoEnableNewModels, catalogs: state.catalogs, accountCatalogs: state.accountCatalogs,
      inputRevision: state.inputRevision, releaseDates: state.releaseDates,
      inventoryCandidates: withIdleFreePlans(state.inventoryCandidates, desired),
    }))
    await deps.apply?.(profile.id)
  }
  prepareEligibility.recordModelRefusal = (record: ModelRefusalRecord): void => {
    const profile = { id: record.connection.profileId, directory: record.connection.authDir }
    void (async () => {
      if (closed || !await (deps.saveModelRefusal ?? saveThroughSharedListing)(record) || closed) return
      await prepareEligibility.republish(profile)
      await deps.apply?.(profile.id)
    })().catch((error: unknown) => {
      if (!closed) log.warn("a saved model refusal did not reach the eligibility", { profileId: profile.id, error: errorMessage(error) })
    })
  }
  prepareEligibility.awaitDiscovery = async (profile: EligibilityProfile, signal: AbortSignal): Promise<void> => {
    const discovery = latestDiscovery(profile.id)
    if (discovery !== undefined) await awaitWithAbortSignal(discovery.done, signal)
  }
  const saveThroughSharedListing = ({ connection, candidate, wireModelId, refusal }: ModelRefusalRecord): Promise<boolean> => {
    // A connection that may not write its profile saves nothing.
    if (connection.oauthPersistence === "access-only") return Promise.resolve(false)
    return getSharedModelListingClient(deps.userDataRoot, connection.authDir, deps.moduleSelection()).recordModelRefusal({
      auth: connection.auth, subscriptions: connection.subscriptionCredentials, candidate, wireModelId, refusal,
    })
  }
  prepareEligibility.capture = <T>(profile: EligibilityProfile, capture: (state: ProviderModelEligibilityState, auth: AuthContext, composition: FirstPartyModuleComposition) => T, callerSignal?: AbortSignal, mode?: "saved-only"): Promise<T> => {
    if (closed) return Promise.reject(new Error("eligibility preparation is disposed"))
    const controller = new AbortController()
    const signal = callerSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, callerSignal])
    const operation = (async () => {
      for (let attempt = 0; attempt < PROFILE_INPUT_PREPARATION_ATTEMPTS; attempt += 1) {
        signal.throwIfAborted()
        let state = deps.current(profile.id)
        if (state === undefined || !isCurrent(profile, state)) {
          state = mode === "saved-only"
            ? await prepare(profile, "cached-first", signal)
            : await prepareEligibility(profile, { signal })
        }
        if (mode !== "saved-only" && !canServeRequest(state)) {
          state = await settle(profile, awaitWithAbortSignal(cachedPreparations.get(profile.id) ?? prepareEligibility(profile, { signal }), signal), { signal, settled: true })
        }
        const composition = deps.moduleSelection()
        const auth = await awaitWithAbortSignal(resolveAuth(profile, signal, composition), signal)
        signal.throwIfAborted()
        const result = capture(state, auth, composition)
        if (isCurrent(profile, state)) return result
      }
      throw new Error("auth profile inputs did not stabilize during provider-model read capture")
    })()
    controllers.set(operation, controller)
    void operation.then(() => controllers.delete(operation), () => controllers.delete(operation))
    return operation
  }
  prepareEligibility.dispose = (): Promise<void> => {
    if (disposal) return disposal
    closed = true
    cadence.dispose()
    const operations = [...controllers.keys()]
    for (const controller of controllers.values()) controller.abort(new DOMException("Eligibility preparation disposed", "AbortError"))
    disposal = Promise.allSettled(operations).then(() => {
      cachedPreparations.clear()
      discoveries.clear()
      controllers.clear()
    })
    return disposal
  }
  return prepareEligibility
}

const openProfileUsage = (profile: EligibilityProfile): UsageAuthority => createUsageAuthority({ profileDir: profile.directory, profileId: profile.id })

/** The marks of the free-plan accounts that `state` holds idle, by account key. */
function idleOf(state: ProviderModelEligibilityState | undefined): ReadonlyMap<string, IdleFreePlanMark> {
  return new Map([...state?.inventoryCandidates.values() ?? []].flatMap(({ candidate, idleFreePlan }) => idleFreePlan === undefined ? [] : [[accessProviderAccountKey(candidate), idleFreePlan] as const]))
}

/** Marks each candidate of an idle free-plan account, and clears the mark of every other candidate. */
function withIdleFreePlans(candidates: ReadonlyMap<string, ProviderModelInventoryCandidate>, idle: ReadonlyMap<string, IdleFreePlanMark>): ReadonlyMap<string, ProviderModelInventoryCandidate> {
  return new Map([...candidates].map(([key, { idleFreePlan: _previous, ...candidate }]) => {
    const mark = idle.get(accessProviderAccountKey(candidate.candidate))
    return [key, mark === undefined ? candidate : { ...candidate, idleFreePlan: mark }]
  }))
}

/** Marks each candidate of a provider that the profile keeps off, and clears the mark of every other candidate. */
function withTurnedOff(candidates: ReadonlyMap<string, ProviderModelInventoryCandidate>, turnedOff: ReadonlySet<string>): ReadonlyMap<string, ProviderModelInventoryCandidate> {
  return new Map([...candidates].map(([key, { turnedOff: _previous, ...candidate }]) => [key, turnedOff.has(candidate.candidate.providerId) ? { ...candidate, turnedOff: true as const } : candidate]))
}

function sameProviders(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((providerId) => right.has(providerId))
}

/** Whether every candidate of `state` carries the turned-off mark exactly when its provider is in `turnedOff`. */
function marksTurnedOff(state: ProviderModelEligibilityState, turnedOff: ReadonlySet<string>): boolean {
  return [...state.inventoryCandidates.values()].every((candidate) => (candidate.turnedOff === true) === turnedOff.has(candidate.candidate.providerId))
}

function sameMarks(left: ReadonlyMap<string, IdleFreePlanMark>, right: ReadonlyMap<string, IdleFreePlanMark>): boolean {
  return left.size === right.size && [...left].every(([key, mark]) => right.has(key) && right.get(key)?.identity === mark.identity)
}

function hasPendingDiscovery(state: ProviderModelEligibilityState): boolean {
  return [...state.inventoryCandidates.values()].some(({ catalog, turnedOff }) => turnedOff === undefined && catalog.kind === "unavailable" && catalog.reason === "discovery-pending")
}

/** A completed login must leave its exact account with a usable catalog before requests resume. */
export function requireLoginCatalog(state: ProviderModelEligibilityState, account: AccessProviderAccountIdentity, composition: FirstPartyModuleComposition): void {
  const candidate = state.inventoryCandidates.get(accessProviderAccountKey(account))
  if (candidate?.configured === true
    && candidate.currentConnection
    && (candidate.catalog.kind !== "unavailable" || candidate.catalog.reason === "discovery-pending")
    && candidate.inventoryOfferings !== null
    && candidate.inventoryOfferings.size > 0) return
  const displayName = accessProviderRegistry(composition).selection.displayName(account.providerId)
  throw new Error(`No usable model catalog is available for ${displayName}`)
}

const ELIGIBILITY_INPUT_REVISION = heldDirectoryDerivation<EligibilityInputRevision>([AUTH_STORE_FILE, PROVIDER_MODEL_PREFERENCES_FILE])

/** Every capture compares this revision twice, so it is held while the profile's watch delivers. */
export function authProfileEligibilityInputRevision(profile: EligibilityProfile): EligibilityInputRevision {
  return ELIGIBILITY_INPUT_REVISION.read(profile.directory, () => {
    const access = openExistingAuthProfileDirectory(profile.directory)
    try {
      // Preference mutations fence readable bytes under their lock. A refused
      // file has no readable revision and must not alias a missing file here.
      return { auth: authStoreObservedRevision(profile.directory), preferences: providerModelPreferencesRevision(access) }
    } finally {
      access.close()
    }
  })
}

function sameInputRevision(left: EligibilityInputRevision, right: EligibilityInputRevision): boolean {
  return left.auth === right.auth && left.preferences === right.preferences
}

function catalogDiscovery(outcome: ResolvedModelCatalog | undefined): ProviderCatalogDiscovery {
  if (outcome === undefined) return { kind: "available", provenance: "static", liveOutcome: "valid" }
  if (outcome.kind === "unavailable") return { kind: "unavailable", reason: outcome.reason, ...(outcome.discoveryReason === undefined ? {} : { discoveryReason: outcome.discoveryReason }) }
  return outcome.liveOutcome === "authentication-absent"
    ? { kind: "unavailable", reason: outcome.liveOutcome }
    : { kind: "available", provenance: outcome.provenance, liveOutcome: outcome.liveOutcome }
}

/** Release dates are derived from the immutable listing snapshot. Admission
 * never performs a second models.dev lookup. */
function resolveReleaseDates(candidates: ReadonlyMap<string, {
  readonly enabledOfferings: ReadonlyMap<string, readonly CatalogModelOffering[]> | null;
  readonly inventoryOfferings: ReadonlyMap<string, readonly CatalogModelOffering[]> | null;
}>): ReadonlyMap<string, string> {
  const dates = new Map<string, string>()
  for (const candidate of candidates.values()) {
    for (const [modelId, offerings] of candidate.inventoryOfferings ?? []) {
      for (const offering of offerings) {
        const releaseDate = offering.resolvedMetadata?.releaseDate
          ?? (isCatalogMetadataRecord(offering.metadata) && typeof offering.metadata.releaseDate === "string"
            ? offering.metadata.releaseDate
            : undefined)
        if (releaseDate !== undefined) {
          dates.set(modelId, releaseDate)
          break
        }
      }
    }
  }
  return dates
}

function isCatalogMetadataRecord(
  value: CatalogJsonValue,
): value is { readonly [key: string]: CatalogJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
