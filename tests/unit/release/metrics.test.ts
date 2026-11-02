import { describe, expect, test } from "bun:test"
import { assertBudgets, assertPairedBudgets, median, parseBudgets, percentile } from "../../release/lib/metrics.js"
import releaseBudgets from "../../release/budgets.json" with { type: "json" }

describe("median", () => {
  test("odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  test("no values throws", () => {
    expect(() => median([])).toThrow()
  })
})

describe("paired budgets", () => {
  const budgets = {
    latency: { ceiling: 1.2, paired: "ratio" as const },
    heap: { ceiling: 10, paired: "difference" as const },
  }
  const pair = (candidate: number, baseline: number) => ({
    candidate: { latency: candidate, heap: candidate },
    baseline: { latency: baseline, heap: baseline },
  })

  test("uses the median of three pair ratios and signed differences, not variant medians or the worst pair", () => {
    expect(assertPairedBudgets([pair(121, 100), pair(22, 20), pair(300, 400)], budgets)).toEqual([])
    const failures = assertPairedBudgets([pair(121, 100), pair(25, 20), pair(300, 400)], budgets)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ metric: "latency", measured: 1.21, limit: 1.2 })
    expect(assertPairedBudgets([pair(110, 100), pair(30, 20), pair(410, 400)], budgets)).toEqual([])
    expect(assertPairedBudgets([pair(111, 100), pair(31, 20), pair(410, 400)], budgets)[0]).toMatchObject({ metric: "heap", measured: 11, limit: 10 })
  })

  test("enforces every shipped paired bound and the candidate-only status ceiling at equality", () => {
    const shipped = parseBudgets(releaseBudgets)
    for (const [metric, budget] of Object.entries(shipped).filter(([, value]) => value.paired)) {
      const baseline = 100
      const at = budget.paired === "ratio" ? 120 : baseline + budget.ceiling
      const pairs = [1, 2, 3].map(() => ({ candidate: { [metric]: at }, baseline: { [metric]: baseline } }))
      expect(assertPairedBudgets(pairs, { [metric]: budget })).toEqual([])
      const over = pairs.map(value => ({ ...value, candidate: { [metric]: at + 0.01 } }))
      expect(assertPairedBudgets(over, { [metric]: budget })).toHaveLength(1)
    }
    const metric = "parallelWorkflowAgents.statusSnapshotP95Ms"
    expect(assertBudgets({ [metric]: 150 }, shipped)).toEqual([])
    expect(assertBudgets({ [metric]: 150.01 }, shipped)).toHaveLength(1)
  })

  test("rejects incomplete pairs, nonfinite samples and nonpositive ratio baselines", () => {
    expect(() => assertPairedBudgets([pair(1, 1)], budgets)).toThrow("three")
    expect(() => assertPairedBudgets([pair(1, 1), pair(1, 1), { candidate: { heap: 1 }, baseline: { heap: 1 } }], budgets)).toThrow("latency")
    for (const value of [0, -1, Infinity, Number.NaN]) {
      expect(() => assertPairedBudgets([pair(1, 1), pair(1, value), pair(1, 1)], budgets)).toThrow("latency")
    }
  })
})

describe("percentile", () => {
  test("nearest rank", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(values, 95)).toBe(95)
    expect(percentile(values, 100)).toBe(100)
    expect(percentile([7], 95)).toBe(7)
  })
})

describe("assertBudgets", () => {
  const budgets = {
    "a.ms": { ceiling: 100, tolerancePct: 30 },
    "b.count": { ceiling: 3 },
  }

  test("passes under ceiling with no baseline", () => {
    expect(assertBudgets({ "a.ms": 99, "b.count": 3 }, budgets)).toEqual([])
  })

  test("flags a ceiling violation", () => {
    const violations = assertBudgets({ "a.ms": 101 }, budgets)
    expect(violations).toEqual([{ metric: "a.ms", measured: 101, limit: 100, kind: "ceiling" }])
  })

  test("flags a relative regression only when a baseline is present", () => {
    expect(assertBudgets({ "a.ms": 90 }, budgets)).toEqual([])
    const violations = assertBudgets({ "a.ms": 90 }, budgets, [{ candidate: { "a.ms": 90 }, baseline: { "a.ms": 60 } }])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ metric: "a.ms", kind: "regression", baseline: 60 })
  })

  test("a metric without a tolerance never regresses relatively", () => {
    expect(assertBudgets({ "b.count": 3 }, budgets, [{ candidate: { "b.count": 3 }, baseline: { "b.count": 0 } }])).toEqual([])
  })

  test("the tolerance floor absorbs noise-scale regressions on small baselines", () => {
    const floored = { "open.ms": { ceiling: 5000, tolerancePct: 30, toleranceFloor: 500 } }
    // 91 -> 356 is far over 30 percent but under the 500 ms noise floor.
    expect(assertBudgets({ "open.ms": 356 }, floored, [{ candidate: { "open.ms": 356 }, baseline: { "open.ms": 91 } }])).toEqual([])
    // Past both the percentage and the floor it is a real regression.
    const violations = assertBudgets({ "open.ms": 700 }, floored, [{ candidate: { "open.ms": 700 }, baseline: { "open.ms": 91 } }])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ metric: "open.ms", kind: "regression", limit: 591 })
  })

  test("a budgeted metric the run did not produce is not judged", () => {
    // The runner reports the missing metric as a scenario failure instead.
    expect(assertBudgets({}, budgets)).toEqual([])
  })
})

