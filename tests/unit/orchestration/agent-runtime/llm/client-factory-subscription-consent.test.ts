import { afterEach, describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import { captureProviderConnection } from "../../../../../src/infra/auth/auth-context.js";
import { openExistingAuthProfileDirectory } from "../../../../../src/infra/auth/auth-profile-store.js";
import { createSubscriptionSpendConsentStore } from "../../../../../src/infra/auth/subscription-spend-consent-store.js";
import { createSubscriptionSpendEnvelope } from "../../../../../src/infra/auth/subscription-spend-consent.js";
import { createSubscriptionAccountIdentity } from "../../../../../src/infra/llm/subscription-account-identity.js";
import { createAgentRuntime } from "../../../../../src/orchestration/agent-runtime/factory.js";
import { createSubscriptionUsageServicePool } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js";
import { createSubscriptionUsageService } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js";
import { resetSharedLlmClients } from "../../../../../src/orchestration/config/llm-clients.js";
import { captureSubscriptionAdmission } from "../../../../../src/orchestration/subscription-spend-consent/admission-capture.js";
import { createSubscriptionSpendConsentCaptureCache } from "../../../../../src/orchestration/subscription-spend-consent/capture-cache.js";
import type { SubscriptionSpendConsentCapture } from "../../../../../src/orchestration/subscription-spend-consent/subscription-spend-consent-service.js";
import { authProviders } from "../../../../helpers/auth-context.js";
import { testDirectories } from "../../../../helpers/directories.js";
import { repoDefinitions } from "../../../../helpers/project-definitions.js";
import { testCapabilityModules, testProviderEligibility, testProviderRegistry, testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { createProfileFixture, definition, registry, writeAccounts } from "../../auth/provider-observations/_service-fixtures.js";

describe("subscription consent serving composition", () => {
  const { profile, cleanup } = createProfileFixture()
  afterEach(() => {
    // A later catalog refresh must not recreate this test's deleted profile.
    resetSharedLlmClients()
    cleanup()
  })
  const auth = {
    providers: authProviders({ apiKeys: { openai_api: "test-openai-key" } }),
    credentialLineages: {}, droppedCredentials: [],
  }

  test.each([false, true])("nonresident paid admission captures consent without reading usage and releases its lease (throw: %s)", async (throwDuringConsent) => {
    const directory = profile("nonresident-admission")
    const provider = definition("github_copilot")
    writeAccounts(directory, [provider])
    const profileId = "profile-a"
    const account = createSubscriptionAccountIdentity(provider.id, "account", "github_copilot-identity")
    const envelope = createSubscriptionSpendEnvelope(profileId, account, "automatic")
    const access = openExistingAuthProfileDirectory(directory)
    try {
      const consent = createSubscriptionSpendConsentStore({ profileId, access, currentAccounts: () => [account] })
      const initial = await consent.read([envelope])
      await consent.save({ expectedIncarnation: initial.incarnation, expectedRevision: initial.revision, envelopes: [envelope], acceptedEnvelopeIds: [envelope.id], reviewedEnvelopeIds: [envelope.id] })
    } finally { access.close() }
    const order: string[] = []
    const consentCache = createSubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>()
    const pool = createSubscriptionUsageServicePool({
      create: (resolved) => {
        order.push("create")
        const service = createSubscriptionUsageService({
          profile: () => resolved,
          registry: () => registry([provider], new Map([[provider.id, async () => {
            order.push("refresh")
            return { kind: "success", report: {
              providerId: provider.id, instanceId: "account", identity: "github_copilot-identity", providerStatus: "ok", observedAtMs: Date.now(),
              metrics: [{ metricKey: "ai_credits", label: "AI Credits", rank: 0, scope: { kind: "account" }, timing: { kind: "unavailable" }, allowanceMode: "finite", usedFraction: 0.5, remaining: { kind: "count", value: 50, unit: "credits", provenance: "provider", precision: "exact" } }],
              spendSources: [{ kind: "automatic-billing", enablement: "enabled" }],
            } }
          }]])),
          thresholds: () => [],
        })
        return { ...service, closeAdmission: () => { order.push("close"); service.closeAdmission() } }
      },
    })
    const acquire = pool.acquire
    pool.acquire = async (resolved) => {
      order.push("acquire")
      const lease = await acquire(resolved)
      return { ...lease, release: async () => { order.push("release"); await lease.release() } }
    }
    const connection = captureProviderConnection({
      profileId, auth: { ...auth, providers: authProviders({ base: auth.providers, oauth: ["github_copilot"], without: ["openai_api"] }),}, authDir: directory,
      subscriptionCredentials: new Map([[provider.id, [{ instanceId: "account", identity: "github_copilot-identity", credential: { type: "oauth", access: Redacted.make("copilot-token"), refresh: Redacted.make("github-token"), expires: 1 } }]]]),
      oauthPersistence: "memory-only",
    })
    const eligibility = testProviderEligibility()
    const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
      profileId, getAuth: () => connection.auth, definitions: repoDefinitions(), moduleSelection: testCapabilityModules(), captureRuntimeConfig: testRuntimeConfigCapture,
      authDirectory: () => directory, connection, userDataRoot: directory,
      getProviderModelEligibility: () => ({
        modelUnavailableReason: eligibility.modelUnavailableReason,
        candidateModelUnavailableReason: (candidate) => candidate.spendMode === "automatic" ? undefined : "automatic only",
        candidateOffering: eligibility.candidateOffering,
      }),
      captureSubscriptionAdmission: (candidates, providerSettings) => captureSubscriptionAdmission({
        candidates, providerSettings, registry: testProviderRegistry(), profile: { id: profileId, directory }, pool,
        consentCache: {
          ...consentCache,
          capture: async (request) => {
            order.push("consent")
            if (throwDuringConsent) throw new Error("consent capture failed")
            return consentCache.capture(request)
          },
        },
      }),
    })
    try {
      const admission = (await runtime.createLLMClient("gpt-6-luna", undefined, undefined, testProviderSessionLifetime())).admitRequest()
      if (throwDuringConsent) {
        await expect(admission).rejects.toThrow("consent capture failed")
      } else {
        const request = await admission
        expect((await request.plannedAttempt()).accessProviderCandidate?.spendMode).toBe("automatic")
      }
      expect(order).toEqual(["acquire", "create", "consent", "release", "close"])
    } finally { pool.closeAdmission(); await pool.settled() }
  })

  test("defers consent capture until a request is served", async () => {
    const directories = testDirectories("/scratch")
    const connection = captureProviderConnection({
      auth,
      authDir: directories.userDataRoot,
      profileId: "default",
      subscriptionCredentials: new Map(),
    })
    let captures = 0
    let authorityRevision = 3
    const capturedRevisions: number[] = []
    const admissionOrder: string[] = []
    const allowanceStarted = Promise.withResolvers<void>()
    const allowanceRelease = Promise.withResolvers<void>()
    const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
      profileId: "default",
      getAuth: () => auth,
      definitions: repoDefinitions(),
      moduleSelection: testCapabilityModules(),
      captureRuntimeConfig: testRuntimeConfigCapture,
      authDirectory: () => directories.userDataRoot,
      connection,
      userDataRoot: directories.userDataRoot,
      getProviderModelEligibility: () => testProviderEligibility(),
      captureSubscriptionAdmission: async (candidates) => {
        expect(candidates).toEqual([{ kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }])
        admissionOrder.push("allowance-start")
        allowanceStarted.resolve()
        await allowanceRelease.promise
        admissionOrder.push("allowance-settled", "consent")
        captures += 1
        capturedRevisions.push(authorityRevision)
        return Object.freeze({
          subscriptionAllowanceFor: () => ({ freshness: "unknown" as const, allowance: "unknown" as const }),
          bankedResetFor: () => false,
          expiringResetFor: () => undefined,
          consent: Object.freeze({
            profileId: "profile-a",
            usageGeneration: 7,
            authorityIncarnation: "authority-a",
            authorityRevision,
            rows: Object.freeze([]),
            authorizations: new Map(),
          }),
        })
      },
    })

    const capture = await runtime.captureProviderConnection()
    const plan = capture.providers.selection.plan("gpt-5.5", capture.connection, capture.eligibility)
    expect(plan.kind).toBe("admitted")
    if (plan.kind !== "admitted") throw new Error(plan.reason)
    const client = await capture.admit(new Map([["gpt-5.5", plan]])).createLLMClient("gpt-5.5", undefined, undefined, testProviderSessionLifetime())

    expect(captures).toBe(0)
    const first = client.plannedAttempt()
    await allowanceStarted.promise
    expect(captures).toBe(0)
    allowanceRelease.resolve()
    expect((await first).accessProvider).toBe("openai_api")
    authorityRevision = 4
    expect((await client.plannedAttempt()).accessProvider).toBe("openai_api")
    expect(captures).toBe(2)
    expect(capturedRevisions).toEqual([3, 4])
    expect(admissionOrder).toEqual(["allowance-start", "allowance-settled", "consent", "allowance-start", "allowance-settled", "consent"])
  })

  test("captures one request's admission once for its role standing and its selected client, and the next request captures again (ARCH-PROVIDERS-080)", async () => {
    const directories = testDirectories("/scratch")
    const connection = captureProviderConnection({ auth, authDir: directories.userDataRoot, profileId: "default", subscriptionCredentials: new Map() })
    let captures = 0
    const runtime = createAgentRuntime({ notify: () => {}, awaitModelAccessSettled: async () => {},
      profileId: "default", getAuth: () => auth, definitions: repoDefinitions(), moduleSelection: testCapabilityModules(),
      captureRuntimeConfig: testRuntimeConfigCapture, authDirectory: () => directories.userDataRoot, connection,
      userDataRoot: directories.userDataRoot, getProviderModelEligibility: () => testProviderEligibility(),
      captureSubscriptionAdmission: async () => {
        captures += 1
        return Object.freeze({
          subscriptionAllowanceFor: () => ({ freshness: "unknown" as const, allowance: "unknown" as const }), bankedResetFor: () => false, expiringResetFor: () => undefined,
          consent: Object.freeze({ profileId: "default", usageGeneration: 1, authorityIncarnation: "authority", authorityRevision: 1, rows: Object.freeze([]), authorizations: new Map() }),
        })
      },
    })
    const capture = await runtime.captureProviderConnection()
    const plan = capture.providers.selection.plan("gpt-5.5", capture.connection, capture.eligibility)
    if (plan.kind !== "admitted") throw new Error(plan.reason)
    // The API key is the model's only route, so it serves on paid spend.
    expect(await capture.standing(plan, undefined)).toEqual({ kind: "paid" })
    const client = await capture.admit(new Map([["gpt-5.5", plan]])).createLLMClient("gpt-5.5", undefined, undefined, testProviderSessionLifetime())
    const attempt = await client.plannedAttempt(undefined, { eligibility: capture.eligibility, allowTrainingRoutes: false, requestAdmission: capture.requestAdmission })
    expect(attempt.accessProvider).toBe("openai_api")
    expect(captures).toBe(1)
    await (await runtime.captureProviderConnection()).standing(plan, undefined)
    expect(captures).toBe(2)
  })
})
