import { describe, expect, test } from "bun:test"
import type { AccessProviderCandidate } from "../../../../../src/infra/llm/access-provider.js"
import type { SubscriptionUsageMetric } from "../../../../../src/infra/llm/subscription-usage.js"
import { createProviderAvailability } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability.js"
import type { SubscriptionUsagePublishedSnapshot } from "../../../../../src/orchestration/auth/provider-observations/subscription-usage-service.js"
import { foldSubscriptionUsageIntoAvailability } from "../../../../../src/orchestration/auth/provider-observations/usage-availability-fold.js"

const NOW_MS = 1_000_000
const RESET_MS = NOW_MS + 3_600_000

function primaryWindow(usedFraction: number): SubscriptionUsageMetric {
  return { metricKey: "primary_window", label: "Primary window", scope: { kind: "account" }, rank: 0, usedFraction, timing: { kind: "exact", startMs: NOW_MS - 1_000, endMs: RESET_MS } }
}
function published(accounts: SubscriptionUsagePublishedSnapshot["accounts"]): SubscriptionUsagePublishedSnapshot {
  return { generation: 1, profileId: "Personal", profileDirectory: "/scratch/personal", checkedAtMs: NOW_MS, thresholds: [], accounts }
}
function report(providerId: string, instanceId: string, usedFraction: number) {
  return { providerId, instanceId, subjectDigest: "digest", providerStatus: "ok" as const, observedAtMs: NOW_MS, readerGeneration: 1, metrics: [primaryWindow(usedFraction)], spendSources: [] }
}
const candidate = (providerId: string, instanceId: string): AccessProviderCandidate => ({ kind: "subscription", providerId, instanceId, spendMode: "included" })

describe("usage availability fold", () => {
  test("a ChatGPT report at its limit suppresses that account; other accounts and providers keep their standing", () => {
    const owner = createProviderAvailability({ now: () => NOW_MS })
    foldSubscriptionUsageIntoAvailability(owner, published([
      { kind: "supported", account: { providerId: "chatgpt", instanceId: "capped" }, snapshot: report("chatgpt", "capped", 1) },
      { kind: "supported", account: { providerId: "chatgpt", instanceId: "fresh" }, snapshot: report("chatgpt", "fresh", 0.4) },
      { kind: "unsupported", account: { providerId: "chatgpt", instanceId: "unread" } },
      { kind: "supported", account: { providerId: "github_copilot", instanceId: "copilot" }, snapshot: report("github_copilot", "copilot", 1) },
    ]))
    const capped = candidate("chatgpt", "capped"); const fresh = candidate("chatgpt", "fresh"); const unread = candidate("chatgpt", "unread"); const copilot = candidate("github_copilot", "copilot")
    const view = owner.forCandidates("Personal", [capped, fresh, unread, copilot])
    expect(view.chatGptStanding(capped)).toEqual({ kind: "suppressed", exhaustion: { exhaustedAtMs: NOW_MS, resetsAtMs: RESET_MS, hold: { kind: "usage_limit", stated: true } } })
    expect(view.chatGptStanding(fresh).kind).toBe("live")
    expect(view.chatGptStanding(unread).kind).toBe("live")
    expect(view.genericQuotaStanding(copilot).kind).toBe("live")
  })
})
