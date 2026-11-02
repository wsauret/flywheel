import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { writeFileSync } from "node:fs"
import type { AccessProviderCandidate } from "../../../../../src/infra/llm/access-provider.js"
import { captureCopilotAllowanceAdmission } from "../../../../../src/orchestration/modules/provider-github-copilot/allowance-admission.js"
import { createSubscriptionUsageService, type SubscriptionUsageService } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { createProfileFixture, definition, registry, report, writeAccounts } from "../../auth/provider-observations/_service-fixtures.js"
import { captureSubscriptionAdmission } from "../../../../../src/orchestration/subscription-spend-consent/admission-capture.js"
import { createSubscriptionSpendConsentCaptureCache } from "../../../../../src/orchestration/subscription-spend-consent/capture-cache.js"
import type { SubscriptionSpendConsentCapture } from "../../../../../src/orchestration/subscription-spend-consent/subscription-spend-consent-service.js"
import { createSubscriptionUsageServicePool } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js"
import type { ProviderAllowanceFactory } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js"

const { profile, cleanup } = createProfileFixture()
afterEach(cleanup)
const candidate = (instanceId: string, spendMode: "included" | "prepaid" | "automatic" = "included"): AccessProviderCandidate => ({ kind: "subscription", providerId: "github_copilot", instanceId, spendMode })

