import { errorMessage } from "../../infra/error-message.js"
import { PERSON_STOP_INSTRUCTION } from "../../infra/tool-outcome.js"
import type { BackgroundKillSource, BackgroundWorkResult } from "./background-work.js"

/** Normalizes task rejection and an owner's Stop into the recorded outcome. */
export function backgroundWorkOutcome(
  task: { readonly description: string; readonly stallFired: boolean; readonly stallTimeoutMs?: number; readonly killedBy?: BackgroundKillSource },
  outcome: { ok: true; result: BackgroundWorkResult } | { ok: false; err: unknown },
): BackgroundWorkResult {
  const result: BackgroundWorkResult = outcome.ok ? outcome.result : {
    status: "failed",
    content: task.stallFired
      ? `Task '${task.description}' was killed by the stall watchdog after ${(task.stallTimeoutMs ?? 0) / 1000}s.`
      : `Task '${task.description}' failed: ${errorMessage(outcome.err)}`,
  }
  if (result.status === "stopped" || result.status === "cancelled") return result
  if (task.killedBy === "user") return {
    ...result, status: "stopped",
    content: `A person stopped this work with Stop. It did not fail or end on its own. ${PERSON_STOP_INSTRUCTION}\n${result.content}`,
  }
  return task.killedBy === "agent" ? { ...result, status: "cancelled" } : result
}
