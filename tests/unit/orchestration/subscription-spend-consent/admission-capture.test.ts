import { afterEach, describe, expect, test } from "bun:test"
import type { AccessProviderCandidate } from "../../../../src/infra/llm/access-provider.js"
import { CHATGPT_RATE_LIMIT_RESET_TYPE, type SubscriptionUsageMetric, type SubscriptionUsageResetCredits } from "../../../../src/infra/llm/subscription-usage.js"
import { createSubscriptionUsageService } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { createSubscriptionUsageServicePool } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service-pool.js"
import { captureSubscriptionAdmission } from "../../../../src/orchestration/subscription-spend-consent/admission-capture.js"
import { createSubscriptionSpendConsentCaptureCache } from "../../../../src/orchestration/subscription-spend-consent/capture-cache.js"
import type { SubscriptionSpendConsentCapture } from "../../../../src/orchestration/subscription-spend-consent/subscription-spend-consent-service.js"
import { createProfileFixture, definition, registry, report, writeAccounts } from "../auth/provider-observations/_service-fixtures.js"

const { profile, cleanup } = createProfileFixture()
afterEach(cleanup)

describe("subscription admission capture", () => {
  test("names the accounts whose published usage reading holds an available banked reset", async () => {
    const resolved = { id: "default", directory: profile("banked-reset-admission") }
    const chatgpt = definition("chatgpt")
    writeAccounts(resolved.directory, [chatgpt])
    let resetCredits: SubscriptionUsageResetCredits = { availableCount: 1, credits: [{ id: "reset-1", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available" }] }
    const providers = registry([chatgpt], new Map([[chatgpt.id, async () => ({ kind: "success" as const, report: { ...report(chatgpt.id, Date.now()), resetCredits } })]]))
    const pool = createSubscriptionUsageServicePool({ create: () => createSubscriptionUsageService({ profile: () => resolved, registry: () => providers, thresholds: () => [] }) })
    const residentLease = await pool.acquire(resolved)
    const consentCache = createSubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>()
    const admit = () => captureSubscriptionAdmission({
      candidates: [], providerSettings: {}, registry: { allowance: new Map(), settings: new Map(), selection: providers.selection },
      profile: resolved, residentLease, pool, consentCache,
    })
    const account: AccessProviderCandidate = { kind: "subscription", providerId: "chatgpt", instanceId: "account", spendMode: "included" }
    try {
      // No reading is published yet, as in a headless run that never reads this account.
      expect((await admit()).bankedResetFor(account)).toBe(false)

      await residentLease.service.check()
      const banked = await admit()
      expect(banked.bankedResetFor(account)).toBe(true)
      expect(banked.bankedResetFor({ ...account, spendMode: "prepaid" })).toBe(true)
      expect(banked.bankedResetFor({ ...account, instanceId: "other" })).toBe(false)
      expect(banked.bankedResetFor({ kind: "singleton", providerId: "openai_api", spendMode: "direct_api" })).toBe(false)

      resetCredits = { availableCount: 0, credits: [] }
      await residentLease.service.check({ forceRefresh: true })
      expect((await admit()).bankedResetFor(account)).toBe(false)
    } finally { await residentLease.release(); pool.closeAdmission(); await pool.settled() }
  })

  test("a view reads usage again only when the evidence in memory is out of date, where a request forces the read", async () => {
    const resolved = { id: "default", directory: profile("view-allowance-admission") }
    const chatgpt = definition("chatgpt")
    writeAccounts(resolved.directory, [chatgpt])
    let reads = 0
    const providers = registry([chatgpt], new Map([[chatgpt.id, async () => { reads += 1; return { kind: "success" as const, report: report(chatgpt.id, Date.now()) } }]]))
    const pool = createSubscriptionUsageServicePool({ create: () => createSubscriptionUsageService({ profile: () => resolved, registry: () => providers, thresholds: () => [] }) })
    const residentLease = await pool.acquire(resolved)
    const account: AccessProviderCandidate = { kind: "subscription", providerId: "chatgpt", instanceId: "account", spendMode: "included" }
    const allowance = new Map([[chatgpt.id, async ({ usage }: { readonly usage: { readonly checkAccounts: typeof residentLease.service.checkAccounts } }) => {
      await usage.checkAccounts([{ providerId: "chatgpt", instanceId: "account" }], { forceRefresh: true })
      return () => ({ allowance: "unknown" as const })
    }]])
    const admit = (view?: true) => captureSubscriptionAdmission({
      candidates: [account], providerSettings: {}, registry: { allowance, settings: new Map(), selection: providers.selection },
      profile: resolved, residentLease, pool, consentCache: createSubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>(),
      ...(view === undefined ? {} : { view }),
    })
    try {
      await admit(true)
      expect(reads).toBe(1)
      await admit(true)
      expect(reads).toBe(1)
      await admit()
      expect(reads).toBe(2)
    } finally { await residentLease.release(); pool.closeAdmission(); await pool.settled() }
  })

  test("holds each account's future reset of the expiring window its provider declares", async () => {
    const resolved = { id: "default", directory: profile("expiring-reset-admission") }
    const declaring = (id: string) => ({ ...definition(id), usage: { expiringWindow: "seven_day" } })
    const future = declaring("future")
    const exact = declaring("exact")
    const passed = declaring("passed")
    const unknown = declaring("unknown")
    const exhausted = declaring("exhausted")
    const undeclared = definition("undeclared")
    const providers = [future, exact, passed, unknown, exhausted, undeclared]
    writeAccounts(resolved.directory, providers)
    const soon = Date.now() + 86_400_000
    // A fully used window has no quota left to expire, so its reset orders nothing.
    const window = (timing: SubscriptionUsageMetric["timing"], usedFraction: number): SubscriptionUsageMetric => ({ metricKey: "seven_day", label: "Seven days", scope: { kind: "account" }, rank: 0, timing, usedFraction })
    const timings = new Map<string, SubscriptionUsageMetric["timing"]>([
      ["future", { kind: "unavailable", resetAtMs: soon }],
      ["exact", { kind: "exact", startMs: 1, endMs: soon + 1 }],
      ["passed", { kind: "unavailable", resetAtMs: Date.now() - 1 }],
      ["unknown", { kind: "unavailable" }],
      ["exhausted", { kind: "unavailable", resetAtMs: soon }],
      ["undeclared", { kind: "unavailable", resetAtMs: soon }],
    ])
    const readers = new Map(providers.map((provider) => [provider.id, async () => ({ kind: "success" as const, report: { ...report(provider.id, Date.now()), metrics: [window(timings.get(provider.id)!, provider.id === "exhausted" ? 1 : 0.5)] } })]))
    const usage = registry(providers, readers)
    const pool = createSubscriptionUsageServicePool({ create: () => createSubscriptionUsageService({ profile: () => resolved, registry: () => usage, thresholds: () => [] }) })
    const residentLease = await pool.acquire(resolved)
    const admit = () => captureSubscriptionAdmission({
      candidates: [], providerSettings: {}, registry: { allowance: new Map(), settings: new Map(), selection: usage.selection },
      profile: resolved, residentLease, pool, consentCache: createSubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>(),
    })
    const account = (providerId: string, instanceId = "account"): AccessProviderCandidate => ({ kind: "subscription", providerId, instanceId, spendMode: "included" })
    try {
      expect((await admit()).expiringResetFor(account("future"))).toBeUndefined()

      await residentLease.service.check()
      const captured = await admit()
      expect(providers.map(({ id }) => captured.expiringResetFor(account(id)))).toEqual([soon, soon + 1, undefined, undefined, undefined, undefined])
      expect(captured.expiringResetFor(account("future", "other"))).toBeUndefined()
    } finally { await residentLease.release(); pool.closeAdmission(); await pool.settled() }
  })
})
