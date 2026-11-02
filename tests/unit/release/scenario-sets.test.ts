import { describe, expect, test } from "bun:test"

import { MEASURED_REPS, measuresAccountService, missingRequiredMetrics, parseScenarioSet, repRoles, scenarioPairedBudgets, scenarioRows } from "../../release/lib/scenario-sets.js"
import { assertPairedBudgets, parseBudgets } from "../../release/lib/metrics.js"
import releaseBudgets from "../../release/budgets.json" with { type: "json" }

describe("release performance scenario sets", () => {
  test("the everyday startup set preserves the A/B startup rows, local and remote, and adds candidate-only summary performance", () => {
    expect(scenarioRows("startup").map((row) => [row.name, row.reps, row.withFixture])).toEqual([
      ["startup-empty", MEASURED_REPS, false],
      ["startup-large", MEASURED_REPS, true],
      ["remote-attach", MEASURED_REPS, false],
      ["session-summary", 1, false],
      ["workflow-agent-upgrade", 3, false],
    ])
    expect(scenarioRows("startup", "baseline").map((row) => row.name)).toEqual(["startup-empty", "startup-large", "remote-attach", "workflow-agent-upgrade"])
    expect(scenarioRows("startup", "candidate").map((row) => row.name)).toEqual(["startup-empty", "startup-large", "remote-attach", "session-summary", "workflow-agent-upgrade"])
    expect(scenarioRows("startup", "candidate", "workflow-agent-upgrade").map(row => row.name)).toEqual(["workflow-agent-upgrade"])
    expect(scenarioRows("startup", "baseline", "workflow-agent-upgrade").map(row => row.name)).toEqual(["workflow-agent-upgrade"])
  })

  test("the release set starts with the startup scenarios and adds every ceiling-bound scenario", () => {
    expect(scenarioRows("release").map((row) => row.name)).toEqual([
      "startup-empty",
      "startup-large",
      "remote-attach",
      "session-summary",
      "workflow-agent-upgrade",
      "session-modal",
      "runner-reconciliation",
      "scroll",
      "parallel-sessions",
      "parallel-children",
      "parallel-workflow-agents",
      "executor-responsiveness",
    ])
    expect(scenarioRows("release").find((row) => row.name === "scroll")?.reps).toBe(1)
    expect(scenarioRows("release").find((row) => row.name === "parallel-workflow-agents")?.reps).toBe(3)
    expect(scenarioRows("release", "baseline").map((row) => row.name)).not.toContain("parallel-sessions")
    expect(scenarioRows("release", "baseline").map((row) => row.name)).toContain("parallel-children")
    expect(scenarioRows("release", "baseline").map((row) => row.name)).toContain("parallel-workflow-agents")
    expect(scenarioRows("release", "baseline").map((row) => row.name)).not.toContain("executor-responsiveness")
  })

  test("both binaries take turns in each rep, and the order flips every rep", () => {
    const [startupEmpty] = scenarioRows("startup")
    const summary = scenarioRows("startup").find((row) => row.name === "session-summary")
    if (startupEmpty === undefined || summary === undefined) throw new Error("the startup set lost a row")
    expect([1, 2, 3].map((rep) => repRoles(startupEmpty, rep, true))).toEqual([["candidate", "baseline"], ["baseline", "candidate"], ["candidate", "baseline"]])
    expect(repRoles(startupEmpty, 2, false)).toEqual(["candidate"])
    expect(repRoles(summary, 2, true)).toEqual(["candidate"])
  })

  test("a row with required metrics names each one its run left absent or not finite", () => {
    const row = scenarioRows("release", "candidate").find((candidate) => candidate.name === "executor-responsiveness")
    if (row === undefined) throw new Error("the release set has no executor-responsiveness row")
    const required = row.requiredMetrics?.("darwin", "candidate") ?? []
    const complete = Object.fromEntries(required.map((metric) => [metric, 1]))
    expect(missingRequiredMetrics(row, complete, "darwin")).toEqual([])
    expect(missingRequiredMetrics(row, { ...complete, "executorResponsiveness.maxLagMs": Number.NaN }, "darwin")).toEqual(["executorResponsiveness.maxLagMs"])
    const { "executorResponsiveness.capacityMacosBatchMs": _macosOnly, ...withoutMacos } = complete
    expect(missingRequiredMetrics(row, withoutMacos, "darwin")).toEqual(["executorResponsiveness.capacityMacosBatchMs"])
    expect(missingRequiredMetrics(row, withoutMacos, "linux")).toEqual([])
    const unrequired = scenarioRows("release").find((candidate) => candidate.name === "scroll")
    if (unrequired === undefined) throw new Error("the release set has no scroll row")
    expect(missingRequiredMetrics(unrequired, {}, "darwin")).toEqual([])
  })

  test("a remote attach run must measure the candidate and lets a baseline without the remote terminal report nothing", () => {
    const row = scenarioRows("startup").find((candidate) => candidate.name === "remote-attach")
    if (row === undefined) throw new Error("the startup set has no remote-attach row")
    expect(missingRequiredMetrics(row, {}, "darwin", "candidate")).toEqual(["remoteAttach.pickerMs", "remoteAttach.firstFrameMs", "remoteAttach.readyMs"])
    expect(missingRequiredMetrics(row, {}, "darwin", "baseline")).toEqual([])
  })

  test("keeps the pinned workflow comparison separate from published startup and validates each role", () => {
    expect(scenarioRows("startup", "baseline", undefined, "published").map(row => row.name)).toEqual(["startup-empty", "startup-large", "remote-attach"])
    expect(scenarioRows("startup", "baseline", undefined, "workflow").map(row => row.name)).toEqual(["workflow-agent-upgrade"])
    for (const role of ["candidate", "baseline"] as const) {
      for (const row of scenarioRows("release", role, undefined, "workflow").filter(candidate => candidate.reps === 3)) {
        const metrics = Object.fromEntries((row.requiredMetrics?.("darwin", role) ?? []).map(key => [key, 1]))
        expect(Object.keys(metrics).length).toBeGreaterThan(0)
        expect(missingRequiredMetrics(row, metrics, "darwin", role)).toEqual([])
        const key = Object.keys(metrics)[0]!
        const incomplete = Object.fromEntries(Object.entries(metrics).filter(([name]) => name !== key))
        expect(missingRequiredMetrics(row, incomplete, "darwin", role)).toContain(key)
      }
    }
  })

  test("does not apply the active workload's three-pair contract to one-rep children", () => {
    const budgets = parseBudgets(releaseBudgets)
    const children = scenarioRows("release").find(row => row.name === "parallel-children")!
    const active = scenarioRows("release").find(row => row.name === "parallel-workflow-agents")!
    const onePair = [{ candidate: {}, baseline: {} }]
    expect(assertPairedBudgets(onePair, scenarioPairedBudgets(children, budgets))).toEqual([])
    expect(() => assertPairedBudgets(onePair, scenarioPairedBudgets(active, budgets))).toThrow("three pairs")
  })

  test("the account service is measured only for a release-set candidate", () => {
    expect(measuresAccountService("release", "candidate")).toBe(true)
    expect(measuresAccountService("release", "baseline")).toBe(false)
    expect(measuresAccountService("startup", "candidate")).toBe(false)
  })

  test("--set accepts only the two named sets", () => {
    expect(parseScenarioSet("startup")).toBe("startup")
    expect(parseScenarioSet("release")).toBe("release")
    expect(() => parseScenarioSet("all")).toThrow("--set must be startup or release")
    expect(() => parseScenarioSet(undefined)).toThrow()
  })
})
