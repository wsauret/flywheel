import { describe, expect, test } from "bun:test"

import { type UsageHistorySource, historySeries, spendSeries } from "../../../../src/protocol/modules/subscription-usage.js"


/** The one rule both clients draw history from: the windows the provider
 *  still reports that saw use, their points, resets, latest, and peak, and
 *  spend over the range for whatever was billed. */

type Metric = UsageHistorySource["latest"][number]
const HOUR = 3_600_000
const metric = (label: string, key: string, usedFraction: number, rank = 0, timing: Metric["timing"] = { kind: "unavailable" }): Metric => ({ metricKey: key, label, scope: { kind: "account" }, rank, timing, usedFraction })
/** A window the provider module stamped as detail: hidden until a viewer asks for it. */
const detail = (label: string, key: string, usedFraction: number, rank = 0): Metric => ({ ...metric(label, key, usedFraction, rank), detail: true })
const sample = (hourStartMs: number, metrics: Metric[]): UsageHistorySource["samples"][number] => ({ hourStartMs, observedAtMs: hourStartMs, providerStatus: "ok", metrics, spendSources: [] })
const source = (overrides: Partial<UsageHistorySource>): UsageHistorySource => ({ sourceId: "acct-1", kind: "subscription", providerId: "copilot", label: "Copilot", spendSources: [], count: 0, samples: [], latest: [], peak: [], resetMarkers: [], spend: [], ...overrides })

describe("historySeries", () => {
  test("charts a window from its hourly samples with the provider's resets, latest, and peak", () => {
    const weekly = (usedFraction: number, resetId?: string) => metric("Weekly", "weekly", usedFraction, 0, resetId === undefined ? { kind: "unavailable" } : { kind: "unavailable", resetId, resetAtMs: 2 * HOUR })
    const [series] = historySeries(source({
      count: 3,
      samples: [sample(0, [weekly(0.4)]), sample(HOUR, [weekly(0.9)]), sample(2 * HOUR, [weekly(0.1, "r1")])],
      latest: [weekly(0.1, "r1")],
      peak: [weekly(0.9)],
      resetMarkers: [{ metricName: "weekly", resetId: "r1", resetAtMs: 2 * HOUR, observedAtMs: 2 * HOUR }],
    }), false)
    expect(series?.points.map((point) => point.fraction)).toEqual([0.4, 0.9, 0.1])
    expect(series?.resets).toEqual([2 * HOUR])
    expect(series?.latest).toBe("10% used")
    expect(series?.peak).toBe("90% peak")
  })

  test("drops a key the provider no longer reports and a window that saw no use, keeping the first window", () => {
    const rows = source({
      providerId: "opencode_go", label: "OpenCode Go", count: 2,
      samples: [sample(0, [metric("Rolling", "Rolling", 0.2, 1), metric("weekly", "weekly", 0.1, 2)]), sample(HOUR, [metric("rolling", "rolling", 0.3, 1), metric("weekly", "weekly", 0.1, 2), metric("reserve", "reserve", 0, 3)])],
      latest: [metric("Rolling", "Rolling", 0.2, 1), metric("rolling", "rolling", 0.3, 1), metric("weekly", "weekly", 0.1, 2), metric("reserve", "reserve", 0, 3)],
      peak: [metric("Rolling", "Rolling", 0.2, 1), metric("rolling", "rolling", 0.3, 1), metric("weekly", "weekly", 0.1, 2), metric("reserve", "reserve", 0, 3)],
    })
    expect(historySeries(rows, false).map((series) => series.label)).toEqual(["rolling", "weekly"])
  })

  test("a source whose only window is untouched still charts it, and detail windows hide until asked", () => {
    const only = source({ count: 1, samples: [sample(0, [metric("Weekly", "weekly", 0)])], latest: [metric("Weekly", "weekly", 0)], peak: [metric("Weekly", "weekly", 0)] })
    expect(historySeries(only, false).map((series) => series.label)).toEqual(["Weekly"])
    const chatgpt = source({ providerId: "chatgpt", samples: [sample(0, [metric("Primary", "primary", 0.5), detail("Spark", "spark", 0.5, 1)])], latest: [metric("Primary", "primary", 0.5), detail("Spark", "spark", 0.5, 1)], peak: [metric("Primary", "primary", 0.5), detail("Spark", "spark", 0.5, 1)] })
    expect(historySeries(chatgpt, false).map((series) => series.label)).toEqual(["Primary"])
    expect(historySeries(chatgpt, true).map((series) => series.label)).toEqual(["Primary", "Spark"])
  })
})

describe("spendSeries", () => {
  const metered = (spend: UsageHistorySource["spend"]) => source({ sourceId: "key-1", kind: "metered", providerId: "anthropic", label: "Anthropic", spend })

  test("a metered key's spend climbs hour by hour to its total in the range", () => {
    const [series] = spendSeries(metered([{ hourStartMs: HOUR, billedUsd: 1, includedUsd: 0 }, { hourStartMs: 2 * HOUR, billedUsd: 3, includedUsd: 0 }]), 0)
    expect(series?.label).toBe("Spend")
    expect(series?.latest).toBe("$4.00 in range")
    expect(series?.points).toEqual([{ atMs: 0, fraction: 0 }, { atMs: HOUR, fraction: 0.25 }, { atMs: 2 * HOUR, fraction: 1 }])
  })

  test("nothing billed is no series, and a subscription charts only spend beyond the plan", () => {
    expect(spendSeries(metered([]), 0)).toEqual([])
    expect(spendSeries(metered([{ hourStartMs: 0, billedUsd: 0, includedUsd: 2 }]), 0)).toEqual([])
    expect(spendSeries({ ...metered([{ hourStartMs: 0, billedUsd: 0.5, includedUsd: 2 }]), kind: "subscription" }, 0)[0]?.label).toBe("Billed beyond the plan")
  })
})
