import { formatElapsed } from "../../../../protocol/client/format.js"
import type { ChildSessionTarget, ModuleChildSession } from "../../../module-seams.js"
import { readPendingTurnEnd } from "../../../session/chat-session-run-evidence.js"
import { parentMayContinue, personCutRefusal, subagentRunCut, type ChildCut } from "../../../session/child-continuation.js"
import { liveChildRun } from "../../../session/live-session-control.js"
import { readSubagentRuns } from "../history/subagent-run-projection.js"
import { subagentContinuationService } from "./continuation-service.js"
import { stopSubagentSession } from "./direct-child-control.js"

/** The latest cut of a subagent that no process runs now. A live run has no
 *  cut: it works. */
async function subagentCut({ sessionId, reader, projectionReader }: ChildSessionTarget): Promise<ChildCut | undefined> {
  if (liveChildRun(reader, sessionId)) return undefined
  const run = (await readSubagentRuns(projectionReader, sessionId)).at(-1)
  if (!run) return undefined
  const cutByInterrupt = run.status === "paused" || run.status === "interrupted"
  const recorded = cutByInterrupt && run.conversationId !== undefined ? await readPendingTurnEnd(projectionReader, run.conversationId) : undefined
  return subagentRunCut(run, recorded)
}

/** A subagent's progress as its parent reads it: its attempt, then the
 *  operations and tokens its card shows. A running child reads its live
 *  counters; a child that does not run reads the figures its runs recorded. */
async function subagentProgress({ sessionId, reader, projectionReader }: ChildSessionTarget): Promise<readonly string[]> {
  const runs = await readSubagentRuns(projectionReader, sessionId)
  const live = liveChildRun(reader, sessionId)?.child.progress()
  const recorded = runs.filter((run) => run.toolUses !== undefined || run.totalTokens !== undefined)
  const figures = live ?? (recorded.length > 0 ? {
    toolUses: recorded.reduce((sum, run) => sum + (run.toolUses ?? 0), 0),
    totalTokens: recorded.reduce((sum, run) => sum + (run.totalTokens ?? 0), 0),
  } : undefined)
  return [[
    `progress: attempt ${Math.max(1, runs.length)}`,
    ...(figures ? [`${figures.toolUses} tool uses`, `${figures.totalTokens} tokens`] : []),
    ...(live ? [`running for ${formatElapsed(Math.max(0, Date.now() - live.startedAtMs))}`] : []),
  ].join(", ")]
}

/** The subagents module's owner of its children: the Stop of a person or of
 *  the parent agent, the parent agent's Resume, and the reads of its cut
 *  and progress. */
export const subagentChildSession: ModuleChildSession = {
  kind: "subagent",
  async stop(input) {
    if (input.session.kind !== "subagent") throw new Error("Subagent Stop requires a subagent session")
    return stopSubagentSession({
      eventStore: input.reader, projectionReader: input.projectionReader, writer: input.writer, projectRoot: input.projectRoot,
      childSessionId: input.sessionId, parentSessionId: input.session.launchedFrom.parentSessionId,
      deliverNotification: input.deliverNotification, by: input.by,
    })
  },
  async resume(input) {
    const cut = await subagentCut(input)
    if (cut && !parentMayContinue(cut)) return { ok: false, error: personCutRefusal(cut) }
    const continuation = input.modules.get(subagentContinuationService)
    if (!continuation) return { ok: false, error: "Subagent execution is unavailable" }
    const result = await continuation.resume(input.sessionId)
    return result.outcome === "ok" ? { ok: true } : { ok: false, error: result.content }
  },
  cut: subagentCut,
  progress: subagentProgress,
}
