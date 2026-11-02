import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { UsageAccountSource, UsageHistorySource, UsageSpendResult } from "../../../../src/protocol/modules/subscription-usage.js"
import { accountStatus, accountSubtitle, activityLines, consentStatus, detailMetricCount, describeMetric, metricBars, prepaidBalanceLines, providerNotice, spendGroups, tokenLines } from "./usage-format.js"

/** Usage is rendered in the provider's own terms. These hold the projection to
 *  that rule: a pair reads as a fraction, a fraction as a percentage, a bare
 *  value as itself, and nothing is invented for a half the provider never sent. */

type Metric = UsageHistorySource["latest"][number]
type Value = NonNullable<Metric["used"]>

const exact = { provenance: "provider", precision: "exact" } as const
const count = (value: number, unit: string): Value => ({ kind: "count", value, unit, ...exact })
const money = (value: number, currency: string): Value => ({ kind: "money", value, currency, ...exact })
const metric = (label: string, values: Partial<Pick<Metric, "used" | "limit" | "remaining" | "usedFraction">> = {}): Metric =>
  ({ metricKey: label.toLowerCase(), label, scope: { kind: "account" }, rank: 0, timing: { kind: "unavailable" }, ...values })

describe("describeMetric", () => {
  test("a used and limit pair reads as a fraction", () => {
    assert.equal(describeMetric(metric("Requests", { used: count(12, "requests"), limit: count(300, "requests") })), "Requests 12 requests/300 requests")
  })

  test("a bare fraction reads as a percentage and a bare remainder as what is left", () => {
    assert.equal(describeMetric(metric("Weekly", { usedFraction: 0.42 })), "Weekly 42%")
    assert.equal(describeMetric(metric("Credits", { remaining: money(4.5, "USD") })), "Credits $4.50 left")
  })

  test("a metric with no value is its label alone", () => {
    assert.equal(describeMetric(metric("Something")), "Something")
  })
})

const subscription = (observation: Extract<UsageAccountSource, { kind: "subscription" }>["observation"]): UsageAccountSource => ({
  kind: "subscription",
  activity: { state: "available", startMs: 1, endMs: 2, trackingStartMs: 1, partial: false, incomplete: true, attempts: 8, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3, total: 21 }, estimatedBilledUsd: 4, includedValueUsd: 12, priceUnavailable: true },
  sourceId: "acct-1",
  providerId: "copilot",
  label: "Copilot Personal",
  active: true,
  identity: "octocat",
  quotaAccounting: { state: "ledger-unavailable" },
  observation,
})

