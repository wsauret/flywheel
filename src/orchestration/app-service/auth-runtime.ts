import { AuthProfileStore, openExistingAuthProfileDirectory } from "../../infra/auth/auth-profile-store.js"
import type { KeyResolver } from "../../infra/auth/resolve-key.js"
import { authDir } from "../../infra/paths.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { AsyncEventWriter, AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { ModulePolicy } from "../config/module-policy.js"
import type { RuntimeConfigOwner } from "../config/runtime-config-owner.js"
import type { AuthProfileResolution } from "../auth/auth-profile-manager.js"
import { logoutProfileExternalLogins } from "../auth/auth-actions.js"
import type { SessionManager } from "../session/manager.js"
import type { FirstPartyModuleComposition, FirstPartyModuleSnapshot } from "../modules.js"
import { installedAccessProviderDefinitions, installedCredentialProviderIds, installedCredentialSlotClassifier } from "../credential-provider-modules.js"
import { authStoreObservationKey } from "../../infra/auth/auth-store.js"
import { heldAuthStoreLoad } from "./held-auth-store-load.js"
import { clearTierCache } from "../config/model-tiers.js"
import { migrateLegacyModelSpellings } from "../config/writer.js"
import { legacyModelSpellingCatalog } from "./legacy-model-spelling-catalog.js"
import { createAuthPublicationBaseline, createAuthStatusPublisher, createProviderModelAuthPublisher } from "./auth-publication.js"
import { createAuthStatusProjection, type AuthStatusProjection } from "./auth-status-projection.js"
import { createAuthAttentionPublisher } from "./auth-attention-publisher.js"
import type { AuthOperationNotice, RuntimeAuthStatusScope } from "../../protocol/auth-status-protocol-types.js"
import { authProfileEligibilityInputRevision, createEligibilityPreparation, requireLoginCatalog } from "./eligibility-preparation.js"
import { createProviderModelPreferenceService, type ProfileBoundProviderModelPreferenceService } from "./provider-model-preference-service.js"
import { providerModelPreferencePersistence } from "./provider-model-preference-persistence.js"
import type { RuntimeUiBus } from "./runtime-ui-bus.js"
import type { DefinitionAvailabilityOwner } from "./definition-availability.js"
import type { SessionStore } from "../session-store/types.js"
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js"
import { createRuntimeAuthProfileSelectionService, type RuntimeAuthProfileSelectionService } from "./auth-profile-selection-service.js"
import { createSessionAuthAdmission, type SessionAuthAdmission } from "../session/session-auth-profile.js"
import { prepareWorkflowDeps, type WorkflowDeps } from "../workflow-host/deps.js"
import { createSubscriptionUsageRuntime } from "../auth/provider-observations/runtime-composition.js"
import type { SubscriptionUsageServiceLease, SubscriptionUsageServicePool } from "../auth/provider-observations/subscription-usage-service-pool.js"
import { createProfileRefreshCoordinator } from "./profile-refresh-coordinator.js"
import { getSharedModelsClient } from "../config/llm-clients.js"
import { createSubscriptionSpendConsentRuntime } from "../subscription-spend-consent/runtime-composition.js"
import { SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE, type SubscriptionSpendConsentMutation, type SubscriptionSpendConsentMutationResult, type SubscriptionSpendConsentView } from "../../protocol/subscription-spend-consent-protocol-types.js"
import type { SubscriptionSpendConsentCapture } from "../subscription-spend-consent/subscription-spend-consent-service.js"
import { createSubscriptionSpendConsentCaptureCache } from "../subscription-spend-consent/capture-cache.js"
import { createAuthConditionOwner } from "../auth/auth-condition-owner.js"
import { captureSubscriptionAdmission } from "../subscription-spend-consent/admission-capture.js"
import type { CaptureSubscriptionAdmission } from "../agent-runtime/factory.js"
import { createAuthProfileWatcherOwner } from "./auth-profile-watcher-owner.js"
import { authScopesForProfile, resolveAuthProfileScope, resolveOwnedAuthProfile } from "./auth-profile-scope.js"
import { createResidentAuthScopes } from "./auth-resident-scopes.js"
import { subscribeAuthOwners } from "./auth-owner-subscription.js"
import { prepareAuthProfileTarget } from "./auth-profile-target.js"
import { createWorkflowAuthOwner, type WorkflowAuthOwner } from "../workflow-host/auth-owner.js"
import { workflowRunReader, workflowRunWriter } from "../module-catalog.js"
import type { WorkflowHosts } from "../workflow-host/host-collection.js"
import { createProfileRequestService, type ProfileRequestWorkflowPreparation } from "../auth/profile-request-service.js"
import { createAdmittedModelAssignmentService, createModelAssignmentReadAdmission, type ChatDefaultRefreshOwner } from "./model-assignment-admission.js"
import { createChatDefaultRuntime } from "./chat-default-runtime.js"
import { captureRuntimeConfigRequest } from "../agent-runtime/request-config.js"
import { normalizeAuthProfile } from "../../infra/auth/auth-profile-normalization.js"
import { createAuthSettlementCoordinator } from "./auth-settlement-coordinator.js"
import { resolveHeadlessAuth, type HeadlessAuthSelection } from "../headless/headless-profile-runtime.js"
import { connectionEligibilitySources } from "../headless/snapshot-eligibility.js"

import { accessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js"
import { isExternalLoginDefinition, type AccessProviderAccountIdentity } from "../../infra/llm/access-provider.js"
import type { RuntimeChatDefault } from "../../protocol/app-service-types.js"
import type { RuntimeModelCatalogRefreshScope } from "../../protocol/provider-model-preference-protocol-types.js"
const log = Log.create({ service: "auth-runtime" })

export interface AuthRuntimeOptions {
  readonly userDataRoot: string
  readonly projectRoot: string
  readonly manager: SessionManager
  readonly capabilities: Pick<ModulePolicy, "onChange">
  readonly moduleSelection: FirstPartyModuleSnapshot
  readonly bus: Pick<RuntimeUiBus, "publish">
  readonly resolveKey: KeyResolver
  readonly workflowPreparation: ProfileRequestWorkflowPreparation
  readonly runtimeConfig: Pick<RuntimeConfigOwner, "snapshot" | "refresh" | "subscribe">
  readonly persistentProcessesForcedByCli: boolean
  readonly own: <T>(name: string, resource: T, dispose: (owned: T) => Promise<void> | void) => T
  readonly subscriptionUsageThresholds: () => readonly number[]
  readonly interactive: boolean
  readonly sessionStore: Pick<SessionStore, "get" | "refreshDeps">
  readonly workflowHosts: Pick<WorkflowHosts, "refreshDeps">
  readonly eventReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  readonly availability: Pick<DefinitionAvailabilityOwner, "snapshot">
  /** The notify seam (ARCH-STRUCTURE-034), contained: a failure is logged by the seam's owner. */
  readonly notify: (episode: NotificationEpisodeInput) => void
  /** The same seam with its settlement: it rejects when a delivery is refused,
   *  fails, or gets no answer, so auth attention is sent again until it lands. */
  readonly settledNotify: (episode: NotificationEpisodeInput) => Promise<void>
  readonly chatDefault: RuntimeChatDefault
  readonly headlessAuth?: HeadlessAuthSelection
}

/** Owns the selected auth profile, profile-bound provider state, session admission, and all refresh publications for one runtime. */
export interface AuthRuntime {
  readonly initialProfile: AuthProfileResolution
  /** The profile this runtime uses when a request names none. */
  readonly activeProfile: () => AuthProfileResolution
  /** The owned profile `profileId` names. Undefined for a profile this runtime does not own. */
  readonly resolveOwnedProfile: (profileId: string) => AuthProfileResolution | undefined
  /** Matches a captured external-login directory to an already owned profile. */
  readonly resolveLoginProfile: (directory: string) => AuthProfileResolution | undefined
  /** Automatic recovery is visible from every observed auth scope. */
  readonly publishLoginNotice: (notice: AuthOperationNotice) => Promise<void>
  /** The profile a new session records at creation: the one this process
   *  serves when a request names none, including an environment selector's
   *  choice, so the session keeps it after this process ends (PI-MODEL-033). */
  readonly newSessionProfileId: () => string
  readonly authStatusProjection: AuthStatusProjection
  readonly providerModels: Pick<ProfileBoundProviderModelPreferenceService, "query" | "set" | "deselectAll" | "recheck" | "setAutoEnableNewModels" | "setFreeRoutes">
  readonly modelAssignments: ReturnType<typeof createAdmittedModelAssignmentService>
  readonly chatDefault: ChatDefaultRefreshOwner
  readonly subscriptionUsage: SubscriptionUsageServicePool & {
    acquireScope(scope: RuntimeAuthStatusScope): Promise<SubscriptionUsageServiceLease>
    subscribePublications(listener: (profile: SubscriptionUsageServiceLease["profile"], scopes: readonly RuntimeAuthStatusScope[], service: SubscriptionUsageServiceLease["service"]) => void): () => void
  }
  readonly authProfileSelection: RuntimeAuthProfileSelectionService
  readonly sessionAuthAdmission: SessionAuthAdmission<WorkflowDeps>
  readonly workflowAuth: WorkflowAuthOwner
  prepareWorkflowDeps(profileId: string, signal?: AbortSignal): Promise<WorkflowDeps>
  readonly settle: (profileId: string, operationId: string) => Promise<void>
  mutateSubscriptionSpendConsent(mutation: SubscriptionSpendConsentMutation): Promise<SubscriptionSpendConsentMutationResult>
  refreshSubscriptionSpendConsent(scope: RuntimeAuthStatusScope, expectedService?: SubscriptionUsageServiceLease["service"]): Promise<void>
  /** Publishes a login's progress or end on every scope one profile backs. */
  publishProfileNotice(profileId: string, notice: AuthOperationNotice): Promise<void>
  /** A login can retain its admitted provider composition while publication uses the live selection. */
  settleCatalog(account: AccessProviderAccountIdentity, authDirectory: string, signal?: AbortSignal, composition?: FirstPartyModuleComposition): Promise<void>
  refresh(profileId?: string): Promise<void>
  /** Resolves the requested profile and acknowledges owner-held catalog discovery,
   * without awaiting discovery or entering auth/usage/consent settlement. */
  scheduleCatalogRefresh(scope: RuntimeModelCatalogRefreshScope): Promise<void>
  disposeCore(): Promise<void>
}

/** Creates the runtime's single auth authority. Provider inventory remains demand-owned. */
export async function createAuthRuntime(options: AuthRuntimeOptions): Promise<AuthRuntime> {
  // The runtime's launch authority, which the usage checks, the eligibility preparation, and profile removal start CLIs in.
  const launcher = options.workflowPreparation.launcher
  const { profiles: profileManager, profile: initialProfile, snapshot } = await resolveHeadlessAuth({ userDataRoot: options.userDataRoot, projectRoot: options.projectRoot, config: () => options.runtimeConfig.snapshot().config }, options.headlessAuth, accessProviderRegistry(options.moduleSelection()).selection.definitions)
  options.own("auth-headless-snapshot", snapshot, (captured) => { captured?.release() })
  let currentProfile = initialProfile
  const workflowRuns = workflowRunReader(options.eventReader)
  const workflowAuth = createWorkflowAuthOwner({
    reader: workflowRuns,
    writer: workflowRunWriter(options.eventReader, options.manager.commitWorkflow),
    profiles: profileManager, userDataRoot: options.userDataRoot,
    onSelected: async () => {
      await reconcileAuthFileWatchers()
      await residentScopes.reconcileWorkflows(await workflowAuth.list())
      await refreshAllDeps()
      await publishAuthStatus()
    },
  })
  const refreshAllDeps = async (): Promise<void> => {
    await Promise.all([options.sessionStore.refreshDeps(), options.workflowHosts.refreshDeps()])
  }
  const resolveScopedProfile = (scope: RuntimeAuthStatusScope, defaults: AuthProfileResolution) =>
    resolveAuthProfileScope(scope, defaults, options.manager, workflowRuns, options.userDataRoot)
  const resolveOwnedProfile = (profileId: string) => resolveOwnedAuthProfile(profileId, currentProfile, options.userDataRoot)
  const resolveLoginProfile = (directory: string) => currentProfile.directory === directory ? currentProfile
    : currentProfile.availableProfiles.map(({ id }) => resolveOwnedProfile(id)).find((profile) => profile?.directory === directory)
  const scopesForProfile = (profile: AuthProfileResolution) =>
    authScopesForProfile(profile, currentProfile, options.manager, workflowRuns, options.userDataRoot, authStatusProjection.observedSessionIds)
  let publishAuthStatus = async (_scopes?: readonly RuntimeAuthStatusScope[], _notice?: AuthOperationNotice): Promise<void> => {}
  const providerModels = options.own("auth-provider-models", createProviderModelPreferenceService({
    displayName: (providerId) => accessProviderRegistry(options.moduleSelection()).selection.displayName(providerId),
    allowTrainingRoutes: (profileId) => options.runtimeConfig.snapshot().config.profiles[profileId]?.allow_training_routes ?? false,
    ...providerModelPreferencePersistence((profileId) => authDir(options.userDataRoot, profileId)),
    recheckAccount: ({ profileId, account, expectedAuthRevision, expectedPreferenceRevision }) =>
      prepareEligibility.recheckAccount({ id: profileId, directory: authDir(options.userDataRoot, profileId) }, account, { auth: expectedAuthRevision, preferences: expectedPreferenceRevision }),
    publish: createProviderModelAuthPublisher({
      resolveProfile: resolveOwnedProfile,
      scopesForProfile,
      publish: (scopes) => publishAuthStatus(scopes),
      onError: (profileId, error) => { log.warn("provider-model auth publication failed", { profileId, error: errorMessage(error) }) },
    }),
  }), (service) => service.dispose())
  const consentViews = new Map<string, SubscriptionSpendConsentView>()
  const consentCaptureCache = createSubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>()
  const emptyConsentView = (profileId: string): SubscriptionSpendConsentView => ({ kind: "unavailable", profileId, message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE })
  let disposed = false
  let refreshChatDefault = (): void => {}
  const publishExternalAuthStatus = (scopes?: readonly RuntimeAuthStatusScope[]): void => {
    void publishAuthStatus(scopes).catch((error: unknown) => { log.warn("auth status publication failed", { error: errorMessage(error) }) })
  }
  const authConditions = createAuthConditionOwner(() => { publishExternalAuthStatus() })
  // A program that owns an external login can change what the view shows with no file change, such as a refused
  // login or a CLI that a version check refused, so each such observation publishes the view again.
  options.own("auth-external-login-observations", installedAccessProviderDefinitions().filter(isExternalLoginDefinition).map((definition) => definition.auth.observe(() => { publishExternalAuthStatus() })), (unsubscribes) => { for (const unsubscribe of unsubscribes) unsubscribe() })
  const observeAuth = (profile: { readonly id: string; readonly directory: string }) => {
    const load = heldAuthStoreLoad(profile.directory)
    if (authConditions.observeLoad(profile.directory, load)) {
      const owned = resolveOwnedProfile(profile.id)
      if (owned) void scopesForProfile(owned).then((scopes) => publishAuthStatus(scopes)).catch((error: unknown) => { log.warn("auth status publication failed", { profileId: profile.id, error: errorMessage(error) }) })
    }
    return load
  }
  const authAttention = options.own("auth-attention-publisher", createAuthAttentionPublisher({ deliver: options.settledNotify }), (publisher) => publisher.dispose())
  const authStatusProjection = createAuthStatusProjection({
    initialProfile,
    moduleSelection: options.moduleSelection,
    eligibilityState: (profileId) => providerModels.state(profileId),
    subscriptionSpendConsent: (profileId) => consentViews.get(profileId) ?? emptyConsentView(profileId),
    conditions: authConditions,
    resolveProfile: resolveScopedProfile,
    resolveLoginProfile,
  })
  const subscriptionUsagePool = createSubscriptionUsageRuntime({
    own: options.own,
    registry: () => accessProviderRegistry(options.moduleSelection()),
    thresholds: options.subscriptionUsageThresholds,
    monitor: options.interactive,
    onCapabilitiesChanged: (listener) => options.capabilities.onChange(() => listener()),
    ...(launcher === undefined ? {} : { launcher }),
  })
  const residentScopes = createResidentAuthScopes({
    manager: options.manager, runs: workflowRuns, userDataRoot: options.userDataRoot, resolveProfile: (scope) => resolveScopedProfile(scope, currentProfile),
    currentProfile: () => currentProfile, disposed: () => disposed, pool: subscriptionUsagePool,
  })
  const { leases: residentLeases, subscriptionUsage, reconcile: reconcileResidentScope, enqueue: enqueueResidentReconciliation } = residentScopes
  await reconcileResidentScope({ kind: "defaults" })
  for (const row of (await options.manager.listActive()).sessions) await reconcileResidentScope({ kind: "session", sessionId: row.id }, row)
  await residentScopes.reconcileWorkflows(await workflowAuth.list())
  const publishedDefaults = createAuthPublicationBaseline()

  publishAuthStatus = createAuthStatusPublisher({
    manager: options.manager, runs: workflowRuns, defaults: () => {
      currentProfile = profileManager.inspect()
      return currentProfile
    }, userDataRoot: options.userDataRoot,
    projection: authStatusProjection, attention: authAttention, baseline: publishedDefaults, bus: options.bus,
    disposed: () => disposed, refreshChatDefault: () => refreshChatDefault(),
  })
  const refreshCoordinator = options.own("auth-refresh-coordinator", createProfileRefreshCoordinator(refreshProfileNow), (coordinator) => coordinator.dispose())

  const requireEligibilityState = (profileId: string) => {
    const state = providerModels.state(profileId)
    if (state === undefined) throw new Error(`provider-model eligibility is unavailable for profile ${profileId}`)
    return state
  }
  const prepareEligibility = options.own("auth-eligibility-preparation", createEligibilityPreparation({
    userDataRoot: options.userDataRoot, resolveKey: options.resolveKey,
    allowTrainingRoutes: (profileId) => options.runtimeConfig.snapshot().config.profiles[profileId]?.allow_training_routes ?? false,
    ...(launcher === undefined ? {} : { launcher }),
    moduleSelection: options.moduleSelection,
    prepare: providerModels.prepare,
    publish: (state) => {
      providerModels.publish(state)
      // Remove after 2027-01-24 with migrateLegacyModelSpellings.
      void migrateLegacyModelSpellings({ userDataRoot: options.userDataRoot }, legacyModelSpellingCatalog(state, options.userDataRoot))
        .then((result) => {
          if (!result.ok) log.warn("former model spellings in flywheel.toml were not converted", { error: errorMessage(result.error) })
          else if (result.rewritten) return options.runtimeConfig.refresh()
        })
        .catch((error: unknown) => { log.warn("former model spellings in flywheel.toml were not converted", { error: errorMessage(error) }) })
    },
    current: providerModels.state,
    inputRevision: authProfileEligibilityInputRevision,
    observeAuth,
    // A snapshot's connection serves in place of the profile's auth files,
    // which this run neither reads nor normalizes.
    ...(snapshot ? connectionEligibilitySources(snapshot.connection, initialProfile.directory, options.moduleSelection, getSharedModelsClient(options.userDataRoot)) : {
      normalizeProfile: async (profile: { readonly directory: string }) => {
        if (await normalizeAuthProfile(profile.directory, installedCredentialSlotClassifier(), installedCredentialProviderIds(), installedAccessProviderDefinitions(), (occurrence) => { options.notify({ type: "raise", occurrence }) }) === "read-only") authConditions.observeNormalizationRefusal(profile.directory)
      },
    }),
    refreshMetadata: (signal) => getSharedModelsClient(options.userDataRoot).refresh(signal),
    // Every session takes the eligibility that background discovery or a saved refusal published.
    apply: async (profileId) => { await settleProviderModelMutation(async () => ({ profileId })) },
  }), (preparation) => preparation.dispose())
  // A usage reading carries each account's plan, and a plan that turns free or paid changes which accounts may serve.
  options.own("auth-free-plan-reconciliation", subscriptionUsagePool.onPublished((profile, service) => { void prepareEligibility.reconcileFreePlans(profile, service.snapshot()).catch((error: unknown) => { if (!disposed) log.warn("free-plan accounts were not reconciled", { profileId: profile.id, error: errorMessage(error) }) }) }), (unsubscribe) => { unsubscribe() })
  const residentLease = (profileId: string, profileDirectory: string) => [...residentLeases.values()].find(({ lease }) => lease.profile.id === profileId && lease.profile.directory === profileDirectory)?.lease
  const subscriptionSpendProviderPresentation = (providerId: string) => {
    const selection = accessProviderRegistry(options.moduleSelection()).selection
    const billingUrl = selection.billingUrl(providerId)
    return { providerDisplayName: selection.shortName(providerId), ...(billingUrl === undefined ? {} : { billingUrl }) }
  }
  const subscriptionSpendConsentFromService = (profileId: string, profileDirectory: string, service: SubscriptionUsageServiceLease["service"]) => {
    const access = openExistingAuthProfileDirectory(profileDirectory)
    return { consent: createSubscriptionSpendConsentRuntime({ profileId, access, usage: service, providers: accessProviderRegistry(options.moduleSelection()).selection.definitions, providerPresentation: subscriptionSpendProviderPresentation }), close: () => access.close() }
  }
  const captureProfileSubscriptionAdmission = (profileId: string, profileDirectory: string, view?: true): CaptureSubscriptionAdmission => (candidates, providerSettings) => {
    const resident = residentLease(profileId, profileDirectory)
    return captureSubscriptionAdmission({
      candidates,
      providerSettings,
      registry: accessProviderRegistry(options.moduleSelection()),
      profile: { id: profileId, directory: profileDirectory },
      ...(resident === undefined ? {} : { residentLease: resident }),
      pool: subscriptionUsagePool, consentCache: consentCaptureCache,
      ...(view === undefined ? {} : { view }),
    })
  }
  const acquireUsageSettlementAuthority = async (profile: { readonly profileDir: string; readonly profileId: string }) => {
    const lease = await subscriptionUsagePool.acquireSettlement({ id: profile.profileId, directory: profile.profileDir })
    const authority = lease.service.store()
    if (!authority) {
      await lease.release()
      throw new Error(`usage authority is unavailable for profile ${profile.profileId}`)
    }
    return {
      profileId: authority.profileId,
      authorityIncarnation: authority.incarnation(),
      append: authority.append,
      release: lease.release,
    }
  }
  const refreshConsentView = async (profileId: string, profileDirectory: string, refreshEvidence = false): Promise<SubscriptionSpendConsentView> => {
    const resident = residentLease(profileId, profileDirectory)
    const lease = resident ?? await subscriptionUsagePool.acquire({ id: profileId, directory: profileDirectory })
    const runtime = subscriptionSpendConsentFromService(profileId, profileDirectory, lease.service)
    let view: SubscriptionSpendConsentView
    try {
      if (refreshEvidence) await lease.service.check({ forceRefresh: true })
      view = await runtime.consent.view()
    } finally { runtime.close(); if (!resident) await lease.release() }
    consentViews.set(profileId, view)
    return view
  }
  const consentRefreshes = new Map<string, Promise<void>>()
  const refreshSubscriptionSpendConsent = async (scope: RuntimeAuthStatusScope, expectedService?: SubscriptionUsageServiceLease["service"]): Promise<void> => {
    let profile: AuthProfileResolution
    try { profile = await resolveScopedProfile(scope, currentProfile) } catch { return }
    if (disposed) return
    const resident = residentLease(profile.id, profile.directory)
    const generation = resident?.service.generation()
    if (!resident || !generation) return
    if (expectedService !== undefined && resident.service !== expectedService) return
    const key = `${profile.id}\0${profile.directory}\0${generation.generation}\0${generation.identity}`
    const pending = consentRefreshes.get(key)
    if (pending) return pending
    const operation = (async () => {
      const runtime = subscriptionSpendConsentFromService(profile.id, profile.directory, resident.service)
      let view: SubscriptionSpendConsentView
      try { view = await runtime.consent.view() } finally { runtime.close() }
      const currentGeneration = resident.service.generation()
      let currentScopeProfile: AuthProfileResolution
      try { currentScopeProfile = await resolveScopedProfile(scope, currentProfile) } catch { return }
      if (disposed || currentScopeProfile.id !== profile.id || currentScopeProfile.directory !== profile.directory || currentGeneration !== generation) return

      consentViews.set(profile.id, view)
      const scopes = [...residentLeases.values()]
        .filter(({ lease }) => lease.profile.id === profile.id && lease.profile.directory === profile.directory && lease.service.generation() === generation)
        .flatMap(({ scope: residentScope }) => residentScope.kind === "workflow" ? [] : [residentScope])
      await publishAuthStatus(scopes)
    })()
    consentRefreshes.set(key, operation)
    void operation.then(() => { if (consentRefreshes.get(key) === operation) consentRefreshes.delete(key) }, () => { if (consentRefreshes.get(key) === operation) consentRefreshes.delete(key) })
    return operation
  }
  await refreshConsentView(initialProfile.id, initialProfile.directory)
  authAttention.state(await authStatusProjection.snapshot())
  const profileRequests = createProfileRequestService({
    userDataRoot: options.userDataRoot,
    workflowPreparation: snapshot ? { ...options.workflowPreparation, overrides: { connection: snapshot.connection } } : options.workflowPreparation,
    prepareEligibility: async (profile, preparationOptions) => {
      await prepareEligibility(profile, preparationOptions)
      return prepareEligibility.capture(profile, (state, auth) => ({ worker: state.worker, auth }), preparationOptions.signal)
    },
    awaitDiscovery: prepareEligibility.awaitDiscovery,
    captureSubscriptionAdmissionFor: captureProfileSubscriptionAdmission,
    acquireUsageSettlementAuthority,
    authConditions,
    captureRuntimeConfigFor: (profileId) => () => captureRuntimeConfigRequest(options.runtimeConfig.snapshot(), profileId, options.persistentProcessesForcedByCli),
    recordModelRefusal: (record) => { prepareEligibility.recordModelRefusal(record) },
    ...(options.interactive ? { waitForLogin: true as const } : {}),
    prepareWorkflowDeps,
  })

  const sessionAuthAdmission = options.own("auth-session-admission", createSessionAuthAdmission({
    manager: options.manager,
    authProfiles: profileManager,
    prepare: profileRequests.prepare,
    // A snapshot's connection does not change with the profile's auth files,
    // so admission prepares once rather than against their state.
    ...(snapshot ? {} : {
      observe: (profileId: string) => authStoreObservationKey(observeAuth({ id: profileId, directory: authDir(options.userDataRoot, profileId) })),
      preparedObservation: (prepared: WorkflowDeps) => {
        if (prepared.auth.observation === undefined) throw new Error("Admitted auth observation is unavailable")
        return prepared.auth.observation
      },
    }),
    materialize: materializeSessionProfile,
    workflows: workflowAuth,
  }), (admission) => admission.dispose())
  const settleProviderModelMutation = async <Result extends { readonly profileId: string }>(mutate: () => Promise<Result>): Promise<Result> => {
    await refreshCoordinator.barrier()
    const result = await mutate()
    sessionAuthAdmission.invalidate(result.profileId)
    await refreshAllDeps()
    return result
  }
  const appProviderModels: Pick<ProfileBoundProviderModelPreferenceService, "query" | "set" | "deselectAll" | "recheck" | "setAutoEnableNewModels" | "setFreeRoutes"> = {
    query: async (profileId, providerId) => {
      for (;;) {
        const barrier = refreshCoordinator.barrier()
        await barrier
        if (barrier !== refreshCoordinator.barrier()) continue
        try {
          await prepareEligibility({ id: profileId, directory: authDir(options.userDataRoot, profileId) })
        } catch (error) {
          if (barrier !== refreshCoordinator.barrier()) continue
          throw error
        }
        if (barrier === refreshCoordinator.barrier()) return providerModels.query(profileId, providerId)
      }
    },
    set: (mutation) => settleProviderModelMutation(() => providerModels.set(mutation)),
    deselectAll: (mutation) => settleProviderModelMutation(() => providerModels.deselectAll(mutation)),
    recheck: async (mutation) => {
      await refreshCoordinator.barrier()
      return providerModels.recheck(mutation)
    },
    setAutoEnableNewModels: (mutation) => settleProviderModelMutation(() => providerModels.setAutoEnableNewModels(mutation)),
    setFreeRoutes: (mutation) => settleProviderModelMutation(() => providerModels.setFreeRoutes(mutation)),
  }

  let reconcileAuthFileWatchers = async (): Promise<void> => {}
  const applyAuthProfile = async (next: AuthProfileResolution, forceEligibility = false, invalidateAdmission = false, signal?: AbortSignal): Promise<{ publish: boolean }> => {
    const profileChanged = next.id !== currentProfile.id || next.directory !== currentProfile.directory
    await prepareEligibility(next, { mode: forceEligibility ? "refresh" : "cached-first", signal })
    signal?.throwIfAborted()
    const delta = publishedDefaults.delta(authStatusProjection.replace(next))
    currentProfile = next
    await reconcileAuthFileWatchers()
    await reconcileResidentScope({ kind: "defaults" })
    await subscriptionUsagePool.refresh()
    const refreshDeps = invalidateAdmission || profileChanged || delta.providers
    if (refreshDeps) sessionAuthAdmission.invalidate(next.id)
    return { publish: forceEligibility || profileChanged || delta.view }
  }

  async function refreshProfileNow(profileId?: string, signal?: AbortSignal, mode: "refresh" | "observe" = "refresh"): Promise<void> {
    if (signal === undefined) throw new Error("profile refresh requires owned cancellation")
    const observed = resolveOwnedProfile(profileId ?? currentProfile.id)
    if (observed !== undefined) {
      observeAuth(observed)
    }
    if (mode === "observe") {
      if (observed === undefined) return
      await prepareEligibility(observed, { signal })
      signal.throwIfAborted()
      await refreshAllDeps()
      return
    }
    await getSharedModelsClient(options.userDataRoot).refresh(signal)
    signal.throwIfAborted()
    clearTierCache(authDir(options.userDataRoot, profileId ?? currentProfile.id))
    const resolved = await profileManager.resolve()
    let shouldPublish = false
    if (profileId === undefined || profileId === resolved.id) {
      const applied = await applyAuthProfile(resolved, true, true, signal)
      shouldPublish = applied.publish
    } else {
      const profile = { id: profileId, directory: authDir(options.userDataRoot, profileId) }
      await prepareEligibility(profile, { mode: "refresh", signal })
      signal?.throwIfAborted()
      sessionAuthAdmission.invalidate(profile.id)
      shouldPublish = true
    }
    await refreshAllDeps()
    signal?.throwIfAborted()
    await refreshConsentView(profileId ?? resolved.id, authDir(options.userDataRoot, profileId ?? resolved.id), true)
    if (shouldPublish) await publishAuthStatus()
  }
  const settlementCoordinator = createAuthSettlementCoordinator({
    refreshConfig: async () => { await options.runtimeConfig.refresh() },
    refreshProfile: (profileId, signal) => refreshCoordinator.refresh(profileId, signal),
    profileScopes: async (profileId) => {
      const profile = resolveOwnedProfile(profileId)
      return profile === undefined ? [] : scopesForProfile(profile)
    },
    publish: (scopes, notice) => publishAuthStatus(scopes, notice),
  })
  const settleCatalog = async (account: AccessProviderAccountIdentity, authDirectory: string, signal?: AbortSignal, composition?: FirstPartyModuleComposition): Promise<void> => {
    const profile = resolveLoginProfile(authDirectory)
    if (profile === undefined) throw new Error("Auth settlement profile is no longer available")
    const state = await prepareEligibility(profile, { mode: "fresh", signal, composition })
    signal?.throwIfAborted()
    requireLoginCatalog(state, account, composition ?? options.moduleSelection())
    sessionAuthAdmission.invalidate(profile.id)
    // Usage captures its accounts per generation, so a credential stored after
    // startup is polled only by a new one. Usage is an observation: its failure
    // must not roll back the login that this settlement confirms.
    await subscriptionUsagePool.refresh().catch((err: unknown) => {
      log.warn("subscription usage generation refresh failed", { providerId: account.providerId, error: errorMessage(err) })
    })
    await options.sessionStore.refreshDeps()
    await publishAuthStatus(await scopesForProfile(profile))
  }
  const mutateSubscriptionSpendConsent = async (mutation: SubscriptionSpendConsentMutation): Promise<SubscriptionSpendConsentMutationResult> => {
    const profile = resolveOwnedProfile(mutation.profileId)
    if (!profile) return { kind: "stale" }
    const resident = residentLease(profile.id, profile.directory)
    const lease = resident ?? await subscriptionUsagePool.acquire({ id: profile.id, directory: profile.directory })
    const access = openExistingAuthProfileDirectory(profile.directory)
    consentCaptureCache.invalidate(profile.directory)
    try {
      const service = createSubscriptionSpendConsentRuntime({ profileId: profile.id, access, usage: lease.service, providers: accessProviderRegistry(options.moduleSelection()).selection.definitions, providerPresentation: subscriptionSpendProviderPresentation })
      const result = await service.mutate(mutation)
      if (result.kind === "committed") {
        consentViews.set(profile.id, result.consent)
        await publishAuthStatus(await scopesForProfile(profile))
      }
      return result
    } finally {
      access.close()
      if (!resident) await lease.release()
    }
  }
  const refreshProfile = async (profileId?: string): Promise<void> => {
    await options.runtimeConfig.refresh()
    await refreshCoordinator.refresh(profileId)
  }

  const refreshExternalProfile = (profileId?: string): void => {
    void refreshProfile(profileId).catch((error: unknown) => {
      log.warn("auth profile refresh failed", { ...(profileId === undefined ? {} : { profileId }), error: errorMessage(error) })
    })
  }

  const prepareSessionTarget = (profileId: string) => prepareAuthProfileTarget({
    profileId, profiles: profileManager, projection: authStatusProjection,
    prepare: async () => { await authFileWatchers.refreshCatalog(); await prepareEligibility({ id: profileId, directory: authDir(options.userDataRoot, profileId) }, { settled: true }) },
    setCurrent: (profile) => { currentProfile = profile },
    refreshResidentDefaults: () => reconcileResidentScope({ kind: "defaults" }),
    refreshUsage: () => subscriptionUsagePool.refresh(),
    admission: sessionAuthAdmission, sessions: options.sessionStore, workflows: options.workflowHosts, publish: publishAuthStatus,
  })
  async function materializeSessionProfile(sessionId: string, profileId: string, expectedAuthProfileId: string | undefined): Promise<void> {
    const target = await prepareSessionTarget(profileId)
    await options.manager.selectAuthProfileWithRoleSnapshot(sessionId, profileId, target.roles, { authProfileId: expectedAuthProfileId })
  }
  const authProfileSelection = createRuntimeAuthProfileSelectionService({
    profileManager, sessionManager: options.manager,
    selectWorkflowProfile: (workflowId, profileId) => workflowAuth.select(workflowId, profileId),
    refresh: refreshProfile, prepareSessionTarget,
    preRemoveProfile: async (profileId) => {
      const release = await subscriptionUsagePool.closeProfile(profileId)
      // A deleted profile has no attention left to show.
      authAttention.retire(profileId)
      authConditions.remove(authDir(options.userDataRoot, profileId))
      consentCaptureCache.invalidate(authDir(options.userDataRoot, profileId))
      // A program that owns a login keeps its token outside the profile directory, so the login ends first.
      if (launcher === undefined) log.warn("a removed auth profile keeps its external logins, because this process has no launch authority", { profileId })
      else await logoutProfileExternalLogins(authDir(options.userDataRoot, profileId), launcher)
      return release
    },
  })
  options.own("auth-profile-watcher", new AuthProfileStore(options.userDataRoot).watchActiveProfile(refreshExternalProfile), (owned) => { owned.dispose() })
  const authFileWatchers = options.own("auth-file-watchers", createAuthProfileWatcherOwner({
    workflowProfiles: async () => (await workflowAuth.list()).map(({ profile }) => profile),
    store: new AuthProfileStore(options.userDataRoot),
    defaultProfile: () => currentProfile,
    sessions: options.manager,
    profileDirectory: (profileId) => authDir(options.userDataRoot, profileId),
    refresh: async (profileId) => {
      const profile = resolveOwnedProfile(profileId)
      if (profile === undefined) return
      observeAuth(profile)
      await refreshCoordinator.refresh(profile.id, undefined, "observe")
    },
    refreshCatalog: async () => {
      await residentScopes.reconcileWorkflows(await workflowAuth.list())
      await publishAuthStatus()
      const rows = (await options.manager.listActive()).sessions
      enqueueResidentReconciliation([{ kind: "defaults" }, ...rows.map((row) => ({ kind: "session" as const, sessionId: row.id }))])
    },
    onError: (error, profileId) => { log.warn("auth profile refresh failed", { profileId, error: errorMessage(error) }) },
  }), (owned) => owned.dispose())
  reconcileAuthFileWatchers = authFileWatchers.reconcile
  options.own("auth-project-profile-subscription", options.runtimeConfig.subscribe("auth", () => refreshCoordinator.refresh()), (unsubscribe) => unsubscribe())
  // A module turned on may be a notification consumer that heard none of the
  // earlier statements; a module turned off changes the providers a view shows.
  options.own("auth-capability-subscription", options.capabilities.onChange(() => {
    authAttention.reconcile()
    publishExternalAuthStatus()
  }), (unsubscribe) => { unsubscribe() })
  options.own("auth-session-subscription", subscribeAuthOwners({
    manager: options.manager, reconcileWorkflows: async () => residentScopes.reconcileWorkflows(await workflowAuth.list()),
    reconcileWatchers: authFileWatchers.reconcile, watchSessions: authFileWatchers.watchSessions, publish: publishExternalAuthStatus, reconcileSessions: enqueueResidentReconciliation,
    onError: (error) => { log.warn("auth owner reconciliation failed", { error: errorMessage(error) }) },
  }), (unsubscribe) => { unsubscribe() })
  // A read never states attention, and a read of a profile marks its storage
  // observed, so a profile that only an already active session uses is
  // stated here once; a session that becomes active later is stated by its
  // catalog change.
  void options.manager.listActive().then(({ sessions }) => {
    if (sessions.length > 0) publishExternalAuthStatus(sessions.map(({ id }) => ({ kind: "session" as const, sessionId: id })))
  }, (error: unknown) => { log.warn("auth status publication failed", { error: errorMessage(error) }) })
  const admittedModelAssignments = createAdmittedModelAssignmentService({
    ...options,
    sessionAuthAdmission,
    activeProfileId: () => profileManager.inspect().id,
    prepareEligibility: async (profileId) => {
      await refreshCoordinator.barrier()
      await prepareEligibility({ id: profileId, directory: authDir(options.userDataRoot, profileId) }, { settled: true })
    },
    eligibilityState: requireEligibilityState,
    readAdmission: createModelAssignmentReadAdmission({
      userDataRoot: options.userDataRoot, manager: options.manager,
      authProfiles: profileManager, materialize: materializeSessionProfile, prepareEligibility, runtimeConfig: options.runtimeConfig,
      captureSubscriptionAdmission: (profileId, profileDirectory) => captureProfileSubscriptionAdmission(profileId, profileDirectory, true),
    }),
  })
  const chatDefault = createChatDefaultRuntime({
    initial: options.chatDefault,
    resolve: admittedModelAssignments.globalDefaultRoles,
    bus: options.bus, runtimeConfig: options.runtimeConfig, own: options.own,
  })
  refreshChatDefault = () => { void chatDefault.refresh() }

  return {
    initialProfile,
    activeProfile: () => currentProfile,
    resolveOwnedProfile,
    resolveLoginProfile,
    publishLoginNotice: (notice: AuthOperationNotice) => publishAuthStatus(undefined, notice),
    newSessionProfileId: () => profileManager.inspect().id,
    authStatusProjection, subscriptionUsage,
    providerModels: appProviderModels,
    modelAssignments: admittedModelAssignments,
    chatDefault, authProfileSelection, sessionAuthAdmission, workflowAuth,
    prepareWorkflowDeps: profileRequests.prepare,
    mutateSubscriptionSpendConsent, refreshSubscriptionSpendConsent,
    publishProfileNotice: settlementCoordinator.publish,
    settleCatalog,
    settle: settlementCoordinator.settle,
    refresh: refreshProfile,
    async scheduleCatalogRefresh(scope) {
      const profile = scope.kind === "profile"
        ? resolveOwnedProfile(scope.profileId)
        : await resolveScopedProfile(scope, profileManager.inspect())
      if (profile === undefined) throw new Error(`Auth profile not found: ${scope.kind === "profile" ? scope.profileId : scope.kind}`)
      prepareEligibility.scheduleRefresh(profile)
    },
    async disposeCore(): Promise<void> {
      disposed = true
      await chatDefault.dispose()
      consentCaptureCache.clear()
      await settlementCoordinator.dispose()
      await refreshCoordinator.dispose()
      await residentScopes.settled()
      await Promise.all([...residentLeases.values()].map(({ lease }) => lease.release()))
      residentLeases.clear()
    },
  }
}
