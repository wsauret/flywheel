import { expect, test } from "bun:test"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types"
import { createWorkflowAgentInputs } from "../../../../src/orchestration/workflow-host/agent-inputs"
import type { WorkflowWake } from "../../../../src/orchestration/workflow-host/runner-types"
import { WHOLE_WORKFLOW } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages"
import { startedAgents } from "../../../../src/workflows/vm/host-commit-controller"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten"
import { startNext, wideControl, wideBindings } from "../../workflows/vm/_tree-fixtures"
import { createMemoryStore } from "../../workflows/vm/host-test-support"

const item = (ordinal: number) => ({
  addressedTo: [{ _tag: "item" as const, listNodeId: "input-mapped:node:1", itemNodeId: `input-mapped:node:1:item:${ordinal}`, key: `t${ordinal}` }] as const,
  label: `item t${ordinal}`,
})

function fixture(wake: WorkflowWake = WHOLE_WORKFLOW) {
  const attempts = startedAgents(flattenWorkflowView(startNext(startNext(wideControl(2))), wideBindings))
  const inputs = createWorkflowAgentInputs({ sessionId: "session", store: asAsyncEventReadSurface(createMemoryStore([])), wake, runningAgents: () => attempts.map(({ agent }) => agent) })
  const open = (index: number, by?: "person" | "agent" | "runtime") => {
    const attempt = attempts[index]!
    const input = inputs.open(attempt)
    input.initialize(attempt.agent, by === undefined ? undefined : { end: { reason: "paused", pausedBy: by }, recorded: true }, 25)
    return input
  }
  return { inputs, open, attempts }
}

test("targeted cuts and hand-back preserve sibling coverage before generation opening", () => {
  const { inputs, open } = fixture()
  const a = open(0), b = open(1)
  inputs.interrupt(WHOLE_WORKFLOW, "person")
  expect(a.cut?.by).toBe("person")
  expect(b.cut?.by).toBe("person")
  expect(inputs.resume(item(2))).toEqual([expect.any(String)])
  expect(a.cut?.by).toBe("person")
  expect(b.cut).toBeUndefined()
  expect(a.queue.drainPending()).toBeNull()
  expect(b.queue.drainPending()).toMatchObject({ kind: "resume" })
  expect(inputs.resume(item(2))).toEqual([])
  expect(inputs.resume(WHOLE_WORKFLOW)).toHaveLength(1)
  expect(inputs.pendingCut(WHOLE_WORKFLOW)).toBeUndefined()
})

test("a handing-off workflow member admits no further direction or control, while its sibling still reads input", () => {
  const { inputs, open, attempts } = fixture()
  const a = open(0), b = open(1)
  a.queue.handoffStarted()
  expect(inputs.stateOf(attempts[0]!.attemptId)).toBe("handing_off")
  expect(a.resumeFromParent()).toBe(false)
  expect(a.resumeFromPerson()).toBe(false)
  expect(a.interrupt("person")).toBe(false)
  expect(inputs.interrupt(item(1), "person")).toBe(false)
  expect(inputs.pendingCut(item(1))).toBeUndefined()
  expect(inputs.stateAt(item(1))).not.toBe("interrupted")
  expect(inputs.deliver({ text: "direction", dispatchIds: ["direction"] }, { status: "delivered", startsTurn: false }, WHOLE_WORKFLOW)).toEqual([attempts[1]!.attemptId])
  expect(inputs.notify({ key: "notice", text: "result" })).toBe(true)
  expect(inputs.compact()).toBe(true)
  expect(a.queue.drainPending()).toBeNull()
  expect(b.queue.drainPending()).toMatchObject({ text: "direction" })
  expect(b.queue.drainPending()).toMatchObject({ text: "result" })
  expect(b.queue.drainPending()).toMatchObject({ kind: "compact" })
  b.queue.handoffStarted()
  expect(inputs.notify({ text: "late" })).toBe(false)
  expect(inputs.compact()).toBe(false)
  expect(inputs.interrupt(WHOLE_WORKFLOW, "person")).toBe(false)
  expect(inputs.pendingCut(WHOLE_WORKFLOW)).toBeUndefined()
})

test("private parent hand-back resumes exactly the asking member, never its sibling or a person cut", () => {
  const { inputs, open } = fixture()
  const a = open(0), b = open(1)
  inputs.interrupt(WHOLE_WORKFLOW, "agent")
  expect(a.resumeFromParent()).toBe(true)
  expect(a.cut).toBeUndefined()
  expect(b.cut?.by).toBe("agent")
  expect(a.queue.drainPending()).toMatchObject({ kind: "resume" })
  expect(b.queue.drainPending()).toBeNull()
  inputs.interrupt(item(1), "person")
  expect(a.resumeFromParent()).toBe(false)
  expect(a.cut?.by).toBe("person")
  expect(a.resumeFromPerson()).toBe(true)
  expect(a.cut).toBeUndefined()
  expect(b.cut?.by).toBe("agent")
  expect(inputs.interrupt(item(1), "person")).toBe(true)
})

test.each([true, false])("person authority wins overlapping pending cuts in either order: %s", (personFirst) => {
  const { inputs, open } = fixture()
  inputs.interrupt(personFirst ? item(1) : WHOLE_WORKFLOW, personFirst ? "person" : "agent")
  inputs.interrupt(personFirst ? WHOLE_WORKFLOW : item(1), personFirst ? "agent" : "person")
  const a = open(0), b = open(1)
  expect(a.cut?.by).toBe("person")
  expect(b.cut?.by).toBe("agent")
  inputs.resume(item(2))
  expect(a.cut?.by).toBe("person")
  expect(b.cut).toBeUndefined()
})

