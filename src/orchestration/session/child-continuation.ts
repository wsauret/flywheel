import type { PausedBy } from "../../infra/output-blocks.js"
import type { ChildRunStatus, StoppedBy } from "../../protocol/app-service-types.js"
import type { TurnEnd, TurnInterruption } from "./conversation/turn-end-record.js"
import type { WorkflowAgentTurnEnd } from "./chat-session-run-evidence.js"
import { WHOLE_WORKFLOW, type WorkflowDeliveryAddress } from "./conversation/addressed-workflow-messages.js"
import { addressReachesAgent } from "../../workflows/context-bundle/context-facts.js"

/** The latest cut of a child's work, as its parent's continuation reads it:
 *  - `interrupt`: a person, the parent agent, or the runtime interrupted it.
 *  - `exit`: the process that ran it exited unexpectedly.
 *  - `stop`: a person or the parent agent stopped its attempt.
 *  - `attempt`: its attempt ended on its own without completing, as a failed
 *    or partial run does. */
export type ChildCut =
  | { readonly kind: "interrupt"; readonly by: PausedBy }
  | { readonly kind: "exit" }
  | { readonly kind: "stop"; readonly by: StoppedBy }
  | { readonly kind: "attempt" }

/** The one admission of a parent agent's continuation of its own child,
 *  which decides both its Resume and whether its message hands the child
 *  back: the parent may continue any cut that a person did not make. The
 *  person's latest decision wins (ARCH-SESSIONS-018, ARCH-SESSIONS-019), so work that a person
 *  interrupted or stopped continues only when a person continues it. A
 *  person's own Resume and message do not read this: they continue every
 *  cut that admits a continuation. */
export function parentMayContinue(cut: ChildCut): boolean {
  switch (cut.kind) {
    case "exit":
    case "attempt": return true
    case "interrupt":
    case "stop": return cut.by !== "person"
  }
}

/** Why the parent agent may not continue its child: a person made the
 *  child's latest cut, and the person's latest decision wins. */
export function personCutRefusal(cut: ChildCut): string {
  return cut.kind === "stop"
    ? "A person stopped this child, so only a person can resume it."
    : "A person interrupted this child, so only a person can continue it, with Resume or a message."
}

/** The control authority of an interrupter: a person, then the parent
 *  agent, then the runtime and every other cause. A lower rank wins. */
export const interruptRank = (by: TurnInterruption): number => by === "person" ? 0 : by === "agent" ? 1 : 2

/** Selects one cut with person-first control authority; equal actors retain their original evidence. */
export function strongestInterrupt<T extends { readonly by: TurnInterruption }>(cuts: readonly (T | undefined)[]): T | undefined {
  return cuts.filter((cut): cut is T => cut !== undefined).toSorted((a, b) => interruptRank(a.by) - interruptRank(b.by))[0]
}

/** The strongest cut among reached attempts: person, parent, runtime, then
 *  unexpected exit. Sibling evidence outside the address grants no authority. */
export function workflowStepCut(agents: readonly WorkflowAgentTurnEnd[], address: WorkflowDeliveryAddress = WHOLE_WORKFLOW): ChildCut | undefined {
  const ends = agents.filter(({ agent }) => addressReachesAgent(address.addressedTo, agent)).map(({ turnEnd }) => turnEnd?.end)
  for (const by of ["person", "agent", "runtime"] as const) {
    if (ends.some((end) => end?.reason === "paused" && end.pausedBy === by)) return { kind: "interrupt", by }
  }
  return ends.some((end) => end?.reason === "crash") ? { kind: "exit" } : undefined
}

/** The cut that a subagent's latest run ended with, or nothing for a run
 *  that runs or completed. A paused or interrupted run names its
 *  interrupter from the newest turn-end record of its conversation
 *  (`readPendingTurnEnd`), the one authority for who interrupted it. A
 *  paused run's own `pausedBy` stands only for a conversation that holds no
 *  such record. An interrupted run with no such record exited unexpectedly. */
export function subagentRunCut(run: { readonly status: ChildRunStatus; readonly pausedBy?: PausedBy }, recorded: TurnEnd | undefined): ChildCut | undefined {
  const recordedBy = recorded?.reason === "paused" ? recorded.pausedBy : undefined
  switch (run.status) {
    case "paused": {
      const by = recordedBy ?? run.pausedBy
      return by ? { kind: "interrupt", by } : { kind: "exit" }
    }
    case "interrupted": return recordedBy ? { kind: "interrupt", by: recordedBy } : { kind: "exit" }
    case "stopped": return { kind: "stop", by: "person" }
    case "cancelled": return { kind: "stop", by: "agent" }
    case "failed":
    case "partial": return { kind: "attempt" }
    case "created":
    case "completed": return undefined
  }
}
