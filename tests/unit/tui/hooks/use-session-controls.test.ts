import { describe, expect, test } from "bun:test"
import { RpcClientError } from "effect/rpc"
import { Socket } from "effect/socket"
import type { FrontendMutation, MutationResult, SessionRow } from "../../../../src/protocol/app-service-types.js"
import type { StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { useSessionControls, type ControlledSessionRow } from "../../../../src/tui/hooks/use-session-controls.js"
import { offeredSessionControls } from "../../../../src/protocol/client/session-controls.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"
import { statusView } from "../../../helpers/runtime-views.js"

/** The commands a session control dispatches. */
type SessionControl = Extract<FrontendMutation, { readonly type: "chat.interrupt" | "subagent.interrupt" | "chat.resume" | "subagent.resume" | "background.terminate" }>

function row(kind: SessionRow["kind"], admittedActions: SessionRow["admittedActions"], parent?: { sessionId: string; toolUseId: string }): ControlledSessionRow {
  return { id: `${kind}-1`, kind, admittedActions, ...(parent ? { parentSessionId: parent.sessionId, parentToolUseId: parent.toolUseId } : {}) }
}

function harness(current: ControlledSessionRow | null, answer: (command: SessionControl) => MutationResult<SessionControl> = () => ({ ok: true }), activity: StatusView["activity"] = "idle", waitingOnBackgroundWork = false) {
  const dispatched: FrontendMutation[] = []
  const toasts: string[] = []
  const answered = async (command: SessionControl) => { dispatched.push(command); return answer(command) }
  const hook = useSessionControls({
    row: () => current,
    status: () => ({ ...statusView(activity), waitingOnBackgroundWork }),
    appService: { dispatch: runtimeDispatch({ "chat.interrupt": answered, "subagent.interrupt": answered, "chat.resume": answered, "subagent.resume": answered, "background.terminate": answered }) },
    showToast: ({ message }) => { toasts.push(message) },
  })
  return { hook, dispatched, toasts }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("offered session controls", () => {
  test("offers Resume or Interrupt, never both: the live status picks when the row admits both", () => {
    const both = row("chat", ["chat.interrupt", "chat.resume", "session.delete"])
    expect(offeredSessionControls(both, false)).toEqual({ primary: "resume", stop: false })
    expect(offeredSessionControls(both, true)).toEqual({ primary: "interrupt", stop: false })
    // Nothing runs, so nothing is offered to interrupt.
    expect(offeredSessionControls(row("workflow-agent", ["chat.interrupt"]), false)).toEqual({ primary: null, stop: false })
    expect(offeredSessionControls(row("workflow-agent", ["chat.resume"]), true)).toEqual({ primary: null, stop: false })
    expect(offeredSessionControls(null, false)).toEqual({ primary: null, stop: false })
  })

  test("offers Stop only when the row admits it and names the parent's tool call", () => {
    const parent = { sessionId: "parent-1", toolUseId: "tool-1" }
    expect(offeredSessionControls(row("subagent", ["subagent.interrupt", "background.terminate"], parent), true).stop).toBe(true)
    expect(offeredSessionControls(row("subagent", ["subagent.interrupt", "background.terminate"]), true).stop).toBe(false)
    expect(offeredSessionControls(row("workflow-agent", ["chat.interrupt"], parent), true).stop).toBe(false)
  })
})

describe("session controls hook", () => {
  test("offers Interrupt while the turn waits on background work, and Resume once the interrupt settles it", async () => {
    const both = row("chat", ["chat.interrupt", "chat.resume", "session.delete"])
    const waiting = harness(both, undefined, "idle", true)
    expect(waiting.hook.offered()).toEqual({ primary: "interrupt", stop: false })
    waiting.hook.interrupt()
    await settle()
    expect(waiting.dispatched).toEqual([{ type: "chat.interrupt", sessionId: "chat-1" }])
    expect(harness(both, undefined, "idle", false).hook.offered()).toEqual({ primary: "resume", stop: false })
  })

  test("dispatches the interrupt and resume the foreground row's kind answers to", async () => {
    const chat = harness(row("chat", ["chat.interrupt", "session.delete"]), undefined, "generating")
    expect(chat.hook.offered()).toEqual({ primary: "interrupt", stop: false })
    chat.hook.interrupt()
    await settle()
    expect(chat.dispatched).toEqual([{ type: "chat.interrupt", sessionId: "chat-1" }])

    const workflow = harness(row("workflow-agent", ["chat.resume", "session.delete"]))
    expect(workflow.hook.offered()).toEqual({ primary: "resume", stop: false })
    workflow.hook.resume()
    await settle()
    expect(workflow.dispatched).toEqual([{ type: "chat.resume", sessionId: "workflow-agent-1" }])

    const child = harness(row("subagent", ["subagent.interrupt", "session.delete"]), undefined, "generating")
    child.hook.interrupt()
    await settle()
    expect(child.dispatched).toEqual([{ type: "subagent.interrupt", sessionId: "subagent-1" }])
  })

  test("stops through the parent's tool call, never the session itself", async () => {
    const workflow = harness(row("subagent", ["subagent.interrupt", "background.terminate"], { sessionId: "parent-1", toolUseId: "tool-1" }), undefined, "generating")
    expect(workflow.hook.offered()).toEqual({ primary: "interrupt", stop: true })
    workflow.hook.stop()
    await settle()
    expect(workflow.dispatched).toEqual([{ type: "background.terminate", sessionId: "parent-1", toolUseId: "tool-1" }])
  })

  test("shows the runtime's refusal in its own words for resume and member interrupt", async () => {
    const chat = harness(row("chat", ["chat.resume", "session.delete"]), () => ({ ok: false, error: "Nothing to resume" }))
    chat.hook.resume()
    await settle()
    expect(chat.toasts).toEqual(["Resume failed: Nothing to resume"])

    const workflow = harness(row("workflow-agent", ["chat.interrupt", "session.delete"]), () => ({ ok: false, error: "nothing is running" }))
    workflow.hook.interrupt()
    await settle()
    expect(workflow.toasts).toEqual(["Interrupt failed: nothing is running"])

    // A refusal with a reason, such as a runtime that is shutting down, shows that reason.
    const closing = harness(row("workflow-agent", ["chat.interrupt", "session.delete"]), () => ({ ok: false, error: "Flywheel is shutting down" }))
    closing.hook.interrupt()
    await settle()
    expect(closing.toasts).toEqual(["Interrupt failed: Flywheel is shutting down"])
  })

  test("shows nothing for an interrupt the runtime's clean close lost, and reports one that failed", async () => {
    const lost = harness(row("chat", ["chat.interrupt", "session.delete"]), () => { throw new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1000 }) }) }, "generating")
    lost.hook.interrupt()
    await settle()
    expect(lost.dispatched).toEqual([{ type: "chat.interrupt", sessionId: "chat-1" }])
    expect(lost.toasts).toEqual([])

    const failed = harness(row("workflow-agent", ["chat.interrupt", "session.delete"]), () => { throw new Error("offline") }, "generating")
    failed.hook.interrupt()
    await settle()
    expect(failed.toasts).toEqual(["Interrupt failed: offline"])
  })

  test("does nothing with no foreground row", async () => {
    const none = harness(null)
    none.hook.interrupt()
    none.hook.resume()
    none.hook.stop()
    await settle()
    expect(none.dispatched).toEqual([])
    expect(none.hook.offered()).toEqual({ primary: null, stop: false })
  })
})