describe("accountStatus", () => {
  test("a supported reading is the first window's use, toned by the provider's status", () => {
    const status = accountStatus(subscription({ state: "supported", plan: "Pro", tier: "individual", providerStatus: "warning", observedAtMs: 0, metrics: [metric("Weekly", { usedFraction: 0.9 })], spendSources: [] }))
    assert.deepEqual(status, { text: "90% used", tone: "warn" })
  })

  test("an available banked reset does not displace the reading; it belongs to the open account", () => {
    const source = { ...subscription({ state: "supported", providerStatus: "ok", observedAtMs: 0, metrics: [metric("Weekly", { usedFraction: 0.1 })], spendSources: [] }), bankedResets: { availableCount: 1, credits: [{ expiresAtMs: 3 * 86_400_000 }] } }
    assert.deepEqual(accountStatus(source), { text: "10% used" })
  })

  test("a signed-out account says so and is not painted as healthy", () => {
    assert.deepEqual(accountStatus(subscription({ state: "expired-auth" })), { text: "Signed out", tone: "warn" })
    assert.deepEqual(accountStatus(subscription({ state: "failure", message: "boom" })), { text: "Reading failed", tone: "error" })
  })

  test("a metered account is metered, with its route beneath and never its id", () => {
    const source: UsageAccountSource = { kind: "metered", sourceId: "3a091b88", providerId: "anthropic", label: "Anthropic", active: true, activity: { state: "ledger-unavailable" }, spendMode: "direct_api" }
    assert.deepEqual(accountStatus(source), { text: "Metered" })
    assert.equal(accountSubtitle(source, undefined), "Direct API")
  })

  test("a metered key whose provider reports a balance reads as what is left, or that none is left", () => {
    const keyed = (observation: NonNullable<Extract<UsageAccountSource, { kind: "metered" }>["observation"]>): UsageAccountSource => ({ kind: "metered", sourceId: "4b1a", providerId: "deepseek", label: "DeepSeek", active: true, activity: { state: "ledger-unavailable" }, spendMode: "direct_api", observation })
    assert.deepEqual(accountStatus(keyed({ state: "supported", providerStatus: "ok", observedAtMs: 0, metrics: [], spendSources: [{ kind: "prepaid", availability: "funded", remaining: money(20, "USD") }] })), { text: `${(20).toLocaleString(undefined, { style: "currency", currency: "USD" })} left` })
    assert.deepEqual(accountStatus(keyed({ state: "supported", providerStatus: "exhausted", observedAtMs: 0, metrics: [], spendSources: [{ kind: "prepaid", availability: "empty" }] })), { text: "No balance left", tone: "error" })
    assert.deepEqual(accountStatus(keyed({ state: "failure", message: "boom" })), { text: "Reading failed", tone: "error" })
  })

  test("a metered key with several balances reads as the first in its row and lists every one in its detail, under the provider's notice", () => {
    const left = (value: number, currency: string) => `${value.toLocaleString("en-US", { style: "currency", currency })} left`
    const source: UsageAccountSource = { kind: "metered", sourceId: "4b1a", providerId: "deepseek", label: "DeepSeek", active: true, activity: { state: "ledger-unavailable" }, spendMode: "direct_api", observation: { state: "stale", message: "older reading", providerStatus: "ok", observedAtMs: 0, metrics: [], spendSources: [
      { kind: "prepaid", availability: "funded", remaining: money(1234.5, "CNY") },
      { kind: "prepaid", availability: "funded", remaining: money(20, "USD") },
    ] } }
    assert.deepEqual(accountStatus(source), { text: left(1234.5, "CNY"), tone: "warn" })
    assert.deepEqual(prepaidBalanceLines(source), [{ label: left(1234.5, "CNY"), tone: "warn" }, { label: left(20, "USD"), tone: "warn" }])
    assert.deepEqual(providerNotice(source), { label: "Stale reading", detail: "older reading", tone: "warn" })
  })

  test("the subtitle is the plan, the identity, and the consent, joined", () => {
    assert.equal(accountSubtitle(subscription({ state: "supported", plan: "Pro", tier: "individual", providerStatus: "ok", observedAtMs: 0, metrics: [], spendSources: [] }), undefined), "Pro individual · octocat")
  })
})

describe("metricBars", () => {
  const window = (label: string, key: string, detail = false) => ({ ...metric(label, { usedFraction: 0 }), metricKey: key, ...(detail ? { detail: true as const } : {}) })
  const chatgpt = (): UsageAccountSource => ({ ...subscription({ state: "supported", providerStatus: "ok", observedAtMs: 0, metrics: [window("Primary window", "primary"), window("Spark primary", "spark_primary", true), window("Spark secondary", "spark_secondary", true)], spendSources: [] }), providerId: "chatgpt" })

  test("hides the windows the provider marked as detail until asked, and counts them", () => {
    assert.deepEqual(metricBars(chatgpt(), 0, false).map((bar) => bar.label), ["Primary window"])
    assert.equal(metricBars(chatgpt(), 0, true).length, 3)
    assert.equal(detailMetricCount(chatgpt()), 2)
  })

  test("reads a fraction as a percentage with its reset, and a full window as an error", () => {
    const source = subscription({ state: "supported", providerStatus: "ok", observedAtMs: 0, metrics: [{ ...metric("Weekly", { usedFraction: 1 }), timing: { kind: "unavailable", resetAtMs: 5 * 3_600_000 } }], spendSources: [] })
    assert.deepEqual(metricBars(source, 0, false), [{ label: "Weekly", reading: "100% used", fraction: 1, note: "Resets in 5 hours", tone: "error" }])
  })
})

