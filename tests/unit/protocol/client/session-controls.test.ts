import { describe, expect, test } from "bun:test"
import { RpcClientError } from "effect/rpc"
import { Socket } from "effect/socket"
import type { FrontendMutation, MutationResult } from "../../../../src/protocol/app-service-types.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"
import {
  createAdmissionEdges,
  agentViewControl,
  dispatchInterrupt,
  interruptMutationType,
  isInterruptible,
  offeredSessionControls,
  replyWaitLabel,
  resumeMutationType,
  resumeMutation,
  runStatusLabel,
  sessionControls,
  stopMutation,
  stoppedLabel,
  workflowCardControls,
  workflowStateLabel,
  workflowParked,
  workflowResumeTitle,
} from "../../../../src/protocol/client/session-controls.js"
import { interruptedLabel, RESUMED_LABEL, UNEXPECTED_EXIT_LABEL } from "../../../../src/infra/output/run-labels.js"

describe("session controls", () => {
  test("agent controls require their address and their own admitted action", () => {
    const row = { workflowId: "w", admittedActions: ["workflow.interrupt", "workflow.resume"] as const }
    const address = { target: "json", label: "lane json", placeholder: "Message lane json" }
    expect(agentViewControl(row, { state: "running" }, address, true)).toEqual({ kind: "interrupt", targets: ["json"] })
    expect(agentViewControl(row, { state: "parked" }, address, true)).toEqual({ kind: "resume", targets: ["json"] })
    expect(agentViewControl(row, { state: "running" }, address, false)).toEqual({ kind: "resume", targets: ["json"] })
    expect(agentViewControl({ workflowId: "w", admittedActions: ["workflow.interrupt"] }, { state: "parked" }, address, true)).toBeNull()
    expect(agentViewControl(row, { state: "done" }, address, true)).toBeNull()
    expect(agentViewControl(row, { state: "running" }, undefined, true)).toBeNull()
    expect(agentViewControl(row, { state: "running" }, { ...address, target: "" }, true)).toBeNull()
    expect(resumeMutation({ workflowId: "w" }, ["json"])).toEqual({ type: "workflow.resume", workflowId: "w", targets: ["json"] })
    expect(resumeMutation({ workflowId: "w" })).toEqual({ type: "workflow.resume", workflowId: "w" })
    expect(resumeMutation({ id: "s", kind: "subagent" }, ["json"])).toEqual({ type: "subagent.resume", sessionId: "s" })
    const parked = { attemptId: "json", sessionId: "member-1", operations: 1, interruptedAt: 1000, duration: 0, revision: 0 }
    const running = { attemptId: "yaml", sessionId: "member-2", operations: 1, duration: 0, revision: 0 }
    // A settled agent that no runner holds counts no operations live, and holds nothing.
    const settled = { attemptId: "toml", sessionId: "member-3", duration: 4000, revision: 0 }
    expect(workflowParked([parked, running])).toBe(false)
    expect(workflowParked([parked, settled])).toBe(true)
    expect(workflowParked([settled])).toBe(false)
    // Saved progress that cannot run holds the run, as an interrupt does.
    expect(workflowParked([], { workflowId: "w", admittedActions: ["workflow.restart", "workflow.stop"] })).toBe(true)
    expect(workflowStateLabel("running", undefined, true)).toBe("interrupted")
    expect(workflowStateLabel("running", { stoppedBy: "person" }, true)).toBe("Stopped")
  })
  test("one Interrupt and one Resume for every kind, read from the row's admitted actions", () => {
    expect(sessionControls({ kind: "chat", admittedActions: ["chat.interrupt", "session.delete"] })).toEqual({ message: true, interrupt: true, resume: false, restart: false, stop: false })
    expect(sessionControls({ kind: "chat", admittedActions: ["chat.interrupt", "chat.resume", "session.delete"] })).toEqual({ message: true, interrupt: true, resume: true, restart: false, stop: false })
    expect(sessionControls({ workflowId: "w", admittedActions: ["workflow.interrupt", "workflow.stop", "workflow.delete"] })).toEqual({ message: false, interrupt: true, resume: false, restart: false, stop: true })
    expect(sessionControls({ workflowId: "w", admittedActions: ["workflow.resume", "workflow.delete"] })).toEqual({ message: false, interrupt: false, resume: true, restart: false, stop: false })
    expect(sessionControls({ workflowId: "w", admittedActions: ["workflow.send", "workflow.resume", "workflow.delete"] })).toEqual({ message: true, interrupt: false, resume: true, restart: false, stop: false })
    expect(sessionControls({ kind: "subagent", admittedActions: ["session.send", "subagent.interrupt", "background.terminate", "session.delete"] })).toEqual({ message: true, interrupt: true, resume: false, restart: false, stop: true })
    expect(sessionControls({ kind: "subagent", admittedActions: ["session.send", "subagent.resume", "session.delete"] })).toEqual({ message: true, interrupt: false, resume: true, restart: false, stop: false })
    expect(sessionControls({ kind: "subagent", admittedActions: ["session.delete"] })).toEqual({ message: false, interrupt: false, resume: false, restart: false, stop: false })
    expect(sessionControls({ workflowId: "w", admittedActions: ["workflow.restart", "workflow.delete"] })).toEqual({ message: false, interrupt: false, resume: false, restart: true, stop: false })
  })

  test("a chat takes a message even listed without evidence, and no row admits nothing", () => {
    expect(sessionControls({ kind: "chat" })).toEqual({ message: true, interrupt: false, resume: false, restart: false, stop: false })
    expect(sessionControls(undefined)).toEqual({ message: false, interrupt: false, resume: false, restart: false, stop: false })
  })

  test("a park on the parent names the parent, and other reply waits do not include session titles", () => {
    const parent = { sessionId: "parent", name: "Design chat" }
    const sibling = { sessionId: "sibling", name: "Sub-agent ended and was not resumable" }
    const parked = (replyWaits: readonly { sessionId: string; name: string }[]) => ({ waitingOnBackgroundWork: true, replyWaits })
    expect(replyWaitLabel(parked([parent]), "parent")).toBe("Waiting on parent")
    expect(replyWaitLabel(parked([sibling]), "parent")).toBe("Waiting for message response")
    expect(replyWaitLabel(parked([sibling, parent]), "parent")).toBe("Waiting on parent")
    expect(replyWaitLabel(parked([{ sessionId: "child", name: "Explorer" }]), undefined)).toBe("Waiting for message response")
    expect(replyWaitLabel(parked([]), "parent")).toBeUndefined()
    // A session that runs again shows its own activity, not the wait.
    expect(replyWaitLabel({ waitingOnBackgroundWork: false, replyWaits: [parent] }, "parent")).toBeUndefined()
    expect(replyWaitLabel(undefined, "parent")).toBeUndefined()
  })

  test("the row's kind picks the mutation", () => {
    expect(interruptMutationType("chat")).toBe("chat.interrupt")
    expect(interruptMutationType("workflow-agent")).toBe("chat.interrupt")
    expect(interruptMutationType("subagent")).toBe("subagent.interrupt")
    expect(resumeMutationType("chat")).toBe("chat.resume")
    expect(resumeMutationType("workflow-agent")).toBe("chat.resume")
    expect(resumeMutationType("subagent")).toBe("subagent.resume")
  })

  test("Stop terminates the parent's tool call, and only a row that admits it and names the call has one", () => {
    const running = { kind: "subagent" as const, admittedActions: ["subagent.interrupt", "background.terminate", "session.delete"] as const, parentSessionId: "parent", parentToolUseId: "call-1" }
    expect(stopMutation(running)).toEqual({ type: "background.terminate", sessionId: "parent", toolUseId: "call-1" })
    expect(stopMutation({ ...running, admittedActions: ["subagent.resume", "session.delete"] })).toBeUndefined()
    expect(stopMutation({ kind: "subagent", admittedActions: ["subagent.interrupt", "background.terminate"], parentSessionId: "parent" })).toBeUndefined()
    expect(stopMutation(undefined)).toBeUndefined()
  })

  test("offers Interrupt only while something runs and Resume only while nothing does, never both", () => {
    const both = { kind: "chat" as const, admittedActions: ["chat.interrupt", "chat.resume", "session.delete"] as const }
    expect(offeredSessionControls(both, true)).toEqual({ primary: "interrupt", stop: false })
    expect(offeredSessionControls(both, false)).toEqual({ primary: "resume", stop: false })
    // An idle chat, or a workflow parked between steps, has nothing to interrupt.
    expect(offeredSessionControls({ kind: "chat", admittedActions: ["chat.interrupt", "session.delete"] }, false)).toEqual({ primary: null, stop: false })
    expect(offeredSessionControls({ kind: "workflow-agent", admittedActions: ["chat.interrupt", "session.delete"] }, false)).toEqual({ primary: null, stop: false })
    // A listed row without resume evidence offers neither while idle, rather than a wrong one.
    expect(offeredSessionControls({ kind: "chat" }, false)).toEqual({ primary: null, stop: false })
    expect(offeredSessionControls({ kind: "workflow-agent", admittedActions: ["chat.resume"] }, true)).toEqual({ primary: null, stop: false })
    expect(offeredSessionControls(undefined, true)).toEqual({ primary: null, stop: false })
    expect(offeredSessionControls({ kind: "subagent", admittedActions: ["subagent.interrupt", "background.terminate"], parentSessionId: "p", parentToolUseId: "t" }, false)).toEqual({ primary: null, stop: true })
  })

  test("a workflow card's header offers Resume while an interrupt parks its run and Interrupt otherwise, with Stop while its call runs", () => {
    // The detail row admits both while the interrupt's evidence is durable and the runner still holds the run.
    const both = { workflowId: "w", admittedActions: ["workflow.interrupt", "workflow.resume", "workflow.delete"] as const }
    expect(workflowCardControls(both, true, false)).toEqual({ primary: "interrupt", stop: true })
    expect(workflowCardControls(both, true, true)).toEqual({ primary: "resume", stop: true })
    expect(workflowCardControls({ workflowId: "w", admittedActions: ["workflow.interrupt", "workflow.delete"] }, true, true)).toEqual({ stop: true })
    expect(workflowCardControls({ workflowId: "w", admittedActions: ["workflow.resume", "workflow.delete"] }, false, false)).toEqual({ primary: "resume", stop: false })
    expect(workflowCardControls(undefined, false, false)).toEqual({ stop: false })
    // Saved progress that cannot run offers Restart in place of Resume.
    expect(workflowCardControls({ workflowId: "w", admittedActions: ["workflow.restart", "workflow.delete"] }, false, true)).toEqual({ primary: "restart", stop: false })
  })

  test("says who interrupted a turn or run, and names the other ends in the same words everywhere", () => {
    expect(interruptedLabel("person")).toBe("Interrupted")
    expect(interruptedLabel("runtime")).toBe("Interrupted by the runtime")
    expect(UNEXPECTED_EXIT_LABEL).toBe("Interrupted by an unexpected exit")
    expect(RESUMED_LABEL).toBe("Resumed")
    expect(stoppedLabel("person")).toBe("Stopped")
    expect(stoppedLabel("agent")).toBe("Canceled")
  })

  test("names a child card's run state, and nothing for a state its header does not name", () => {
    expect(runStatusLabel({ status: "interrupted" })).toBe("Interrupted")
    expect(runStatusLabel({ status: "paused", pausedBy: "runtime" })).toBe("Interrupted by the runtime")
    expect(runStatusLabel({ status: "stopped" })).toBe("Stopped")
    expect(runStatusLabel({ status: "cancelled" })).toBe("Canceled")
    expect(runStatusLabel({ status: "partial" })).toBe("Partial")
    expect(runStatusLabel({ status: "active" })).toBeUndefined()
  })

  test("names a workflow's ended or interrupted phase, a Stop over any saved state, and nothing while it runs", () => {
    expect(workflowStateLabel("paused", undefined)).toBe("interrupted")
    expect(workflowStateLabel("completed", undefined)).toBe("completed")
    expect(workflowStateLabel("failed", undefined)).toBe("failed")
    expect(workflowStateLabel("running", undefined)).toBeUndefined()
    expect(workflowStateLabel("idle", undefined)).toBeUndefined()
    expect(workflowStateLabel(undefined, undefined)).toBeUndefined()
    expect(workflowStateLabel("paused", { stoppedBy: "person" })).toBe("Stopped")
    expect(workflowStateLabel("completed", { stoppedBy: "agent" })).toBe("Canceled")
    const drift = { workflowDefinitionId: "implement", changes: [{ component: "graph" as const }] }
    expect(workflowStateLabel("paused", { definitionDrift: drift })).toBe("cannot continue")
    expect(workflowStateLabel("paused", { stoppedBy: "person", definitionDrift: drift })).toBe("Stopped")
    // A planned replacement's pause runs on in its successor, unless an agent's own interrupt holds it.
    expect(workflowStateLabel("paused", { continuationOwed: true })).toBeUndefined()
    expect(workflowStateLabel("paused", { continuationOwed: true }, true)).toBe("interrupted")
  })

  test("says that the Resume of a failed workflow keeps only the finished work that reads no failed agent's output", () => {
    expect(workflowResumeTitle("failed")).toBe("Run the failed agents again, with no new message. Every finished agent that does not read a failed agent's output keeps its result.")
    expect(workflowResumeTitle("paused")).toBe("Continue this workflow from its current phase, with no new message")
  })

  test("a running turn and a park on background work are interruptible; an idle or interrupted park is not", () => {
    expect(isInterruptible({ activity: "generating", waitingOnBackgroundWork: false })).toBe(true)
    expect(isInterruptible({ activity: "idle", waitingOnBackgroundWork: true })).toBe(true)
    expect(isInterruptible({ activity: "idle", waitingOnBackgroundWork: false })).toBe(false)
    expect(isInterruptible(undefined)).toBe(false)
  })

  test("admitted actions go stale when a session crosses the interruptible line or its status goes away, never on its first status", () => {
    const edges = createAdmissionEdges()
    const waiting = { activity: "idle", waitingOnBackgroundWork: true } as const
    const settled = { activity: "idle", waitingOnBackgroundWork: false } as const
    expect(edges.observe("s", waiting)).toBe(false)
    expect(edges.observe("s", { activity: "generating", waitingOnBackgroundWork: false })).toBe(false)
    expect(edges.observe("s", settled)).toBe(true)
    expect(edges.observe("s", settled)).toBe(false)
    expect(edges.observe("s", undefined)).toBe(true)
    expect(edges.observe("s", undefined)).toBe(false)
    edges.observe("t", waiting)
    edges.forget("t")
    expect(edges.observe("t", settled)).toBe(false)
  })
})