describe("startup release budgets", () => {
  test("never allow a startup regression above 20 percent", () => {
    const startupMetrics = ["startup.empty.firstFrameMs", "startup.empty.readyMs", "startup.large.firstFrameMs", "startup.large.readyMs", "startup.large.sessionListMs"] as const
    for (const metric of startupMetrics) {
      const budget = releaseBudgets[metric]
      expect(budget.tolerancePct).toBe(20)
      expect("toleranceFloor" in budget).toBe(false)
    }
  })

  test("judge the 20 percent tolerance on the median matched pair, not on each role's median", () => {
    const metric = "startup.empty.firstFrameMs"
    const budget = { [metric]: releaseBudgets[metric] }
    const pairs = (...runs: [number, number][]) => runs.map(([candidate, baseline]) => ({ candidate: { [metric]: candidate }, baseline: { [metric]: baseline } }))
    // Role medians 286 over 230 exceed 20 percent, but the pairs show 1.1.
    expect(assertBudgets({ [metric]: 286 }, budget, pairs([220, 200], [500, 230], [286, 260]))).toEqual([])
    // Role medians 390 under 400 pass, but the median pair regresses 30 percent.
    expect(assertBudgets({ [metric]: 390 }, budget, pairs([390, 300], [520, 400], [250, 500]))).toEqual([
      { metric, measured: 390, limit: 360, kind: "regression", baseline: 300 },
    ])
  })

  test("caps complete large catalog hydration and compares it only when the baseline reports it", () => {
    const metric = "startup.large.sessionListMs"
    const budget = { [metric]: releaseBudgets[metric] }
    expect(releaseBudgets[metric].ceiling).toBe(4000)
    expect(assertBudgets({ [metric]: 4001 }, budget)).toEqual([
      { metric, measured: 4001, limit: 4000, kind: "ceiling" },
    ])
    expect(assertBudgets({ [metric]: 1200 }, budget)).toEqual([])
    expect(assertBudgets({ [metric]: 1200 }, budget, [{ candidate: { [metric]: 1200 }, baseline: { [metric]: 900 } }])).toEqual([
      { metric, measured: 1200, limit: 1080, kind: "regression", baseline: 900 },
    ])
  })
})

describe("budget parsing", () => {
  test("applies the host platform's override over the base budget, and leaves other platforms on the base", () => {
    const raw = {
      "a.mb": { ceiling: 200, platform: { win32: { ceiling: 280 } } },
      "b.ms": { ceiling: 1000, tolerancePct: 30, toleranceFloor: 150, platform: { win32: { toleranceFloor: 400 } } },
      "c.count": { ceiling: 3 },
    }
    expect(parseBudgets(raw, "win32")).toEqual({
      "a.mb": { ceiling: 280 },
      "b.ms": { ceiling: 1000, tolerancePct: 30, toleranceFloor: 400 },
      "c.count": { ceiling: 3 },
    })
    expect(parseBudgets(raw, "darwin")).toEqual({
      "a.mb": { ceiling: 200 },
      "b.ms": { ceiling: 1000, tolerancePct: 30, toleranceFloor: 150 },
      "c.count": { ceiling: 3 },
    })
  })

  test("refuses a budget without a numeric ceiling and a malformed override", () => {
    expect(() => parseBudgets({ "a.mb": { tolerancePct: 20 } }, "darwin")).toThrow("needs a numeric ceiling")
    expect(() => parseBudgets({ "a.mb": { ceiling: 1, platform: [] } }, "darwin")).toThrow("platform overrides")
    expect(() => parseBudgets({ "a.mb": { ceiling: 1, platform: { win32: { ceiling: "x" } } } }, "win32")).toThrow("needs a numeric ceiling")
  })

  test("the checked-in budgets parse on every release platform", () => {
    for (const platform of ["darwin", "linux", "win32"]) expect(Object.keys(parseBudgets(releaseBudgets, platform)).length).toBe(Object.keys(releaseBudgets).length)
    expect(parseBudgets(releaseBudgets, "win32")["accountService.zeroProjectRssMb"]?.ceiling).toBe(315)
    expect(parseBudgets(releaseBudgets, "darwin")["accountService.zeroProjectRssMb"]?.ceiling).toBe(290)
  })
})