describe("providerNotice and activityLines", () => {
  test("a failed reading is named above the allowance in the provider's words", () => {
    assert.deepEqual(providerNotice(subscription({ state: "failure", message: "request failed" })), { label: "Reading failed", detail: "request failed", tone: "error" })
    assert.equal(providerNotice(subscription({ state: "supported", providerStatus: "ok", observedAtMs: 0, metrics: [], spendSources: [] })), undefined)
  })

  test("shows this month separately from all current provider windows", () => {
    const lines = activityLines(subscription({ state: "pending" }))
    assert.equal(lines[0]?.label, "This month")
    assert.deepEqual(lines.slice(1), [
        { label: "Estimated billed", value: "$4.00" },
        { label: "Included value", value: "$12.00", detail: "8 measured requests" },
        { label: "Tokens", value: "21", detail: "cache read 2 · cache write 1 · reasoning 3" },
        { label: "Activity ledger is incomplete", tone: "warn" },
        { label: "Some model prices are unavailable", tone: "warn" },
        { label: "Current usage windows" },
        { label: "Usage ledger unavailable", tone: "warn" },
      ])
  })

  test("marks partial month coverage independently of unsettled usage", () => {
    const source = subscription({ state: "pending" })
    if (source.activity.state !== "available") throw new Error("Expected activity fixture")
    const lines = activityLines({ ...source, activity: { ...source.activity, partial: true, incomplete: false, trackingStartMs: new Date(2026, 8, 5).getTime() } })
    assert.ok(lines.some((line) => line.label === "Tracked from Sep 5 · partial month" && line.tone === "warn"))
    assert.ok(lines.every((line) => line.label !== "Activity ledger is incomplete"))
  })
  test("keeps this month named when the ledger is unavailable", () => {
    const lines = activityLines({ ...subscription({ state: "pending" }), activity: { state: "ledger-unavailable" } })
    assert.equal(lines[0]?.label, "This month")
    assert.equal(lines[1]?.label, "Usage ledger unavailable")
  })
  test("keeps distinct current-window subtotals below this month", () => {
    const source = subscription({ state: "pending" })
    assert.equal(source.kind, "subscription")
    if (source.kind !== "subscription") throw new Error("Expected subscription fixture")
    const lines = activityLines({ ...source, quotaAccounting: { state: "available", windows: [
      { state: "available", metricKey: "weekly", startMs: 1, endMs: 2, trackingStartMs: 1, partial: false, attempts: 2, unmeasuredAttempts: 1, partialAttempts: 0, cacheComplete: true, tokens: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3 }, includedValueUsd: 3, priceUnavailable: false },
      { state: "window-unavailable", metricKey: "monthly" },
    ] } })
    assert.ok(lines.some((line) => line.label === "Included value" && line.value === "$12.00"))
    // An unmeasured request is a coverage warning, not a tracking gap: the window stays fully tracked.
    assert.ok(lines.some((line) => line.label === "weekly included" && line.value === "$3.00" && line.detail === "2 measured requests · 1 unmeasured" && line.tone === "warn"))
    assert.ok(lines.every((line) => !line.label.endsWith("partial window")))
    assert.ok(lines.some((line) => line.label === "monthly" && line.value === "Window unavailable"))
  })
})

describe("consentStatus", () => {
  test("review required outranks an accepted mode on the same account", () => {
    const auth = {
      providers: [],
      warnings: [],
      profile: { id: "p", displayName: "Personal", source: "default" as const, availableProfiles: [] },
      subscriptionSpendConsent: {
        kind: "available" as const,
        profileId: "p",
        usageGeneration: 1,
        authorityIncarnation: "a",
        authorityRevision: 1,
        accounts: [{
          accountCorrelationId: "acct-1",
          providerId: "copilot",
          providerDisplayName: "Copilot",
          providerStatus: "ok" as const,
          modes: [
            { mode: "prepaid" as const, envelopeId: "e1", evidence: { kind: "prepaid" as const, availability: "funded" as const }, decision: "accepted" as const },
            { mode: "automatic" as const, envelopeId: "e2", evidence: { kind: "automatic-billing" as const, enablement: "enabled" as const }, decision: "unreviewed" as const },
          ],
        }],
      },
    }
    assert.equal(consentStatus(auth, "copilot", "acct-1"), "Review required")
    assert.equal(consentStatus(auth, "copilot", "other"), undefined)
  })
})

