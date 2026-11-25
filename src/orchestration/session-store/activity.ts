import type { Activity } from "../../infra/substrate/events/output-blocks.js"
import type { SessionEntryBase } from "./types.js"

/** The one public activity axis: pool state first, live stream phase while the
 *  runner is streaming. The store's two write channels never share a field. */
export function entryActivity(entry: Pick<SessionEntryBase, "runnerState" | "streamPhase">): Activity {
  if (entry.runnerState !== "streaming") return entry.runnerState
  const phase = entry.streamPhase ?? "waiting"
  return phase === "tool_executing" ? "executing_tools" : phase
}

/** Whether the session's turn is in flight: it runs, or it is parked on a
 *  question or on background work. A parked turn is still the agent's turn
 *  (PI-INTERACTION-013), so it is not at rest although its runner shows no activity. */
export function turnInFlight(entry: Pick<SessionEntryBase, "runnerState" | "waitingOnBackgroundWork">): boolean {
  return entry.runnerState === "streaming" || entry.runnerState === "awaiting_user" || entry.waitingOnBackgroundWork
}

/** Whether an agent runs its workflow card's clock: its turn is in flight
 *  and has streamed. This is the one state of an agent its card reads. */
export function runsWorkflowClock(entry: Pick<SessionEntryBase, "runnerState" | "waitingOnBackgroundWork" | "streamingStartedAt">): boolean {
  return turnInFlight(entry) && entry.streamingStartedAt !== null
}
