import { describe, expect, it } from "bun:test"
import { canonicalScenarios } from "./golden/_canonical-scenarios.js"
import { runCanonicalScenario } from "./golden/_golden-harness.js"

describe("workflow VM host canonical golden", () => {
  it("pins the reviewed 25-scenario conversion matrix", () => {
    expect(canonicalScenarios).toHaveLength(25)
    expect(new Set(canonicalScenarios.map(({ id }) => id)).size).toBe(25)
    for (const scenario of canonicalScenarios) {
      expect(scenario.area.length).toBeGreaterThan(0)
      expect(scenario.enduringSemantics.length).toBeGreaterThan(0)
      expect(scenario.retiredRuntimeEnvelope.length).toBeGreaterThan(0)
    }
  })

  for (const scenario of canonicalScenarios) {
    it(`${scenario.area}: ${scenario.id}`, async () => {
      const observation = await runCanonicalScenario(scenario)
      const resumeRevertCounts: readonly number[] = observation.attemptDetails.map(({ resumeRevertCount }) => resumeRevertCount)
      expect({
        invocations: observation.invocations,
        status: observation.status,
        attempts: observation.attempts,
        completed: observation.completed,
        failed: observation.failed,
        ...(scenario.expected.resumeRevertCounts ? { resumeRevertCounts } : {}),
      }).toEqual(scenario.expected)
      expect(observation.committedEvents[0]).toBe(scenario.action === "poison" ? "RECOVER" : "START")
      if (!scenario.expected.resumeRevertCounts) {
        expect(resumeRevertCounts.every((count) => count === 0)).toBe(true)
      }
    })
  }

  it("preserves ordered per-item and reassessment payloads", async () => {
    const fanOut = canonicalScenarios.find(({ id }) => id === "each-three-items")
    const reassessment = canonicalScenarios.find(({ id }) => id === "reassess-respecification")
    if (!fanOut || !reassessment) throw new Error("Payload scenarios are missing")

    // Every agent of a round receives the round's item.
    expect((await runCanonicalScenario(fanOut)).invocationItems).toEqual([
      null,
      { id: "a" }, { id: "a" },
      { id: "b" }, { id: "b" },
      { id: "c" }, { id: "c" },
    ])
    expect((await runCanonicalScenario(reassessment)).invocationItems).toEqual([
      null,
      { id: "a" }, { id: "a" },
      { id: "b-revised" }, { id: "b-revised" },
      { id: "c" }, { id: "c" },
    ])
  })

  it("crash recovery never reruns completed work", async () => {
    const scenario = canonicalScenarios.find(({ id }) => id === "crash-after-committed-start")
    if (!scenario) throw new Error("Crash recovery scenario is missing")
    const observation = await runCanonicalScenario(scenario)
    expect(observation.invocations.filter((definitionId) => definitionId === "one")).toEqual(["one"])
    expect(observation.invocations.filter((definitionId) => definitionId === "two")).toEqual(["two", "two"])
  })
})