describe("dispatchInterrupt", () => {
  type SessionInterrupt = Extract<FrontendMutation, { readonly type: "chat.interrupt" | "subagent.interrupt" }>
  type WorkflowInterrupt = Extract<FrontendMutation, { readonly type: "workflow.interrupt" }>
  /** A client that answers an interrupt with the answer for its target, which
   *  may throw: a mutation result for a session, or an interrupt outcome for a
   *  workflow. */
  function client(answers: { readonly session?: () => MutationResult<SessionInterrupt>; readonly workflow?: () => MutationResult<WorkflowInterrupt> }) {
    const dispatched: FrontendMutation[] = []
    const recorded = <Result>(answer: () => Result) => async (mutation: FrontendMutation) => { dispatched.push(mutation); return answer() }
    return {
      dispatched,
      dispatch: runtimeDispatch({
        ...(answers.session && { "chat.interrupt": recorded(answers.session), "subagent.interrupt": recorded(answers.session) }),
        ...(answers.workflow && { "workflow.interrupt": recorded(answers.workflow) }),
      }),
    }
  }
  const cleanClose = () => new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1000 }) })

  test("answers nothing when the interrupt is taken, or when the runtime's clean close lost it", async () => {
    const taken = client({ session: () => ({ ok: true }) })
    expect(await dispatchInterrupt(taken, { id: "c1", kind: "chat" })).toBeUndefined()
    expect(taken.dispatched).toEqual([{ type: "chat.interrupt", sessionId: "c1" }])
    const targeted = client({ workflow: () => ({ kind: "interrupt", interrupted: true }) })
    await dispatchInterrupt(targeted, { workflowId: "w1" }, ["json"])
    expect(targeted.dispatched).toEqual([{ type: "workflow.interrupt", workflowId: "w1", targets: ["json"] }])
    expect(await dispatchInterrupt(client({ workflow: () => ({ kind: "interrupt", interrupted: true }) }), { workflowId: "w1" })).toBeUndefined()
    const lost = client({ session: () => { throw cleanClose() } })
    expect(await dispatchInterrupt(lost, { id: "s1", kind: "subagent" })).toBeUndefined()
    expect(lost.dispatched).toEqual([{ type: "subagent.interrupt", sessionId: "s1" }])
  })

  test("answers the runtime's refusal in its own words, and any other failure, without rejecting", async () => {
    expect(await dispatchInterrupt(client({ session: () => ({ ok: false, error: "Not running" }) }), { id: "c1", kind: "chat" })).toEqual({ reason: "Not running", variant: "error" })
    expect(await dispatchInterrupt(client({ workflow: () => ({ kind: "interrupt", interrupted: false }) }), { workflowId: "w1" })).toEqual({ reason: "nothing is running", variant: "warning" })
    expect(await dispatchInterrupt(client({ session: () => { throw new Error("offline") } }), { id: "c1", kind: "chat" })).toEqual({ reason: "offline", variant: "error" })
    const brokenClose = new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1006 }) })
    expect(await dispatchInterrupt(client({ session: () => { throw brokenClose } }), { id: "c1", kind: "chat" })).toMatchObject({ variant: "error" })
  })
})
