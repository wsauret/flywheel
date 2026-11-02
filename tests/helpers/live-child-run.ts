import type { AsyncEventStateReadSurface } from "../../src/infra/event-store-types"
import type { ControlInterruption, TurnInterruption } from "../../src/orchestration/session/conversation/turn-end-record"
import { liveChildRun, registerLiveSessionControl } from "../../src/orchestration/session/live-session-control"
import type { ContinuationLanes } from "../../src/orchestration/session/planned-session-continuation"
import { createBackgroundWorkRegistry } from "../../src/orchestration/agent-runtime/background-work"

/** Registers a subagent run as live in this process, as a dispatch does,
 *  with a control that refuses messages. Returns the unregistration. */
export function registerTestChildRun(store: AsyncEventStateReadSurface, run: {
  readonly sessionId: string
  readonly runId: string
  readonly parentSessionId: string
  readonly parentConversationId: string
  readonly parentToolCallId: string
  readonly stop?: (by: "person" | "agent" | "deletion") => void
  readonly interrupt?: (by: TurnInterruption) => Promise<void>
  readonly settled?: Promise<void>
}): () => void {
  const { sessionId, stop, interrupt, settled, ...binding } = run
  return registerLiveSessionControl(store, {
    sessionId,
    state: async () => "running",
    ...(settled ? { settled } : {}),
    child: { ...binding, modules: async () => undefined, backgroundTasks: createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} }), stop: stop ?? (() => {}), interrupt: interrupt ?? (async () => {}), progress: () => ({ toolUses: 0, totalTokens: 0, startedAtMs: 0 }) },
    deliver: async () => ({ status: "refused", reason: "settled" }),
    notify: async () => false,
  })
}

/** The one Interrupt of a live subagent run, by `by`, as the supervisor's
 *  `interruptSession` makes it: it takes the session's turn in `lanes`. */
export function interruptLiveChild(input: Omit<Parameters<ContinuationLanes["interrupt"]>[0], "sessionId" | "by" | "runs" | "interrupt" | "owner"> & {
  readonly lanes: ContinuationLanes
}, by: ControlInterruption = "person"): (sessionId: string) => Promise<boolean> {
  const { lanes, ...evidence } = input
  return (sessionId) => {
    const control = () => liveChildRun(evidence.reader, sessionId)?.child
    return lanes.interrupt({
      ...evidence, sessionId, by,
      runs: () => control() !== undefined,
      interrupt: async () => {
        const running = control()
        if (!running) return false
        await running.interrupt(by)
        return true
      },
    })
  }
}
