import type { UsageAccountsResult, UsageHistoryResult, UsageModelSummary, UsageSpendResult, UsageTokens } from "../../../src/protocol/modules/subscription-usage.js"
import type { SubscriptionUsageMetric } from "../../../src/infra/llm/subscription-usage.js"

export const usageNow = Date.parse("2026-09-09T00:00:00.000Z")
export const usageTokens = (total: number): UsageTokens => ({ input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total })
export const usageModel = (model: string, total: number, billed: number, included = 0, priceUnavailable = false): UsageModelSummary => ({ model, attempts: 1, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: usageTokens(total), estimatedBilledUsd: billed, includedValueUsd: included, priceUnavailable })
export const usageMetric = (metricKey: string, label: string, usedFraction: number, rank = 0): SubscriptionUsageMetric => ({ metricKey, label, scope: { kind: "account" }, rank, timing: { kind: "exact", startMs: Date.parse("2026-09-02T00:00:00.000Z"), endMs: usageNow }, usedFraction })

const metadata = { profileId: "profile", authorityIncarnation: "authority", revision: 4, generation: 2, asOf: usageNow } as const
const period = { startMs: Date.parse("2026-01-01T00:00:00.000Z"), endMs: usageNow, trackingStartMs: Date.parse("2026-01-03T00:00:00.000Z"), partial: true, incomplete: true } as const
const quotaAccounting = { state: "available", windows: [{ state: "available", metricKey: "primary_window", startMs: Date.parse("2026-09-02T00:00:00.000Z"), endMs: usageNow, trackingStartMs: period.trackingStartMs, partial: true, attempts: 2, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: { input: 600, output: 200, cacheRead: 100, cacheWrite: 50, reasoning: 25, total: 975 }, includedValueUsd: 21, priceUnavailable: false }] } as const
const activity = { state: "available", ...period, attempts: 5, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: usageTokens(2_500), estimatedBilledUsd: 0, includedValueUsd: 42, priceUnavailable: false } as const

export const usageAccounts: UsageAccountsResult = {
  kind: "usage.accounts", ...metadata,
  sources: [
    { sourceId: "chatgpt:work", providerId: "chatgpt", label: "ChatGPT Work", active: true, identity: "work@example.com", kind: "subscription", activity, quotaAccounting, bankedResets: { availableCount: 2, credits: [{ expiresAtMs: usageNow + 3_600_000, title: "Weekly reset", description: "Banked weekly reset" }, { expiresAtMs: usageNow + 7 * 86_400_000, title: "Full reset" }] }, observation: { state: "supported", plan: "Pro", tier: "Team", providerStatus: "ok", observedAtMs: usageNow, metrics: [usageMetric("primary_window", "Primary Window", 0.5)], spendSources: [] } },
    { sourceId: "copilot:personal", providerId: "github_copilot", label: "Copilot Personal", active: true, kind: "subscription", activity: { state: "ledger-unavailable" }, quotaAccounting: { state: "ledger-unavailable" }, allowanceCap: { metricKey: "ai_credits", value: 3_900 }, observation: { state: "stale", message: "Provider data is stale", plan: "Individual", providerStatus: "warning", observedAtMs: usageNow - 60_000, metrics: [{ metricKey: "ai_credits", label: "AI Credits", scope: { kind: "account" }, rank: 0, timing: { kind: "unavailable", resetAtMs: usageNow + 27 * 86_400_000 }, allowanceMode: "pooled", used: { kind: "count", value: 70, unit: "AI Credits", provenance: "provider", precision: "exact" } }], spendSources: [] } },
    { sourceId: "api:openai", providerId: "openai", label: "OpenAI API", active: true, kind: "metered", activity: { state: "available", ...period, attempts: 4, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: usageTokens(1_600), estimatedBilledUsd: 4.6, includedValueUsd: 0, priceUnavailable: true }, spendMode: "direct_api" },
    { sourceId: "anthropic:old", providerId: "anthropic", label: "Anthropic Old", active: true, kind: "subscription", activity: { state: "ledger-unavailable" }, quotaAccounting: { state: "window-unavailable" }, observation: { state: "expired-auth", message: "Sign in again" } },
  ],
}

export const usageSpend: UsageSpendResult = {
  kind: "usage.spend", ...metadata, range: "Month", ...period,
  estimatedBilledUsd: 5.85, includedValueUsd: 21,
  sources: [
    { sourceId: "chatgpt:work", providerId: "chatgpt", label: "ChatGPT Work", active: true, kind: "subscription", spendModes: ["included"], attempts: 2, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: usageTokens(2100), estimatedBilledUsd: 0, includedValueUsd: 21, priceUnavailable: false, models: [usageModel("gpt-5", 1200, 0, 12), usageModel("gpt-4.1", 900, 0, 9)] },
    { sourceId: "api:openai", providerId: "openai", label: "OpenAI API", active: true, kind: "metered", spendModes: ["direct_api"], attempts: 4, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: usageTokens(1600), estimatedBilledUsd: 4.6, includedValueUsd: 0, priceUnavailable: true, models: [usageModel("gpt-5-mini", 700, 1.25), usageModel("o3", 500, 2.5, 0, true), usageModel("gpt-4o", 300, 0.75), usageModel("legacy", 100, 0.1)] },
    { sourceId: "legacy:inactive", label: "Legacy lineage", active: false, kind: "unattributed", spendModes: [], attempts: 1, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: usageTokens(100), estimatedBilledUsd: 1.25, includedValueUsd: 0, priceUnavailable: false, models: [usageModel("unknown", 100, 1.25)] },
  ],
}

export const usageHistory: UsageHistoryResult = {
  kind: "usage.history", ...metadata, range: "24h", startMs: usageNow - 86_400_000, endMs: usageNow,
  sources: [{ sourceId: "chatgpt:work", kind: "subscription", providerId: "chatgpt", label: "ChatGPT Work", spend: [], plan: "Pro", tier: "Team", providerStatus: "ok", spendSources: [], count: 1, samples: [], latest: [usageMetric("primary_window", "Primary Window", 0.5)], peak: [usageMetric("primary_window", "Primary Window", 0.8)], resetMarkers: [] }],
}

export const usageOpenResult = { ok: true, usage: metadata } as const
export const usageRefreshResult = { ok: true, usage: metadata } as const
