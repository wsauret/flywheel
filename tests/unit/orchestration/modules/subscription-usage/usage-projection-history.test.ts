import { describe, expect, test } from "bun:test"

import type { UsageHourlySpend } from "../../../../../src/infra/llm/usage-authority.js"
import { projectUsageHistory, projectUsageSpend, type CurrentUsageObservationSet, type MeteredUsageSource } from "../../../../../src/orchestration/modules/subscription-usage/usage-projection.js"
import { subscriptionSpendAccountCorrelationId } from "../../../../../src/protocol/subscription-spend-consent-protocol-types.js"

/** History carries spend by hour for every source the ledger attributed, so a
 *  metered key, which has no provider window to sample, still has a history. */

const HOUR = 3_600_000
const metadata = { profileId: "p", authorityIncarnation: "a", revision: 1, generation: 1, asOf: 10 * HOUR }
const current: CurrentUsageObservationSet = { ...metadata, accounts: [] }
const key: MeteredUsageSource = { kind: "metered", sourceId: "lineage-1", providerId: "anthropic", label: "Anthropic", spendMode: "direct_api" }

function group(hourStartMs: number, estimatedUsd: number, classification: "real_spend" | "subscription_equivalent"): UsageHourlySpend["groups"][number] {
  return { hourStartMs, attributionKind: "unattributed", credentialLineage: "lineage-1", spendMode: "direct_api", model: "claude", classification, attempts: 1, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, estimatedUsd, priceUnavailable: false }
}

describe("projectUsageHistory", () => {
  test("lists a metered key with its spend by hour, billed and covered kept apart", () => {
    const spend: UsageHourlySpend = { start: "", end: "", groups: [group(HOUR, 0.25, "real_spend"), group(HOUR, 0.5, "real_spend"), group(2 * HOUR, 1, "subscription_equivalent")] }
    const result = projectUsageHistory({ metadata, history: { range: "24h", startMs: 0, endMs: 10 * HOUR, accounts: [] }, spend, current, metered: [key], providerDisplayName: (id) => id, metricDetail: () => false })
    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]).toMatchObject({ sourceId: "lineage-1", kind: "metered", label: "Anthropic", count: 0, samples: [] })
    expect(result.sources[0]?.spend).toEqual([{ hourStartMs: HOUR, billedUsd: 0.75, includedUsd: 0 }, { hourStartMs: 2 * HOUR, billedUsd: 0, includedUsd: 1 }])
  })

  test("a metered-billed account keeps the spend attributed to it, as a metered source in History and Spend", () => {
    const sourceId = subscriptionSpendAccountCorrelationId("p", "claude", "uuid-enterprise")
    const account: MeteredUsageSource = { kind: "metered", sourceId, providerId: "claude", label: "Anthropic Sub", spendMode: "direct_api", identity: "enterprise@example.com" }
    const attributed = { ...group(HOUR, 2, "real_spend"), attributionKind: "candidate" as const, providerId: "claude", instanceId: "uuid-enterprise", credentialLineage: "uuid-enterprise" }
    const history = projectUsageHistory({ metadata, history: { range: "24h", startMs: 0, endMs: 10 * HOUR, accounts: [] }, spend: { start: "", end: "", groups: [attributed] }, current, metered: [account], providerDisplayName: (id) => id, metricDetail: () => false })
    expect(history.sources).toEqual([expect.objectContaining({ sourceId, kind: "metered", spend: [{ hourStartMs: HOUR, billedUsd: 2, includedUsd: 0 }] })])
    // A model whose provider did not report cache reads makes its own and its source's cache detail unknown.
    const unreported = { ...attributed, model: "gpt", cacheComplete: false }
    const spend = projectUsageSpend({ metadata, range: "24h", entries: { start: new Date(0).toISOString(), end: new Date(10 * HOUR).toISOString(), groups: [attributed, unreported] }, trackingStart: new Date(0).toISOString(), incomplete: false, current, metered: [account], providerDisplayName: (id) => id })
    expect(spend.sources).toEqual([expect.objectContaining({ sourceId, kind: "metered", label: "Anthropic Sub", active: true, estimatedBilledUsd: 4, cacheComplete: false })])
    expect(spend.sources[0]?.models.map(({ model, cacheComplete }) => [model, cacheComplete])).toEqual([["claude", true], ["gpt", false]])
  })

  test("a source without an open store has no spend and is still listed", () => {
    const result = projectUsageHistory({ metadata, history: { range: "24h", startMs: 0, endMs: 10 * HOUR, accounts: [] }, spend: undefined, current, metered: [key], providerDisplayName: (id) => id, metricDetail: () => false })
    expect(result.sources[0]?.spend).toEqual([])
  })
})