test("initialization records uncut evidence and restores only non-reached control parks", () => {
  const { inputs, open, attempts } = fixture(item(2))
  const a = inputs.open(attempts[0]!)
  expect(inputs.evidence(attempts[0]!.attemptId)).toBeUndefined()
  a.initialize(attempts[0]!.agent, { end: { reason: "paused", pausedBy: "person" }, recorded: true }, 25)
  const b = open(1, "person")
  expect(a.cut).toEqual({ by: "person", timestamp: 25 })
  expect(b.cut).toBeUndefined()
  expect(inputs.evidence(attempts[1]!.attemptId)).toEqual({ cut: undefined })
  inputs.resume(item(1))
  expect(a.cut).toBeUndefined()
  expect(a.takeOpeningInterrupt()).toBeUndefined()
})

test("planned wake preserves each control park, and replacement cannot downgrade parent or person authority", () => {
  const { inputs, open } = fixture("planned")
  const a = open(0, "person"), b = open(1, "agent")
  expect(a.interrupt("agent")).toBe(false)
  expect(a.interrupt("replacement")).toBe(false)
  expect(b.interrupt("replacement")).toBe(false)
  expect(a.takeOpeningInterrupt()).toEqual({ by: "person", timestamp: 25 })
  expect(b.takeOpeningInterrupt()).toEqual({ by: "agent", timestamp: 25 })
  expect(inputs.resume(WHOLE_WORKFLOW)).toHaveLength(2)
  expect(a.interruptionToRecord()).toBe("person")
  expect(b.interruptionToRecord()).toBe("agent")
  a.resumed()
  expect(a.takeOpeningInterrupt()).toBeUndefined()
})

test("a capacity wake of a live run continues each named agent the runtime cut, and keeps a person's cut and every agent it does not name", () => {
  const conversation = (index: number) => `conversation-${index}`
  const attempts = startedAgents(flattenWorkflowView(startNext(startNext(startNext(wideControl(3)))), wideBindings))
  // The run a capacity wake of another agent started, so each agent here keeps the cut it ended with.
  const inputs = createWorkflowAgentInputs({ sessionId: "session", store: asAsyncEventReadSurface(createMemoryStore([])), wake: { capacity: new Set(["earlier"]) }, runningAgents: () => attempts.map(({ agent }) => agent) })
  const [runtimeCut, personCut, unnamed] = ([["runtime", 0], ["person", 1], ["runtime", 2]] as const).map(([by, index]) => {
    const attempt = attempts[index]!
    const input = inputs.open({ attemptId: attempt.attemptId, conversationId: conversation(index) })
    input.initialize(attempt.agent, { end: { reason: "paused", pausedBy: by }, recorded: true }, 25)
    return input
  })
  expect(runtimeCut!.cut?.by).toBe("runtime")

  expect([...inputs.continueCapacity(new Set([conversation(0), conversation(1), "not-opened"]))]).toEqual([conversation(0)])
  expect(runtimeCut!.cut).toBeUndefined()
  expect(runtimeCut!.queue.drainPending()).toMatchObject({ kind: "resume" })
  expect(personCut!.cut?.by).toBe("person")
  expect(personCut!.queue.drainPending()).toBeNull()
  expect(unnamed!.cut?.by).toBe("runtime")
  expect(unnamed!.queue.drainPending()).toBeNull()
  // An agent that runs already continues.
  expect([...inputs.continueCapacity(new Set([conversation(0)]))]).toEqual([conversation(0)])
  expect(runtimeCut!.queue.drainPending()).toBeNull()
})

test("released initialized uncut evidence cannot inherit a pending cut before its success commits", () => {
  const { inputs, open, attempts } = fixture()
  const a = open(0), b = open(1)
  a.release()
  inputs.interrupt(WHOLE_WORKFLOW, "person")
  expect(inputs.evidence(attempts[0]!.attemptId)).toEqual({ cut: undefined })
  expect(b.cut?.by).toBe("person")
})

test("hand-back before either generation exists releases only its pending address coverage", () => {
  const { inputs, open } = fixture()
  inputs.interrupt(WHOLE_WORKFLOW, "person")
  expect(inputs.hasPending(item(2))).toBe(true)
  expect(inputs.resume(item(2))).toEqual([])
  expect(inputs.hasPending(item(2))).toBe(false)
  expect(inputs.stateAt(item(2))).toBe("between_steps")
  expect(open(0).cut?.by).toBe("person")
  expect(open(1).cut).toBeUndefined()
})

test.each(["grouped", "individual"] as const)("a %s hand-back subtracts the same leaves from a whole cut", (kind) => {
  const { inputs, open } = fixture()
  const a = open(0), b = open(1)
  inputs.interrupt(WHOLE_WORKFLOW, "person")
  if (kind === "grouped") inputs.resume({ addressedTo: [...item(1).addressedTo, ...item(2).addressedTo], label: "both" })
  else { inputs.resume(item(1)); inputs.resume(item(2)) }
  expect(a.cut).toBeUndefined()
  expect(b.cut).toBeUndefined()
  expect(inputs.pendingCut(item(1))).toBeUndefined()
  expect(inputs.pendingCut(item(2))).toBeUndefined()
  expect(inputs.pendingCut(WHOLE_WORKFLOW)).toBeUndefined()
  expect(inputs.state).toBe("running")
})
