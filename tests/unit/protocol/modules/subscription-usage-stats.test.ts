import { expect, test } from "bun:test"
import { Schema } from "effect"
import { generationSpeedLines, subscriptionUsageProtocol, sumUsageCoverage, sumUsageTokens, usageCoverageText, usageTokenBreakdown, usageStatsStatusRow, type UsageSessionStats } from "../../../../src/protocol/modules/subscription-usage.js"

const generation = {
  basis: "O200kBase" as const, coverageComplete: false, models: [],
  totals: { outputTokens: 0, durationMs: 0, measuredRequests: 0, unmeasuredRequests: 1, measuredBlocks: 0, excludedBlocks: 1, averageTokensPerSecond: null },
}

test("cache rates use all prompt buckets and weight the summed input", () => {
  const tokens = sumUsageTokens([
    { input: 0, output: 20, cacheRead: 10, cacheWrite: 0, reasoning: 10, total: 20 },
    { input: 40, output: 30, cacheRead: 0, cacheWrite: 50, reasoning: 15, total: 70 },
  ])
  expect(usageTokenBreakdown(tokens)).toEqual({
    input: 100, cached: 10, uncached: 90, cacheWrite: 50, output: 50, cacheHitRate: 0.1,
  })
})

test("empty input has no cache rate, while uncached input has a measured zero rate", () => {
  expect(usageTokenBreakdown(sumUsageTokens([])).cacheHitRate).toBeNull()
  expect(usageTokenBreakdown({ input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }).cacheHitRate).toBe(0)
})

test("coverage counts partial requests inside the measured count and names unmeasured ones beside it", () => {
  const coverage = { attempts: 12, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true }
  expect(usageCoverageText(coverage)).toBe("12 measured requests")
  expect(usageCoverageText({ ...coverage, unmeasuredAttempts: 2, partialAttempts: 1 })).toBe("12 measured requests (1 partial) · 2 unmeasured")
  expect(sumUsageCoverage([coverage, { ...coverage, unmeasuredAttempts: 1, cacheComplete: false }])).toEqual({ attempts: 24, unmeasuredAttempts: 1, partialAttempts: 0, cacheComplete: false })
})

test("Status distinguishes missing history, no input, and a failed read", () => {
  const summary = { attempts: 0, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: sumUsageTokens([]), estimatedBilledUsd: 0, includedValueUsd: 0, priceUnavailable: false }
  const stats: UsageSessionStats = {
    sessionId: "session", asOf: 0, partial: false, descendantCount: 0,
    direct: summary, descendants: summary, totals: summary, models: [], tools: [], generation,
  }
  expect(usageStatsStatusRow(stats).value).toBe("No usage yet")
  expect(usageStatsStatusRow({ ...stats, partial: true, totals: { ...stats.totals, cacheComplete: false } }).value).toBe("Unavailable · not reported for every request")
  expect(usageStatsStatusRow(undefined)).toMatchObject({ value: "Unavailable", action: { kind: "surface", id: "usage-stats" } })
})

test("Stats codec requires generation evidence and validates measured values without inventing a speed", () => {
  const query = subscriptionUsageProtocol.queries.find((entry) => entry.query === "usage.stats")!
  const decode = Schema.decodeUnknownSync(query.result, { onExcessProperty: "error" })
  const summary = { attempts: 0, unmeasuredAttempts: 0, partialAttempts: 0, cacheComplete: true, tokens: sumUsageTokens([]), estimatedBilledUsd: 0, includedValueUsd: 0, priceUnavailable: false }
  const stats = { sessionId: "session", asOf: 0, partial: false, descendantCount: 0, direct: summary, descendants: summary, totals: summary, models: [], tools: [], generation }
  expect(decode(stats)).toEqual(stats)
  const measured = { outputTokens: 100, durationMs: 5000, measuredRequests: 1, unmeasuredRequests: 0, measuredBlocks: 1, excludedBlocks: 0, averageTokensPerSecond: 20 }
  expect(decode({ ...stats, generation: { ...generation, totals: measured, models: [{ ...measured, model: "model", reasoningEffort: null }] } })).toMatchObject({ generation: { models: [{ reasoningEffort: null, averageTokensPerSecond: 20 }] } })
  for (const invalid of [-1, Infinity, Number.NaN, "20"]) expect(() => decode({ ...stats, generation: { ...generation, totals: { ...measured, averageTokensPerSecond: invalid } } })).toThrow()
  expect(() => decode({ ...stats, generation: undefined })).toThrow()
  expect(() => decode({ ...stats, generation: { ...generation, totals: { ...measured, measuredRequests: 1.5 } } })).toThrow()
})

test("generation comparison rows share exact model effort labels, unavailable readings and coverage", () => {
  const totals = { outputTokens: 100, durationMs: 5482, measuredRequests: 2, unmeasuredRequests: 1, measuredBlocks: 3, excludedBlocks: 2, averageTokensPerSecond: 18.24 }
  const lines = generationSpeedLines({ basis: "O200kBase", coverageComplete: false, totals,
    models: [
      { ...totals, model: "model", reasoningEffort: "medium" },
      { ...totals, model: "model", reasoningEffort: "high", averageTokensPerSecond: 12.36 },
      { ...totals, model: "other", reasoningEffort: null, averageTokensPerSecond: null },
    ] })
  expect(lines.rows).toEqual([
    { label: "model · medium", value: "18.2 avg tok/s" },
    { label: "model · high", value: "12.4 avg tok/s" },
    { label: "other · not recorded", value: "Not measured" },
  ])
  expect(lines.coverageLines).toEqual([
    "2 measured requests · 1 known unmeasured requests · 2 excluded output blocks",
    "Some output has no measurement. Historical request coverage can be unknown.",
    "Single-chunk output has no measurable streaming duration. Historical requests are not backfilled.",
  ])
  expect(lines.basisLine).toBe("O200kBase local comparison tokens. Assistant text and streamed tool arguments only. Not billed provider tokens.")
  expect(generationSpeedLines(generation).rows).toEqual([{ label: "Generation speed", value: "Not measured" }])
  expect(generationSpeedLines({ basis: "O200kBase", coverageComplete: true, totals, models: [] }).coverageLines).toHaveLength(1)
})