describe("request-scoped Copilot allowance", () => {
  test.each([false, true])("zero Copilot preserves consent lease ownership (resident: %s)", async (resident) => {
    const directory = profile("zero-copilot-admission")
    const resolved = { id: "default", directory }
    const order: string[] = []
    const pool = createSubscriptionUsageServicePool({
      create: () => {
        const service = createSubscriptionUsageService({ profile: () => resolved, registry: () => registry([], new Map()), thresholds: () => [] })
        return {
          ...service,
          metric: () => { throw new Error("zero Copilot read allowance") },
          checkAccounts: async () => { throw new Error("zero Copilot refreshed allowance") },
          closeAdmission: () => { order.push("close"); service.closeAdmission() },
        }
      },
    })
    const acquire = pool.acquire
    pool.acquire = async (requested) => {
      order.push("acquire")
      const lease = await acquire(requested)
      return { ...lease, release: async () => { order.push("release"); await lease.release() } }
    }
    const residentLease = resident ? await pool.acquire(resolved) : undefined
    order.length = 0
    try {
      const copilot: ProviderAllowanceFactory = ({ candidates, usage, settings }) => captureCopilotAllowanceAdmission({ candidates, service: usage, monthlyCreditCap: settings.monthly_credit_cap })
      const capture = await captureSubscriptionAdmission({
        candidates: [{ kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }],
        providerSettings: {},
        registry: { allowance: new Map([["github_copilot", copilot]]), settings: new Map(), selection: registry([], new Map()).selection },
        profile: resolved, pool, ...(residentLease ? { residentLease } : {}),
        consentCache: createSubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>(),
      })
      expect(capture.consent.profileId).toBe("default")
      expect(capture.subscriptionAllowanceFor(candidate("account"))).toEqual({ allowance: "unknown" })
      expect(Object.isFrozen(capture)).toBe(true)
      expect(Object.isFrozen(capture.consent)).toBe(true)
      expect(Object.isFrozen(capture.subscriptionAllowanceFor)).toBe(true)
      expect(order).toEqual(resident ? [] : ["acquire", "release", "close"])
    } finally { await residentLease?.release(); pool.closeAdmission(); await pool.settled() }
  })

  test("zero relevant candidates do not touch the supplied service", async () => {
    const service = {
      metric: () => { throw new Error("unrelated request read usage") },
      checkAccounts: async () => { throw new Error("unrelated request checked usage") },
    }
    const allowance = await captureCopilotAllowanceAdmission({
      candidates: [{ kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }, { kind: "subscription", providerId: "supergrok", instanceId: "account", spendMode: "included" }, candidate("paid", "prepaid"), candidate("paid", "automatic")],
      service, monthlyCreditCap: 1,
    })
    expect(allowance(candidate("account"))).toEqual({ allowance: "unknown" })
    expect(allowance(candidate("paid", "prepaid"))).toEqual({ allowance: "unknown" })
    expect(allowance(candidate("paid", "automatic"))).toEqual({ allowance: "unknown" })
    const empty = await captureCopilotAllowanceAdmission({
      candidates: [], service, monthlyCreditCap: undefined,
    })
    expect(empty(candidate("account"))).toEqual({ allowance: "unknown" })
  })

  test("deduplicates modes, reads cold and pooled once, reuses fresh finite, and leaves siblings untouched", async () => {
    const directory = profile("exact-copilot")
    const providers = [definition("github_copilot"), definition("supergrok")]
    writeFileSync(join(directory, "auth.json"), JSON.stringify(Object.fromEntries(providers.map(({ id }) => [id,
      ([
        ["finite", "11111111-1111-4111-8111-111111111111"],
        ["pooled", "22222222-2222-4222-8222-222222222222"],
        ["unrelated", "33333333-3333-4333-8333-333333333333"],
      ] as const).map(([instanceId, lineageId]) => ({
        id: instanceId,
        identity: instanceId,
        lineageId,
        credential: { type: "oauth", access: "access", refresh: "refresh", expires: 9_999_999_999 },
      })),
    ]))))
    let used = 42
    let now = 10_000
    const reads: string[] = []
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(providers, new Map(providers.map(({ id }) => [id, async ({ account }) => {
        reads.push(`${id}/${account.instanceId}`)
        return { kind: "success" as const, report: {
          providerId: id, instanceId: account.instanceId, identity: account.identity!, providerStatus: "ok" as const, observedAtMs: now,
          metrics: [{ metricKey: "ai_credits", label: "AI Credits", rank: 0, scope: { kind: "account" as const }, timing: { kind: "unavailable" as const }, allowanceMode: account.instanceId === "finite" ? "finite" as const : "pooled" as const, used: { kind: "count" as const, value: used, unit: "credits", precision: "exact" as const, provenance: "provider" as const }, ...(account.instanceId === "finite" ? { remaining: { kind: "count" as const, value: used, unit: "AI Credits", precision: "exact" as const, provenance: "provider" as const } } : {}) }],
        } }
      }]))),
      thresholds: () => [], now: () => now,
    })
    const candidates = [candidate("finite"), candidate("pooled"), candidate("pooled", "prepaid"), candidate("finite", "automatic")]
    const old = await captureCopilotAllowanceAdmission({ service, candidates, monthlyCreditCap: undefined })
    expect(reads).toEqual(["github_copilot/finite", "github_copilot/pooled"])
    used = 84
    now += 1
    const latest = await captureCopilotAllowanceAdmission({ service, candidates, monthlyCreditCap: undefined })
    expect(reads).toEqual(["github_copilot/finite", "github_copilot/pooled", "github_copilot/pooled"])
    expect(old(candidate("pooled"))).toEqual({ freshness: "fresh", allowance: "pooled", usedCredits: 42 })
    expect(latest(candidate("pooled"))).toEqual({ freshness: "fresh", allowance: "pooled", usedCredits: 84 })
    expect(latest(candidate("pooled", "automatic"))).toEqual({ allowance: "unknown" })
    expect(latest(candidate("unrelated"))).toEqual({ allowance: "unknown" })
    expect(latest(candidate("finite"))).toEqual({ freshness: "fresh", allowance: "finite", metric: "ai_credits", remaining: 42 })
    now = 310_001
    await captureCopilotAllowanceAdmission({ service, candidates: [candidate("finite")], monthlyCreditCap: undefined })
    expect(reads.at(-1)).toBe("github_copilot/finite")
    expect(reads).toHaveLength(4)
    await service.settled()
  })

  test("unknown allowance reads once per admission at most, and a fresh report without a meter is not read again", async () => {
    const directory = profile("unknown-copilot")
    const provider = definition("github_copilot")
    writeAccounts(directory, [provider])
    let reads = 0
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry([provider], new Map([[provider.id, async () => ({ kind: "success" as const, report: report(provider.id, 10_000 + ++reads) })]])),
      thresholds: () => [], now: () => 10_000,
    })
    const input = { service, candidates: [candidate("account")], monthlyCreditCap: undefined }
    expect((await captureCopilotAllowanceAdmission(input))(candidate("account"))).toEqual({ allowance: "unknown" })
    expect(reads).toBe(1)
    await captureCopilotAllowanceAdmission(input)
    expect(reads).toBe(1)
    await service.settled()
  })

  test("a failed Copilot read is not repeated on each admission, only after the retry spacing or on an explicit refresh", async () => {
    const directory = profile("failed-copilot")
    const provider = definition("github_copilot")
    writeAccounts(directory, [provider])
    let reads = 0
    let now = 10_000
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry([provider], new Map([[provider.id, async () => { reads += 1; return { kind: "fetch-failure" as const } }]])),
      thresholds: () => [], now: () => now,
    })
    const input = { service, candidates: [candidate("account")], monthlyCreditCap: undefined }
    expect((await captureCopilotAllowanceAdmission(input))(candidate("account"))).toEqual({ allowance: "unknown" })
    expect(reads).toBe(1)
    now += 59_999
    expect((await captureCopilotAllowanceAdmission(input))(candidate("account"))).toEqual({ allowance: "unknown" })
    expect(reads).toBe(1)
    await service.check({ forceRefresh: true })
    expect(reads).toBe(2)
    now += 60_000
    await captureCopilotAllowanceAdmission(input)
    expect(reads).toBe(3)
    await service.settled()
  })

  test("pooled usage is read again on the next admission after a failed read", async () => {
    const directory = profile("pooled-copilot-failure")
    const provider = definition("github_copilot")
    writeAccounts(directory, [provider])
    let now = 10_000
    let fail = false
    let reads = 0
    const service = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry([provider], new Map([[provider.id, async ({ account }) => {
        reads += 1
        if (fail) return { kind: "fetch-failure" as const }
        return { kind: "success" as const, report: {
          providerId: provider.id, instanceId: account.instanceId, identity: account.identity!, providerStatus: "ok" as const, observedAtMs: now,
          metrics: [{ metricKey: "ai_credits", label: "AI Credits", rank: 0, scope: { kind: "account" as const }, timing: { kind: "unavailable" as const }, allowanceMode: "pooled" as const, used: { kind: "count" as const, value: 5, unit: "credits", precision: "exact" as const, provenance: "provider" as const } }],
        } }
      }]])),
      thresholds: () => [], now: () => now,
    })
    const input = { service, candidates: [candidate("account")], monthlyCreditCap: undefined }
    expect((await captureCopilotAllowanceAdmission(input))(candidate("account"))).toEqual({ freshness: "fresh", allowance: "pooled", usedCredits: 5 })
    fail = true
    now += 1
    expect((await captureCopilotAllowanceAdmission(input))(candidate("account"))).toEqual({ freshness: "stale", allowance: "pooled", usedCredits: 5 })
    expect(reads).toBe(2)
    fail = false
    now += 1_000
    expect((await captureCopilotAllowanceAdmission(input))(candidate("account"))).toEqual({ freshness: "fresh", allowance: "pooled", usedCredits: 5 })
    expect(reads).toBe(3)
    await service.settled()
  })

  test("retains exact finite premium interaction and AI Credit evidence by account", async () => {
    const metrics: ReadonlyMap<string, ReturnType<SubscriptionUsageService["metric"]>> = new Map<string, ReturnType<SubscriptionUsageService["metric"]>>([
      ["legacy", {
        kind: "fresh",
        metric: {
          metricKey: "premium_interactions" as const,
          label: "Premium interactions",
          scope: { kind: "account" },
          rank: 0,
          timing: { kind: "unavailable" },
          allowanceMode: undefined,
          remaining: { kind: "count", value: 3, unit: "interactions", precision: "exact", provenance: "provider" },
        },
      }],
      ["credits", {
        kind: "retained",
        metric: {
          metricKey: "ai_credits" as const,
          label: "AI Credits",
          scope: { kind: "account" },
          rank: 0,
          timing: { kind: "unavailable" },
          allowanceMode: "finite",
          remaining: { kind: "count", value: 12.5, unit: "AI Credits", precision: "exact", provenance: "provider" },
        },
      }],
    ])
    const service: Pick<SubscriptionUsageService, "metric" | "checkAccounts"> = {
      metric: (_providerId, instanceId) => metrics.get(instanceId) ?? { kind: "unknown" },
      checkAccounts: async () => undefined,
    }
    const allowance = await captureCopilotAllowanceAdmission({
      candidates: [candidate("legacy"), candidate("credits")],
      service, monthlyCreditCap: undefined,
    })

    expect(allowance(candidate("legacy"))).toEqual({ freshness: "fresh", allowance: "finite", metric: "premium_interactions", remaining: 3 })
    expect(allowance(candidate("credits"))).toEqual({ freshness: "stale", allowance: "finite", metric: "ai_credits", remaining: 12.5 })
    // An account with no observation is the provider's to judge (PI-MODEL-011).
    expect(allowance(candidate("sibling"))).toEqual({ allowance: "unknown" })
  })

  test("a set monthly cap refuses only what current usage cannot show to be under it", async () => {
    const pooled = (kind: "fresh" | "retained", used: number): ReturnType<SubscriptionUsageService["metric"]> => ({
      kind,
      metric: {
        metricKey: "ai_credits" as const,
        label: "AI Credits",
        scope: { kind: "account" },
        rank: 0,
        timing: { kind: "unavailable" },
        allowanceMode: "pooled",
        used: { kind: "count", value: used, unit: "AI Credits", precision: "exact", provenance: "provider" },
      },
    })
    const metrics = new Map([["under", pooled("fresh", 40)], ["reached", pooled("fresh", 100)], ["stale", pooled("retained", 40)]])
    const service: Pick<SubscriptionUsageService, "metric" | "checkAccounts"> = {
      metric: (_providerId, instanceId) => metrics.get(instanceId) ?? { kind: "unknown" },
      checkAccounts: async () => undefined,
    }
    const capped = await captureCopilotAllowanceAdmission({
      candidates: ["under", "reached", "stale", "unread"].map((id) => candidate(id)),
      service, monthlyCreditCap: 100,
    })
    const unchecked = { allowance: "refused", detail: "the local monthly cap of 100 credits cannot be checked, because the current Copilot usage cannot be verified." } as const
    expect(capped(candidate("under"))).toEqual({ freshness: "fresh", allowance: "pooled", usedCredits: 40 })
    expect(capped(candidate("reached"))).toEqual({ allowance: "refused", detail: "the local monthly cap of 100 credits has been reached." })
    expect(capped(candidate("stale"))).toEqual(unchecked)
    expect(capped(candidate("unread"))).toEqual(unchecked)
    expect(capped(candidate("reached", "automatic"))).toEqual({ allowance: "unknown" })
    expect(capped(candidate("stale", "prepaid"))).toEqual({ allowance: "unknown" })
  })
})
