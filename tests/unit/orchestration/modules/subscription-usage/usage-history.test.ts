import { describe, expect, test } from "bun:test"

import type { SubscriptionUsageHistoryEntry } from "../../../../../src/infra/llm/subscription-usage-store.js"
import type { SubscriptionUsageMetric } from "../../../../../src/infra/llm/subscription-usage.js"
import { historyAccount } from "../../../../../src/orchestration/modules/subscription-usage/usage-history.js"

/** The history fold: hourly samples in range, the latest and peak reading per
 *  window, and one marker per reset however many samples still name it. */

const HOUR = 3_600_000

function weekly(usedFraction: number, resetId: string, resetAtMs: number): SubscriptionUsageMetric {
  return { metricKey: "weekly", label: "Weekly", scope: { kind: "account" }, rank: 0, usedFraction, timing: { kind: "unavailable", resetId, resetAtMs } }
}

function entry(hourStartMs: number, metric: SubscriptionUsageMetric): SubscriptionUsageHistoryEntry {
  return { providerId: "copilot", instanceId: "i", subjectDigest: "d", readerGeneration: 1, hourStartMs, observedAtMs: hourStartMs, providerStatus: "ok", metrics: [metric], spendSources: [] }
}

describe("historyAccount", () => {
  test("records a reset once, at the first sample that names it", () => {
    const entries = [
      entry(0, weekly(0.4, "r1", 2 * HOUR)),
      entry(HOUR, weekly(0.9, "r1", 2 * HOUR)),
      entry(2 * HOUR, weekly(0.1, "r2", 9 * HOUR)),
      entry(3 * HOUR, weekly(0.2, "r2", 9 * HOUR)),
    ]
    const account = historyAccount({ providerId: "copilot", instanceId: "i", identity: "octocat" }, entries, 0, 10 * HOUR)
    expect(account.count).toBe(4)
    expect(account.resetMarkers).toEqual([
      { metricName: "weekly", resetId: "r1", resetAtMs: 2 * HOUR, observedAtMs: 0 },
      { metricName: "weekly", resetId: "r2", resetAtMs: 9 * HOUR, observedAtMs: 2 * HOUR },
    ])
    expect(account.peak[0]?.usedFraction).toBe(0.9)
    expect(account.latest[0]?.usedFraction).toBe(0.2)
  })
})