describe("spendGroups", () => {
  test("leads with the total and lists each source's models", () => {
    const spend: UsageSpendResult = {
      kind: "usage.spend",
      range: "7d",
      profileId: "p",
      authorityIncarnation: "a",
      revision: 1,
      generation: 1,
      asOf: 0,
      startMs: 0,
      endMs: 1,
      trackingStartMs: 0,
      partial: false,
      incomplete: false,
      estimatedBilledUsd: 1.5,
      includedValueUsd: 3,
      sources: [{
        kind: "subscription",
        providerId: "copilot",
        sourceId: "acct-1",
        label: "Copilot",
        active: true,
        spendModes: ["included"],
        attempts: 2, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 15 },
        estimatedBilledUsd: 0,
        includedValueUsd: 3,
        priceUnavailable: false,
        models: [{ model: "gpt", attempts: 2, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 15 }, estimatedBilledUsd: 0, includedValueUsd: 3, priceUnavailable: false }],
      }],
    }
    const groups = spendGroups(spend)
    assert.equal(groups[0]?.title, "Totals")
    assert.deepEqual(groups[0]?.lines[0], { label: "Estimated billed spend", value: "$1.50" })
    assert.equal(groups[1]?.title, "Copilot")
    assert.match(groups[1]?.summary ?? "", /\$3\.00 subscription-equivalent value · 15 tokens/)
    assert.deepEqual(groups[1]?.lines.at(-1), { label: "gpt", value: "15 tokens", detail: "2 measured requests · $0.00 billed · $3.00 subscription-equivalent value · 0.0% reported cache hit · 10 input (0 cached, 10 uncached, 0 writes) · 5 output" })
    // A model whose provider did not report cache reads states that, never a computed hit rate or zero cached input.
    const [source] = spend.sources
    if (source === undefined) throw new Error("Expected a spend source")
    const unreported = spendGroups({ ...spend, sources: [{ ...source, cacheComplete: false, models: source.models.map((model) => ({ ...model, cacheComplete: false })) }] })
    assert.equal(unreported[0]?.lines.find((line) => line.label === "Reported cache hit rate")?.value, "Unavailable")
    assert.equal(unreported[1]?.lines.at(-1)?.detail, "2 measured requests · $0.00 billed · $3.00 subscription-equivalent value · cache detail not reported for every request · 10 input · 5 output")
  })
  test("weights cache hit rate by reported tokens and marks empty input", () => {
    const tokens = { input: 20, output: 6, cacheRead: 70, cacheWrite: 10, reasoning: 3, total: 106 }
    const measured = { attempts: 2, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true }
    assert.deepEqual(tokenLines(tokens, measured).map((line) => line.value), ["70.0%", "100", "70", "30", "10", "6", "2"])
    assert.equal(tokenLines({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }, { ...measured, attempts: 0 })[0]?.value, "No usage yet")
  })
  test("counts unmeasured and partially measured requests beside the measured count", () => {
    const tokens = { input: 20, output: 6, cacheRead: 70, cacheWrite: 10, reasoning: 3, total: 106 }
    // The total sits in the narrow value column; the breakdown wraps in the detail.
    assert.deepEqual(tokenLines(tokens, { attempts: 12, unmeasuredAttempts: 2, partialAttempts: 1, cacheComplete: true }).at(-1), { label: "Requests", value: "14", detail: "12 measured requests (1 partial) · 2 unmeasured", tone: "warn" })
  })
  test("does not present unknown cache buckets as zero", () => {
    const lines = tokenLines({ input: 50, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 60 }, { attempts: 0, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: false })
    assert.deepEqual(lines[0], { label: "Reported cache hit rate", value: "Unavailable", detail: "not reported for every request" })
    assert.equal(lines[1]?.value, "50")
    assert.equal(lines[2]?.value, "Unavailable")
    assert.equal(lines[3]?.value, "Unavailable")
    assert.equal(lines[4]?.value, "Unavailable")
  })
})
