import type { Activity } from "../../infra/output-blocks.js"
import type { SessionEntryBase } from "./types.js"

/** The one public activity axis: pool state first, live stream phase while the
 *  runner is streaming. The store's two write channels never share a field. */
export function entryActivity(entry: Pick<SessionEntryBase, "runnerState" | "streamPhase">): Activity {
  if (entry.runnerState !== "streaming") return entry.runnerState
  const phase = entry.streamPhase ?? "waiting"
  return phase === "tool_executing" ? "executing_tools" : phase
}
