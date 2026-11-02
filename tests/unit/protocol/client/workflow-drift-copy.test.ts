import { describe, expect, test } from "bun:test"
import { workflowDriftExplanation } from "../../../../src/protocol/client/workflow-drift-copy.js"
import { parseDefinitionProvenanceFact } from "../../../../src/workflows/definition-provenance-facts.js"
import { publishedDefinitionDrift } from "../../../../src/workflows/vm/definition-identity.js"
import { currentDefinitionDriftRejection } from "../../../../src/workflows/vm/recovery.js"

describe("workflow drift copy", () => {
  test("says why a workflow whose definition changed cannot continue, names each changed part once, and says that Resume continues it once they are restored", () => {
    expect(workflowDriftExplanation({
      workflowDefinitionId: "implement",
      changes: [
        { component: "persona", id: "reviewer" },
        { component: "graph" },
        { component: "skill", id: "implementation" },
        { component: "agent", id: "review", aspect: "policy" },
        { component: "agent", id: "review", aspect: "output" },
        { component: "agent", id: "implement", aspect: "content" },
        { component: "skill", id: "code-review" },
        { component: "skill", id: "implementation" },
        { component: "agent", aspect: "output" },
        { component: "skill", id: "verification" },
        { component: "skill", id: "debugging" },
        { component: "skill", id: "planning" },
        { component: "version" },
      ],
    })).toBe("The implement workflow cannot continue because its definition changed after it started. "
      + "These parts changed: the order of its phases; the settings of agent review; the instructions of agent implement; the output of agent review; a shared agent output; skills implementation, code-review, verification, and 2 more; persona reviewer; the workflow engine. "
      + "Restore them, then press Resume, or start a new workflow.")
    expect(workflowDriftExplanation({ workflowDefinitionId: "gsd", changes: [{ component: "persona", id: "critic" }, { component: "persona", id: "explorer" }] }))
      .toContain("These parts changed: personas critic and explorer.")
  })

  test("renders a drift rejection that a build before briefs stored, with a binding and a handoff type", () => {
    const stored = {
      type: "definition.drift_rejected", version: 1, actor: "flywheel",
      payload: {
        workflowId: "implement",
        latestSeq: 4,
        changes: [
          { component: "binding", bindingId: "review", recorded: "a".repeat(64), current: "b".repeat(64) },
          { component: "registry", handoffType: "work-handoff", recorded: "c".repeat(64), current: "d".repeat(64) },
        ],
      },
    }
    expect(parseDefinitionProvenanceFact(stored).type).toBe("definition.drift_rejected")
    const rejection = currentDefinitionDriftRejection([stored])
    if (!rejection) throw new Error("the stored rejection still holds")
    expect(workflowDriftExplanation(publishedDefinitionDrift(rejection.workflowId, rejection.changes)))
      .toContain("These parts changed: the settings of agent review; a shared agent output.")
  })

  test("names each changed phase once by its path", () => {
    const changes = [
      { component: "phase", phaseId: "build/verify", recorded: "c".repeat(64), current: "d".repeat(64) },
      { component: "phase", phaseId: "ship", recorded: "e".repeat(64), current: "f".repeat(64) },
    ] as const
    const drift = publishedDefinitionDrift("tree", changes)
    expect(drift.changes).toEqual([{ component: "graph", id: "build/verify" }, { component: "graph", id: "ship" }])
    expect(workflowDriftExplanation(drift)).toContain("These parts changed: the agents of phases build/verify and ship.")
  })
})
