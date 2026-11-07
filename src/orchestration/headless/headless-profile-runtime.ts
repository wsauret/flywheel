import type { KeyResolver } from "../../infra/auth/resolve-key.js"
import { Log } from "../../infra/log.js"
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { ProviderConnection } from "../../infra/auth/auth-context.js"
import type { AccessProviderDefinition } from "../../infra/llm/access-provider.js"
import { captureHeadlessSnapshotConnection, readHeadlessAuthSnapshot, type CapturedHeadlessSnapshot } from "./benchmark-auth-file.js"
import type { ModelsClient } from "../../infra/llm/models.js"
import type { UsageAuthorityGeneration, UsageSettlementAuthorityLease } from "../agent-runtime/usage-settlement.js"
import { createProfileRequestService, type ProfileRequestWorkflowPreparation } from "../auth/profile-request-service.js"
import { createAuthConditionOwner } from "../auth/auth-condition-owner.js"
import { authProfileEligibilityInputRevision, createEligibilityPreparation } from "../app-service/eligibility-preparation.js"
import { createProviderModelPreferenceService } from "../app-service/provider-model-preference-service.js"
import { providerModelPreferencePersistence } from "../app-service/provider-model-preference-persistence.js"
import type { CaptureSubscriptionAdmission } from "../agent-runtime/factory.js"
import { AuthProfileManager, type AuthProfileManagerOptions, type AuthProfileResolution } from "../auth/auth-profile-manager.js"
import type { FirstPartyModuleSnapshot } from "../modules.js"
import { installedAccessProviderDefinitions, installedCredentialProviderIds } from "../credential-provider-modules.js"
import { loadAuthStoreWithDiagnostics } from "../../infra/auth/auth-store.js"
import { prepareWorkflowDeps, type PrepareWorkflowDepsInput, type WorkflowDeps } from "../workflow-host/deps.js"
import type { CaptureRuntimeConfig } from "../agent-runtime/request-config.js"

import { accessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js"
import { normalizeAuthProfile } from "../../infra/auth/auth-profile-normalization.js"
import { credentialSlotClassifier } from "../auth/credential-slot-classifier.js"
import { createHeadlessUsageAuthorityOwner } from "./headless-usage-authority.js"
import { connectionEligibilitySources } from "./snapshot-eligibility.js"
import { getSharedModelsClient } from "../config/llm-clients.js"
import { captureSubscriptionAdmission } from "../subscription-spend-consent/admission-capture.js"
import { createSubscriptionSpendConsentCaptureCache } from "../subscription-spend-consent/capture-cache.js"
import type { SubscriptionSpendConsentCapture } from "../subscription-spend-consent/subscription-spend-consent-service.js"
import { createSubscriptionUsageService, type SubscriptionUsageProfile } from "../auth/provider-observations/subscription-usage-service.js"
import { createSubscriptionUsageServicePool } from "../auth/provider-observations/subscription-usage-service-pool.js"

interface HeadlessAuthProfiles {
  acquireAccess(options: { readonly createDefault: true; readonly createSelected?: string }): Promise<{ close(): void }>
  resolve(): Promise<AuthProfileResolution>
}

/** Materializes only the implicit default profile, releases its access, then
 * resolves the profile snapshot used by one finite headless runtime. */
export async function resolveHeadlessAuthProfile(profiles: HeadlessAuthProfiles): Promise<AuthProfileResolution> {
  const access = await profiles.acquireAccess({ createDefault: true })
  access.close()
  return await profiles.resolve()
}

/** A headless run's own auth selection: `profile` selects the way the
 *  environment selector does, and `snapshotPath` names a one-use auth snapshot
 *  whose captured connection serves every request instead of the profile's
 *  auth files. */
export interface HeadlessAuthSelection {
  readonly profile?: string
  readonly snapshotPath?: string
}

/** Builds the profile manager of one headless run, in either headless mode, and resolves its profile. With a
 *  `snapshotPath` it consumes that one-use auth snapshot and captures its access-only connection.
 *
 *  A snapshot names its own profile and carries all of that profile's credentials, so the manager selects that
 *  profile the way an environment selector does. Every session admission then resolves to it, also for an attached
 *  session that recorded another profile, because the snapshot's connection serves no other profile. A run creates
 *  the profile, empty and under exactly that id, when the account home lacks it, such as a fresh benchmark sandbox.
 *  Rejects, with the snapshot already consumed, when an explicit selector names a different profile. */
export async function resolveHeadlessAuth(
  manager: AuthProfileManagerOptions,
  selection: HeadlessAuthSelection | undefined,
  providers: readonly AccessProviderDefinition[],
): Promise<{ readonly profiles: AuthProfileManager; readonly profile: AuthProfileResolution; readonly snapshot?: CapturedHeadlessSnapshot }> {
  const selected = (selector: string | undefined) => new AuthProfileManager({ ...manager, ...(selector === undefined ? {} : { env: { FLYWHEEL_AUTH_PROFILE: selector } }) })
  if (selection?.snapshotPath === undefined) {
    const profiles = selected(selection?.profile)
    return { profiles, profile: await resolveHeadlessAuthProfile(profiles) }
  }
  const snapshot = readHeadlessAuthSnapshot(selection.snapshotPath, providers)
  const requested = await selected(selection.profile).resolve()
  if (requested.source === "environment" && requested.id !== snapshot.profile) throw new Error(`The headless auth snapshot is for profile ${snapshot.profile}, but this run selects profile ${requested.id}. Run with --auth-profile ${snapshot.profile}.`)
  const profiles = selected(snapshot.profile)
  const access = await profiles.acquireAccess({ createDefault: true, createSelected: snapshot.profile })
  access.close()
  const profile = await profiles.resolve()
  return { profiles, profile, snapshot: await captureHeadlessSnapshotConnection(snapshot, profile.directory, providers) }
}

/** Owns finite subscription admission services. Disposal closes admission and
 * waits for active leases before releasing usage observations. A usage reader
 * that asks a program that owns the login starts it only in `launcher`. */
export function createHeadlessSubscriptionAdmission(moduleSelection: FirstPartyModuleSnapshot, launcher: LauncherScope | undefined) {
  const usagePool = createSubscriptionUsageServicePool({
    create: (profile, thresholds) => createSubscriptionUsageService({
      profile: () => profile,
      registry: () => accessProviderRegistry(moduleSelection()),
      thresholds: () => thresholds,
      monitor: false,
      ...(launcher === undefined ? {} : { launcher }),
    }),
  })
  const consentCache = createSubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>()
  return {
    capture: (profile: SubscriptionUsageProfile, ...[candidates, providerSettings]: Parameters<CaptureSubscriptionAdmission>): ReturnType<CaptureSubscriptionAdmission> => captureSubscriptionAdmission({
      profile, candidates, providerSettings, registry: accessProviderRegistry(moduleSelection()), pool: usagePool, consentCache,
    }),
    dispose: () => {
      usagePool.closeAdmission()
      consentCache.clear()
      return usagePool.settled()
    },
  }
}

const log = Log.create({ service: "headless-profile-runtime" })

/** The notify seam of a headless run: no person reads its notifications, so it records each raise by its source. */
function logNotification(episode: NotificationEpisodeInput): void {
  if (episode.type === "raise") log.warn("headless run raised a notification", { sourceId: episode.occurrence.sourceId, severity: episode.occurrence.severity })
}

interface HeadlessProfileRuntimeOptions {
  readonly userDataRoot: string
  /** The one models.dev catalog client this run reads and refreshes. */
  readonly modelsClient: ModelsClient
  readonly profile: { readonly id: string; readonly directory: string }
  readonly moduleSelection: FirstPartyModuleSnapshot
  readonly allowTrainingRoutes: boolean
  readonly resolveKey: KeyResolver
  readonly connection?: ProviderConnection
  readonly workflowPreparation: Omit<ProfileRequestWorkflowPreparation, "onNotification">
  readonly captureRuntimeConfig: CaptureRuntimeConfig
  readonly captureSubscriptionAdmission: CaptureSubscriptionAdmission
  readonly acquireUsageSettlementAuthority: (profile: { readonly profileDir: string; readonly profileId: string }) => Promise<UsageSettlementAuthorityLease>
  readonly prepareWorkflowDeps: (input: PrepareWorkflowDepsInput) => Promise<WorkflowDeps>
}

export interface HeadlessProfileRuntime {
  readonly profileId: string
  readonly profileDirectory: string
  prepare(signal?: AbortSignal): Promise<WorkflowDeps>
  generation(): UsageAuthorityGeneration
  assertGeneration(expected: UsageAuthorityGeneration): void
  dispose(): Promise<void>
}

/** Prepares one profile-bound request runtime without owning a workspace store.
 * The callback must settle all requests before returning. All profile resources
 * are released on preparation failure, callback failure, and completion. */
export async function withHeadlessProfileRuntime<T>(
  options: Omit<HeadlessProfileRuntimeOptions, "modelsClient" | "captureSubscriptionAdmission" | "acquireUsageSettlementAuthority" | "prepareWorkflowDeps"> & { readonly signal?: AbortSignal },
  run: (deps: WorkflowDeps) => Promise<T>,
): Promise<T> {
  await using resources = new AsyncDisposableStack()
  const usage = createHeadlessUsageAuthorityOwner(options.profile)
  const subscriptions = createHeadlessSubscriptionAdmission(options.moduleSelection, options.workflowPreparation.launcher)
  resources.defer(subscriptions.dispose)
  resources.defer(usage.settled)
  const runtime = await createHeadlessProfileRuntime({
    ...options,
    modelsClient: getSharedModelsClient(options.userDataRoot),
    captureSubscriptionAdmission: (...request) => subscriptions.capture(options.profile, ...request),
    acquireUsageSettlementAuthority: usage.acquire,
    prepareWorkflowDeps,
  })
  resources.defer(runtime.dispose)
  return await run(await runtime.prepare(options.signal))
}

/** Owns one finite, exact profile-request generation for a headless host. */
export async function createHeadlessProfileRuntime(options: HeadlessProfileRuntimeOptions): Promise<HeadlessProfileRuntime> {
  const authConditions = createAuthConditionOwner()
  const providerModels = createProviderModelPreferenceService({
    displayName: (providerId) => accessProviderRegistry(options.moduleSelection()).selection.displayName(providerId),
    allowTrainingRoutes: () => options.allowTrainingRoutes,
    ...providerModelPreferencePersistence(() => options.profile.directory),
  })
  const prepareEligibility = createEligibilityPreparation({
    allowTrainingRoutes: () => options.allowTrainingRoutes,
    userDataRoot: options.userDataRoot,
    resolveKey: options.resolveKey,
    ...(options.workflowPreparation.launcher === undefined ? {} : { launcher: options.workflowPreparation.launcher }),
    moduleSelection: options.moduleSelection,
    prepare: providerModels.prepare,
    publish: providerModels.publish,
    current: providerModels.state,
    inputRevision: authProfileEligibilityInputRevision,
    observeAuth: (profile) => {
      const load = loadAuthStoreWithDiagnostics(profile.directory, installedCredentialProviderIds(), credentialSlotClassifier(options.moduleSelection()), false)
      authConditions.observeLoad(profile.directory, load)
      return load
    },
    ...(options.connection === undefined ? {
      normalizeProfile: async (profile: { readonly directory: string }) => {
        if (await normalizeAuthProfile(profile.directory, credentialSlotClassifier(options.moduleSelection()), installedCredentialProviderIds(), installedAccessProviderDefinitions()) === "read-only") authConditions.observeNormalizationRefusal(profile.directory)
      },
    } : {}),
    ...(options.connection ? connectionEligibilitySources(options.connection, options.profile.directory, options.moduleSelection, options.modelsClient) : {}),
    refreshMetadata: (signal) => options.modelsClient.refresh(signal),
  })
  let generation: UsageAuthorityGeneration | undefined
  const acquire = async (profile: { readonly profileDir: string; readonly profileId: string }) => {
    if (profile.profileId !== options.profile.id || profile.profileDir !== options.profile.directory) throw new Error(`Headless profile mismatch: expected ${options.profile.id}`)
    const lease = await options.acquireUsageSettlementAuthority(profile)
    const captured = { profileId: lease.profileId, authorityIncarnation: lease.authorityIncarnation }
    if (generation !== undefined && (generation.profileId !== captured.profileId || generation.authorityIncarnation !== captured.authorityIncarnation)) {
      await lease.release()
      throw new Error(`Usage authority generation changed for profile ${options.profile.id}`)
    }
    generation = captured
    return lease
  }
  const requests = createProfileRequestService({
    userDataRoot: options.userDataRoot,
    workflowPreparation: { ...options.workflowPreparation, onNotification: logNotification },
    prepareEligibility: async (profile, preparationOptions) => {
      await prepareEligibility(profile, preparationOptions)
      return prepareEligibility.capture(profile, (state, auth) => ({ worker: state.worker, auth }), preparationOptions.signal)
    },
    awaitDiscovery: prepareEligibility.awaitDiscovery,
    captureSubscriptionAdmissionFor: () => options.captureSubscriptionAdmission,
    acquireUsageSettlementAuthority: acquire,
    authConditions,
    captureRuntimeConfigFor: () => options.captureRuntimeConfig,
    // A headless generation captured its eligibility once, so a saved refusal reaches the next run.
    recordModelRefusal: (record) => { prepareEligibility.recordModelRefusal(record) },
    prepareWorkflowDeps: options.prepareWorkflowDeps,
  })
  let disposed: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposed ??= (async () => {
      await prepareEligibility.dispose()
      await providerModels.dispose()
    })()
    return disposed
  }
  return {
    profileId: options.profile.id,
    profileDirectory: options.profile.directory,
    prepare: async (signal) => {
      try {
        return await requests.prepare(options.profile.id, signal)
      } catch (error) {
        await dispose()
        throw error
      }
    },
    generation: () => generation ?? (() => { throw new Error("Headless profile generation is not prepared") })(),
    assertGeneration(expected) {
      const current = generation
      if (current === undefined || current.profileId !== expected.profileId || current.authorityIncarnation !== expected.authorityIncarnation) throw new Error("Headless profile Usage authority identity does not match")
    },
    dispose,
  }
}
