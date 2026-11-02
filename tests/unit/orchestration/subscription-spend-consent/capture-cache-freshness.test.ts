import { afterEach, describe, expect, test } from "bun:test"
import { createSubscriptionAccountIdentity } from "../../../../src/infra/llm/subscription-account-identity.js"
import type { SubscriptionUsageReader } from "../../../../src/infra/llm/subscription-usage.js"
import { createSubscriptionSpendEnvelope } from "../../../../src/infra/auth/subscription-spend-consent.js"
import { createSubscriptionSpendConsentCaptureCache } from "../../../../src/orchestration/subscription-spend-consent/capture-cache.js"
import { createSubscriptionSpendConsentService, type SubscriptionSpendConsentCapture } from "../../../../src/orchestration/subscription-spend-consent/subscription-spend-consent-service.js"
import { createSubscriptionUsageService } from "../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { createProfileFixture, definition, registry, report, writeAccounts } from "../auth/provider-observations/_service-fixtures.js"

const { profile, cleanup } = createProfileFixture()
afterEach(cleanup)

describe("consent memoization is independent of usage", () => {
  test("saved grants survive missing, stale, failed, and replaced usage publications without admission reads", async () => {
    const directory = profile("consent-freshness")
    const definitions = ["older", "fresh", "unsupported", "failure", "stale"].map(definition)
    writeAccounts(directory, definitions)
    let now = 10_100
    const usage = createSubscriptionUsageService({
      profile: () => ({ id: "default", directory }),
      registry: () => registry(definitions, new Map<string, SubscriptionUsageReader>([
        ...["older", "fresh"].map((id) => [id, async () => ({ kind: "success" as const, report: { ...report(id, id === "older" ? 10_000 : 10_100), spendSources: [{ kind: "prepaid" as const, availability: "funded" as const, remaining: { kind: "count" as const, value: 10, unit: "credits", provenance: "provider" as const, precision: "exact" as const } }] } })] as const),
        ["failure", async () => ({ kind: "fetch-failure" as const })],
        ["stale", async () => ({ kind: "fetch-failure" as const })],
      ])),
      thresholds: () => [], now: () => now,
    })
    usage.store()!.record(report("stale", 1))
    let usageReads = 0
    const envelope = (id: string) => createSubscriptionSpendEnvelope("default", createSubscriptionAccountIdentity(id, "account", `${id}-identity`), "prepaid").id
    let lockedReads = 0
    const consent = createSubscriptionSpendConsentService({
      profileId: "default",
      usage: {
        ...usage,
        snapshot: () => { usageReads += 1; return usage.snapshot() },
      },
      paidModes: () => ["prepaid"],
      consent: {
        read: async (envelopes) => {
          lockedReads += 1
          return { profileId: "default", incarnation: "unchanged-authority", revision: 3, envelopes: envelopes.map((value) => ({ envelope: value, status: value.mode === "prepaid" ? "accepted" as const : "unreviewed" as const })) }
        },
        save: async () => { throw new Error("no mutation") },
      },
    })
    const cache = createSubscriptionSpendConsentCaptureCache<SubscriptionSpendConsentCapture>()
    const capture = () => cache.capture({
      profileDirectory: directory,
      accountGeneration: usage.generation,
      readRevision: () => ({ kind: "content", digest: "same-complete-authority-digest" }),
      lockedCapture: consent.capture,
    })
    const initial = await capture()
    expect(initial.authorizations.size).toBe(5)
    expect(usage.snapshot()).toBeUndefined()
    await usage.check()
    const publication = usage.snapshot()
    expect(publication?.accounts.map((row) => row.kind)).toEqual(["failure", "supported", "supported", "stale", "unsupported"])
    for (const point of [310_000, 310_001, 600_000]) {
      now = point
      const current = await capture()
      expect(current).toBe(initial)
      expect(current.authorizations.has(envelope("older"))).toBe(true)
      expect(current.authorizations.has(envelope("fresh"))).toBe(true)
    }
    await usage.check({ forceRefresh: true })
    expect(usage.snapshot()).not.toBe(publication)
    await Promise.all([capture(), capture()])
    expect(lockedReads).toBe(1)
    expect(usageReads).toBe(0)
    cache.invalidate(directory)
    expect((await capture()).authorizations.size).toBe(5)
    expect(lockedReads).toBe(2)
    expect(usageReads).toBe(0)
    await usage.refresh()
    const nextGeneration = await capture()
    expect(nextGeneration).not.toBe(initial)
    expect(nextGeneration.authorizations.size).toBe(5)
    expect(lockedReads).toBe(3)
    expect(usageReads).toBe(0)
    usage.closeAdmission()
    await usage.settled()
  })
})
