import { describe, expect, test } from "bun:test"
import { parentMayContinue, personCutRefusal, subagentRunCut, workflowStepCut, type ChildCut } from "../../../../src/orchestration/session/child-continuation"
import { interruptedTurnMessage, turnEndEntryId, turnEndOfEntry } from "../../../../src/orchestration/session/conversation/turn-end-record"
import type { WorkflowAgentTurnEnd } from "../../../../src/orchestration/session/chat-session-run-evidence"
import type { WorkflowDeliveryAddress } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages"

describe("the parent agent's continuation of its own child", () => {
  // One predicate decides both the parent's Resume and whether its message
  // hands the child back: the person's latest decision wins.
  test.each<[ChildCut, boolean]>([
    [{ kind: "interrupt", by: "person" }, false],
    [{ kind: "interrupt", by: "agent" }, true],
    [{ kind: "interrupt", by: "runtime" }, true],
    [{ kind: "stop", by: "person" }, false],
    [{ kind: "stop", by: "agent" }, true],
    [{ kind: "exit" }, true],
    [{ kind: "attempt" }, true],
  ])("admits %o: %p", (cut, admitted) => {
    expect(parentMayContinue(cut)).toBe(admitted)
  })

  test("tells the parent that only a person continues work that a person cut", () => {
    expect(personCutRefusal({ kind: "interrupt", by: "person" })).toBe("A person interrupted this child, so only a person can continue it, with Resume or a message.")
    expect(personCutRefusal({ kind: "stop", by: "person" })).toBe("A person stopped this child, so only a person can resume it.")
  })

  test("reads a paused or interrupted subagent run's interrupter from its turn-end record, and a paused run's own record only when no turn end names one", () => {
    const pausedBy = (by: "person" | "agent" | "runtime") => ({ reason: "paused" as const, pausedBy: by })
    // `subagent.paused` saves the parent's interrupt as a person's, so the
    // record decides.
    expect(subagentRunCut({ status: "paused", pausedBy: "person" }, pausedBy("agent"))).toEqual({ kind: "interrupt", by: "agent" })
    expect(subagentRunCut({ status: "paused", pausedBy: "runtime" }, undefined)).toEqual({ kind: "interrupt", by: "runtime" })
    expect(subagentRunCut({ status: "paused" }, undefined)).toEqual({ kind: "exit" })
    expect(subagentRunCut({ status: "interrupted" }, pausedBy("person"))).toEqual({ kind: "interrupt", by: "person" })
    expect(subagentRunCut({ status: "interrupted" }, { reason: "crash" })).toEqual({ kind: "exit" })
    expect(subagentRunCut({ status: "cancelled" }, undefined)).toEqual({ kind: "stop", by: "agent" })
    expect(subagentRunCut({ status: "stopped" }, undefined)).toEqual({ kind: "stop", by: "person" })
    expect(subagentRunCut({ status: "failed" }, undefined)).toEqual({ kind: "attempt" })
    expect(subagentRunCut({ status: "completed" }, undefined)).toBeUndefined()
  })

  test("records a parent agent's interrupt under the person's id prefix and reads it back as the parent's", () => {
    const id = turnEndEntryId({ reason: "paused", pausedBy: "agent" }, "k1")
    // A release that predates the agent actor reads the id as a person's
    // interrupt, which decides alike in every rule but the parent's continuation.
    expect(id).toStartWith("itb-paused-person-")
    const message = { kind: "user", origin: "system" }
    expect(turnEndOfEntry({ kind: "message", id, message })).toEqual({ reason: "paused", pausedBy: "agent" })
    expect(turnEndOfEntry({ kind: "message", id: turnEndEntryId({ reason: "paused", pausedBy: "person" }, "k2"), message })).toEqual({ reason: "paused", pausedBy: "person" })
    expect(interruptedTurnMessage("agent", false)).toBe("Your parent session interrupted this turn before it finished.")
  })

  test("reads a workflow step's cut from its turn end", () => {
    const step = { agent: { id: "one" }, attemptId: "attempt", conversationId: "conversation" }
    expect(workflowStepCut([{ ...step, turnEnd: { recorded: true, end: { reason: "paused", pausedBy: "agent" } } }])).toEqual({ kind: "interrupt", by: "agent" })
    expect(workflowStepCut([{ ...step, turnEnd: { recorded: true, end: { reason: "crash" } } }])).toEqual({ kind: "exit" })
    expect(workflowStepCut([{ ...step, turnEnd: undefined }])).toBeUndefined()
    expect(workflowStepCut([])).toBeUndefined()
  })

  test("selects reached cuts before applying person, parent, runtime, and exit precedence", () => {
    const ends: readonly WorkflowAgentTurnEnd[] = (["runtime", "agent", "person"] as const).map((by, index) => ({
      agent: { id: `step-${index}` }, attemptId: `attempt-${index}`, conversationId: `conversation-${index}`,
      turnEnd: { recorded: true, end: { reason: "paused", pausedBy: by } },
    }))
    const address = (nodeId: string): WorkflowDeliveryAddress => ({ addressedTo: [{ _tag: "agent", nodeId, definitionId: nodeId }], label: nodeId })
    expect(workflowStepCut(ends)).toEqual({ kind: "interrupt", by: "person" })
    expect(workflowStepCut(ends.slice(0, 2))).toEqual({ kind: "interrupt", by: "agent" })
    expect(workflowStepCut(ends.slice(0, 1))).toEqual({ kind: "interrupt", by: "runtime" })
    expect(workflowStepCut(ends, address("step-1"))).toEqual({ kind: "interrupt", by: "agent" })
    expect(parentMayContinue(workflowStepCut(ends, address("step-1"))!)).toBe(true)
    expect(parentMayContinue(workflowStepCut(ends, address("step-2"))!)).toBe(false)
    expect(workflowStepCut(ends, address("unrelated"))).toBeUndefined()
  })
})
