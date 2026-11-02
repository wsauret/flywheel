import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createProfileRequestService } from "../../../../src/orchestration/auth/profile-request-service.js"
import { captureRuntimeConfigRequest, type CaptureRuntimeConfig } from "../../../../src/orchestration/agent-runtime/request-config.js"
import { CONFIG_DEFAULTS } from "../../../../src/orchestration/config/schema.js"

function runtimeConfig(profileId: string, allowTrainingRoutes = false): ReturnType<CaptureRuntimeConfig> {
  const base = captureRuntimeConfigRequest({
    revision: 1,
    config: structuredClone(CONFIG_DEFAULTS),
    warnings: [],
    diagnostics: [],
    sourceIdentity: "test",
    status: { kind: "valid" },
  }, profileId)
  return { ...base, allowTrainingRoutes }
}

describe("profile request service", () => {
  test("prepares every profile-bound admission port before constructing workflow dependencies", async () => {
    const calls: string[] = []
    const signal = new AbortController().signal
    const eligibility = { worker: { picker: new Map() } }
    const authority = {
      profileId: "profile-a",
      authorityIncarnation: "incarnation-a",
      append: () => ({ kind: "appended" as const }),
      release: async () => { calls.push("authority.release") },
    }
    const service = createProfileRequestService({
      userDataRoot: "/account",
      workflowPreparation: { marker: "base" },
      prepareEligibility: async (profile, options) => {
        const mode = "settled" in options && options.settled === true ? "settled" : "provisional"
        calls.push(`eligibility:${profile.id}:${profile.directory}:${options.signal ? "signal" : "none"}:${mode}`)
        return eligibility
      },
      awaitDiscovery: async (profile, accessSignal) => { calls.push(`discovery:${profile.id}:${profile.directory}:${accessSignal === signal ? "signal" : "other"}`) },
      captureSubscriptionAdmissionFor: (profileId, profileDirectory) => {
        calls.push(`subscription:${profileId}:${profileDirectory}`)
        return async () => ({ consent: undefined })
      },
      acquireUsageSettlementAuthority: async (profile) => {
        calls.push(`authority:${profile.profileId}:${profile.profileDir}`)
        return authority
      },
      authConditions: { marker: "conditions" },
      captureRuntimeConfigFor: (profileId) => () => runtimeConfig(profileId, profileId === "profile-a"),
      prepareWorkflowDeps: async (input) => {
        calls.push(`workflow:${input.activeProfileId()}:${input.authDirectory()}:${input.usageAuthority.profileId}:${input.usageAuthority.authorityIncarnation}`)
        await input.awaitModelAccessSettled(signal)
        return { activeProfileId: input.activeProfileId() }
      },
    })
    const profileDirectory = join("/account", "auth", "profiles", "profile-a")

    await expect(service.prepare("profile-a", signal)).resolves.toEqual({ activeProfileId: "profile-a" })
    expect(calls).toEqual([
      `eligibility:profile-a:${profileDirectory}:signal:settled`,
      `authority:profile-a:${profileDirectory}`,
      "authority.release",
      `subscription:profile-a:${profileDirectory}`,
      `workflow:profile-a:${profileDirectory}:profile-a:incarnation-a`,
      `discovery:profile-a:${profileDirectory}:signal`,
    ])
  })

  test("rejects a mismatched Usage authority before workflow dependency construction", async () => {
    let constructed = false
    const service = createProfileRequestService({
      userDataRoot: "/account",
      workflowPreparation: {},
      prepareEligibility: async () => ({ worker: { picker: new Map() } }),
      awaitDiscovery: async () => {},
      captureSubscriptionAdmissionFor: () => async () => ({ consent: undefined }),
      acquireUsageSettlementAuthority: async () => ({
        profileId: "profile-b",
        authorityIncarnation: "incarnation-b",
        append: () => ({ kind: "appended" as const }),
        release: async () => {},
      }),
      authConditions: {},
      captureRuntimeConfigFor: (profileId) => () => runtimeConfig(profileId),
      prepareWorkflowDeps: async () => {
        constructed = true
        return {}
      },
    })

    await expect(service.prepare("profile-a")).rejects.toThrow("Usage authority profile mismatch: expected profile-a, received profile-b")
    expect(constructed).toBe(false)
  })

  test("binds opposite training-route policies to each prepared session profile", async () => {
    const service = createProfileRequestService({
      userDataRoot: "/account",
      workflowPreparation: {},
      prepareEligibility: async () => ({ worker: {} }),
      awaitDiscovery: async () => {},
      captureSubscriptionAdmissionFor: () => ({}),
      acquireUsageSettlementAuthority: async ({ profileId }) => ({
        profileId,
        authorityIncarnation: `incarnation-${profileId}`,
        append: () => ({ kind: "appended" as const }),
        release: async () => {},
      }),
      authConditions: {},
      captureRuntimeConfigFor: (profileId) => () => runtimeConfig(profileId, profileId === "training-on"),
      prepareWorkflowDeps: async (input): Promise<CaptureRuntimeConfig> => input.captureRuntimeConfig,
    })

    const trainingOn = await service.prepare("training-on")
    const trainingOff = await service.prepare("training-off")

    expect(trainingOn().profileId).toBe("training-on")
    expect(trainingOn().allowTrainingRoutes).toBe(true)
    expect(trainingOff().profileId).toBe("training-off")
    expect(trainingOff().allowTrainingRoutes).toBe(false)
  })
})
