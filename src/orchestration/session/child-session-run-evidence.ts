import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { ChildSessionRow, StoppedBy, SubagentSessionAction } from "../../protocol/app-service-types.js"
import { installedChildSessionHistory } from "./module-session-operations.js"
import type { ChildSessionRun } from "../module-seams.js"
import { readPlannedSessionContinuationAsync } from "./planned-session-continuation.js"
import type { SessionLifecycleState } from "./types.js"

/** What a child's current run admits, read from the run projection: the one
 *  source the child's row, its parent's card, the replacement blockers, and
 *  resume admission all read (ARCH-SUBSTRATE-001, ARCH-PROTOCOL-050). */
export interface ChildSessionRunEvidence {
  /** The child's current run; absent for a child that has recorded none. */
  readonly run?: Pick<ChildSessionRun, "status" | "interruptionReason">
  /** Whether a planned continuation row authorizes the run to continue. */
  readonly continuationAuthorized: boolean
}

export async function readChildSessionRunEvidence(reader: AsyncEventStateReadSurface, sessionId: string): Promise<ChildSessionRunEvidence> {
  const history = installedChildSessionHistory()
  const run = (await history.readRuns(reader, sessionId)).at(-1)
  return {
    ...(run ? { run: { status: run.status, ...(run.interruptionReason ? { interruptionReason: run.interruptionReason } : {}) } } : {}),
    continuationAuthorized: await readPlannedSessionContinuationAsync(reader, sessionId) !== null,
  }
}

/** A running child admits Interrupt and Stop. Every non-completed inactive
 *  child admits explicit Resume. An interrupted attempt still admits Stop
 *  because its parent call has no result. Planned continuation ownership
 *  remains separate from explicit Resume admission. */
export function subagentSessionActions(lifecycleState: SessionLifecycleState, evidence?: ChildSessionRunEvidence, continuationOwed = false): readonly SubagentSessionAction[] {
  const run = evidence?.run
  if (run?.status === "created" && lifecycleState === "active") {
    return ["session.send", "subagent.interrupt", "background.terminate", "session.delete"]
  }
  const waiting = run?.status === "paused" || (run?.status === "interrupted" && run.interruptionReason === "runtime_restarted")
  const resumable = waiting || (run !== undefined && run.status !== "completed" && lifecycleState === "inactive")
  return [
    ...(continuationOwed ? ["subagent.interrupt" as const] : []),
    ...(resumable && (waiting || evidence?.continuationAuthorized) ? ["session.send" as const] : []),
    ...(resumable ? ["subagent.resume" as const] : []),
    ...(waiting ? ["background.terminate" as const] : []),
    "session.delete",
  ]
}

/** Who stopped a subagent's run, from the run's own terminal status. */
export function subagentStoppedBy(evidence: ChildSessionRunEvidence | undefined): StoppedBy | undefined {
  const status = evidence?.run?.status
  return status === "stopped" ? "person" : status === "cancelled" ? "agent" : undefined
}

/** Projects the ledger's terminal outcome without conflating it with action admission. */
export function subagentRunOutcome(evidence: ChildSessionRunEvidence | undefined): Pick<Extract<ChildSessionRow, { kind: "subagent" }>, "runOutcome"> {
  const status = evidence?.run?.status
  return status === undefined || status === "created" || status === "paused" || status === "interrupted" ? {} : { runOutcome: status }
}
