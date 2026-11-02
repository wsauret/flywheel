import { authDir } from "../../infra/paths.js"
import type { UsageAuthorityGeneration, UsageSettlementAuthorityLease } from "../agent-runtime/usage-settlement.js"
import type { CaptureRuntimeConfig } from "../agent-runtime/request-config.js"
import type { AuthContext } from "../../infra/auth/auth-context.js"
import type { RecordModelRefusal } from "../agent-runtime/llm/client-factory.js"

import type { PrepareWorkflowDepsInput, WorkflowDeps } from "../workflow-host/deps.js"

export type ProfileRequestWorkflowPreparation = Omit<
  PrepareWorkflowDepsInput,
  "authDirectory" | "activeProfileId" | "providerModelEligibility" | "captureModelAccess" | "captureSubscriptionAdmission" | "acquireUsageSettlementAuthority" | "usageAuthority" | "authConditions" | "captureRuntimeConfig" | "recordModelRefusal" | "waitForLogin" | "awaitModelAccessSettled"
>

type ProfileRequestWorkflowInput<Preparation, Eligibility, SubscriptionAdmission, AuthConditions> = Preparation & {
  readonly authDirectory: () => string
  readonly activeProfileId: () => string
  readonly providerModelEligibility: () => Eligibility
  readonly captureModelAccess: () => Promise<{ readonly worker: Eligibility; readonly auth?: AuthContext }>
  readonly captureSubscriptionAdmission: SubscriptionAdmission
  readonly acquireUsageSettlementAuthority: (profile: { readonly profileDir: string; readonly profileId: string }) => Promise<UsageSettlementAuthorityLease>
  readonly usageAuthority: UsageAuthorityGeneration
  readonly authConditions: AuthConditions
  readonly captureRuntimeConfig: CaptureRuntimeConfig
  readonly capturedAuth?: AuthContext
  readonly recordModelRefusal?: RecordModelRefusal
  readonly waitForLogin?: true
  readonly awaitModelAccessSettled: (signal: AbortSignal) => Promise<void>
}

interface ProfileRequestServiceOptions<Preparation, Eligibility, SubscriptionAdmission, AuthConditions, Result> {
  readonly userDataRoot: string
  readonly workflowPreparation: Preparation
  readonly prepareEligibility: (
    profile: { readonly id: string; readonly directory: string },
    options: { readonly signal?: AbortSignal; readonly settled: true },
  ) => Promise<{ readonly worker: Eligibility; readonly auth?: AuthContext }>
  /** Resolves when the profile's owned discovery has settled (`EligibilityPreparation.awaitDiscovery`). */
  readonly awaitDiscovery: (profile: { readonly id: string; readonly directory: string }, signal: AbortSignal) => Promise<void>
  readonly captureSubscriptionAdmissionFor: (profileId: string, profileDirectory: string) => SubscriptionAdmission
  readonly acquireUsageSettlementAuthority: (profile: { readonly profileDir: string; readonly profileId: string }) => Promise<UsageSettlementAuthorityLease>
  readonly authConditions: AuthConditions
  readonly captureRuntimeConfigFor: (profileId: string) => CaptureRuntimeConfig
  /** Receives every refusal of a model that a request of a prepared runtime proved. */
  readonly recordModelRefusal?: RecordModelRefusal
  /** Enables account login waiting only for an interactive executor. */
  readonly waitForLogin?: true
  readonly prepareWorkflowDeps: (input: ProfileRequestWorkflowInput<Preparation, Eligibility, SubscriptionAdmission, AuthConditions>) => Promise<Result>
}

export interface ProfileRequestService<Result = WorkflowDeps> {
  prepare(profileId: string, signal?: AbortSignal): Promise<Result>
}

/** Completes every profile-bound request authority before Agent and provider construction can begin. */
export function createProfileRequestService<Preparation, Eligibility, SubscriptionAdmission, AuthConditions, Result>(
  options: ProfileRequestServiceOptions<Preparation, Eligibility, SubscriptionAdmission, AuthConditions, Result>,
): ProfileRequestService<Result> {
  return {
    async prepare(profileId, signal): Promise<Result> {
      const profile = { id: profileId, directory: authDir(options.userDataRoot, profileId) }
      const eligibility = await options.prepareEligibility(profile, { signal, settled: true })
      const lease = await options.acquireUsageSettlementAuthority({ profileDir: profile.directory, profileId })
      const usageAuthority: UsageAuthorityGeneration = {
        profileId: lease.profileId,
        authorityIncarnation: lease.authorityIncarnation,
      }
      await lease.release()
      if (usageAuthority.profileId !== profileId) {
        throw new Error(`Usage authority profile mismatch: expected ${profileId}, received ${usageAuthority.profileId}`)
      }
      return options.prepareWorkflowDeps({
        ...options.workflowPreparation,
        authDirectory: () => profile.directory,
        activeProfileId: () => profile.id,
        providerModelEligibility: () => eligibility.worker,
        captureModelAccess: () => options.prepareEligibility(profile, { settled: true }),
        captureSubscriptionAdmission: options.captureSubscriptionAdmissionFor(profile.id, profile.directory),
        acquireUsageSettlementAuthority: options.acquireUsageSettlementAuthority,
        usageAuthority,
        authConditions: options.authConditions,
        captureRuntimeConfig: options.captureRuntimeConfigFor(profile.id),
        capturedAuth: eligibility.auth,
        ...(options.recordModelRefusal === undefined ? {} : { recordModelRefusal: options.recordModelRefusal }),
        ...(options.waitForLogin === undefined ? {} : { waitForLogin: options.waitForLogin }),
        awaitModelAccessSettled: (accessSignal) => options.awaitDiscovery(profile, accessSignal),
      })
    },
  }
}
