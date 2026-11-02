import { CorruptEventRowError, type AsyncEventStateReadSurface } from "../../../../infra/event-store-types.js"
import { Log } from "../../../../infra/log.js"
import { createReadQueue } from "../../../../infra/read-queue.js"
import { memoizeSuccess } from "../../../../infra/success-memo.js"
import { formatAgentFailureDisplay } from "../../../../infra/output/output-formatter.js"
import { agentResultSummary } from "../../../../infra/output/structured-event-tool-results.js"
import type { ToolHistorySummary, SessionToolSummaryReader } from "../../../module-seams.js"
import { readChatTurnEnd } from "../../../session/chat-session-run-evidence.js"
import { isVisibleTurnEnd } from "../../../session/conversation/turn-end-record.js"
import { createSubagentRunsByToolUseIdCursorReader, type SessionTotals, type SubagentRunsCatchUp } from "./subagent-history.js"
import type { SubagentRunEntry } from "./subagent-run-types.js"
import { createChildMeasureReader, type ChildMeasure } from "./child-measures.js"

const log = Log.create({ service: "subagent-tool-summary" })

/** Read retained child facts independently of live capability selection. The cursor
 * owns incremental folding; summaries retain identity until their source changes.
 * A replay reads only the run facts and the conversation entries committed
 * since the last one, and summarizes only the calls they change; `measure`
 * advances the held fold of the history of each child whose card a reader
 * asks about. */
export function createSubagentToolSummaryReader(reader: AsyncEventStateReadSurface, sessionId: string): SessionToolSummaryReader {
  const runs = createSubagentRunsByToolUseIdCursorReader(reader, sessionId)
  const summaries = new Map<string, ToolHistorySummary>()
  /** The run each published summary states, which its measurement reads. */
  const summarizedRuns = new WeakMap<ToolHistorySummary, SubagentRunEntry>()
  const measurements = new WeakMap<ToolHistorySummary, ToolHistorySummary>()
  const histories = createChildMeasureReader(reader)
  const warnedUnreadableRuns = new Set<string>()
  /** The paused calls whose card states each conversation's last turn end, by conversation aggregate id. */
  const pausedToolUseIdsByConversation = new Map<string, Set<string>>()
  const pausedConversationByToolUseId = new Map<string, string>()
  const attemptsByToolUseId = new Map<string, CallAttempts>()
  /** The runs of each call that changed since its card last stated them. A
   *  card restates only those, so a call resumed again and again costs the
   *  same for its newest attempt as for its first. */
  const staleRunIdsByToolUseId = new Map<string, Set<string>>()
  let position = 0
  // The store's head when the last catch-up ran: one subagent card per
  // transcript block asks again, and an unmoved head has nothing new to read.
  let readThrough = -1
  // A transcript refresh asks again while a slow read runs; the refreshes
  // that wait share the next catch-up, so a burst reads the children once more.
  return { replay: createReadQueue(replay).read, dispose: histories.dispose }

  async function measure(summary: ToolHistorySummary): Promise<ToolHistorySummary> {
    const run = summarizedRuns.get(summary)
    const childSessionId = run?.childSessionId
    if (!run || !childSessionId) return summary
    return memoizeSuccess(measurements, summary, async () => measureRun(summary, run, await histories.read(childSessionId, run.completionEventId), warnedUnreadableRuns))
  }

  async function replay(): ReturnType<SessionToolSummaryReader["replay"]> {
    const head = await reader.capturePosition()
    if (head === readThrough) return { position, summaries, changedToolUseIds: new Set(), measure }
    const snapshot = await runs.replay()
    for (const toolUseId of snapshot.changedToolUseIds) trackPausedConversation(toolUseId, snapshot.runsByToolUseId.get(toolUseId))
    for (const [toolUseId, runIds] of snapshot.changedRunIdsByToolUseId) {
      const stale = staleRunIdsByToolUseId.get(toolUseId)
      if (stale) for (const childRunId of runIds) stale.add(childRunId)
      else staleRunIdsByToolUseId.set(toolUseId, new Set(runIds))
    }
    const changedToolUseIds = new Set(snapshot.changedToolUseIds)
    // A paused card states its child's last turn end, which a new entry of
    // the child's conversation can change. The first catch-up summarizes every run.
    if (readThrough >= 0 && pausedToolUseIdsByConversation.size > 0 && head > readThrough) {
      for (const toolUseId of await movedPausedCalls(readThrough, head)) changedToolUseIds.add(toolUseId)
    }
    for (const toolUseId of changedToolUseIds) {
      const run = snapshot.runsByToolUseId.get(toolUseId)
      if (run) {
        const retried = (snapshot.runIdsByToolUseId.get(toolUseId)?.size ?? 0) > 1
        const latest = await summarizeRun(reader, toolUseId, run, totalsOf(snapshot, run), retried)
        const attempts = await restateAttempts(snapshot, toolUseId, run, latest)
        const summary = retried ? { ...latest, attempts } : latest
        summarizedRuns.set(summary, run)
        summaries.set(toolUseId, summary)
      } else {
        summaries.delete(toolUseId)
        attemptsByToolUseId.delete(toolUseId)
        staleRunIdsByToolUseId.delete(toolUseId)
      }
    }
    if (changedToolUseIds.size > 0) position += 1
    readThrough = head
    return { position, summaries, changedToolUseIds, measure }
  }

  /** The attempts of call `toolUseId`, in the order its runs began, with
   *  `latest` as the summary of its newest run `run`. Only the runs that
   *  changed since the card last stated them are summarized again, and the
   *  paused ones, whose summary reads their conversation's last turn end. */
  async function restateAttempts(snapshot: SubagentRunsCatchUp, toolUseId: string, run: SubagentRunEntry, latest: ToolHistorySummary): Promise<readonly Attempt[]> {
    let call = attemptsByToolUseId.get(toolUseId)
    if (!call) {
      call = { attempts: [], indexByRunId: new Map(), paused: new Set() }
      attemptsByToolUseId.set(toolUseId, call)
    }
    const { indexByRunId, paused } = call
    const restated = new Set([...staleRunIdsByToolUseId.get(toolUseId) ?? [], run.childRunId, ...paused])
    staleRunIdsByToolUseId.delete(toolUseId)
    const attempts = [...call.attempts]
    await Promise.all([...restated].map(async (childRunId) => {
      const candidate = snapshot.runsByChildRunId.get(childRunId)
      if (!candidate) return
      let index = indexByRunId.get(childRunId)
      if (index === undefined) {
        index = indexByRunId.size
        indexByRunId.set(childRunId, index)
      }
      const summary = candidate === run ? latest : await summarizeRun(reader, toolUseId, candidate, totalsOf(snapshot, candidate), index > 0)
      summarizedRuns.set(summary, candidate)
      if (candidate.status === "paused") paused.add(childRunId)
      else paused.delete(childRunId)
      attempts[index] = {
        summary,
        resumes: [...snapshot.resumeToolUseIdsByChildRunId.get(childRunId) ?? []].flatMap((resumeToolUseId) => {
          const resumed = snapshot.resumedRunsByToolUseId.get(resumeToolUseId)
          return resumed ? [{ toolUseId: resumeToolUseId, sameRun: resumed.sameRun }] : []
        }),
      }
    }))
    call.attempts = attempts
    return attempts
  }

  function trackPausedConversation(toolUseId: string, run: SubagentRunEntry | undefined): void {
    const previous = pausedConversationByToolUseId.get(toolUseId)
    const next = run?.status === "paused" && run.conversationId !== undefined ? `conversation:${run.conversationId}` : undefined
    if (previous === next) return
    if (previous !== undefined) {
      const paused = pausedToolUseIdsByConversation.get(previous)
      paused?.delete(toolUseId)
      if (paused?.size === 0) pausedToolUseIdsByConversation.delete(previous)
      pausedConversationByToolUseId.delete(toolUseId)
    }
    if (next === undefined) return
    pausedConversationByToolUseId.set(toolUseId, next)
    const paused = pausedToolUseIdsByConversation.get(next)
    if (paused) paused.add(toolUseId)
    else pausedToolUseIdsByConversation.set(next, new Set([toolUseId]))
  }

  /** The paused calls whose conversations appended entries after
   *  `afterPosition`, through `upperPosition`: one read of the entries
   *  committed in that range, routed to their calls by conversation. */
  async function movedPausedCalls(afterPosition: number, upperPosition: number): Promise<Set<string>> {
    const slice = await reader.readSlice({
      aggregatePrefix: "conversation:", types: ["chat.entries.appended"], afterPosition, beforePosition: upperPosition + 1,
    }, true)
    const moved = new Set<string>()
    for (const fact of slice.facts) {
      for (const toolUseId of pausedToolUseIdsByConversation.get(fact instanceof CorruptEventRowError ? fact.row.aggregateId : fact.aggregateId) ?? []) moved.add(toolUseId)
    }
    return moved
  }
}

type Attempt = NonNullable<ToolHistorySummary["attempts"]>[number]

/** The attempts a call's card last stated, by the order its runs began. */
interface CallAttempts {
  attempts: readonly Attempt[]
  readonly indexByRunId: Map<string, number>
  readonly paused: Set<string>
}

/** A row states the whole session's work through its run. Settled Resume can
 *  add an attempt under the same call. Only earlier runs feed a row, so a
 *  later attempt never changes an earlier row. */
function totalsOf(snapshot: SubagentRunsCatchUp, run: SubagentRunEntry): SessionTotals | undefined {
  return run.childSessionId ? snapshot.sessionTotalsByChildRunId.get(run.childRunId) : undefined
}

/** A summary states the figures its run records. */
async function summarizeRun(
  reader: AsyncEventStateReadSurface,
  toolUseId: string,
  run: SubagentRunEntry,
  totals: SessionTotals | undefined,
  ownsAttempt = false,
): Promise<ToolHistorySummary> {
  const model = [run.model, run.effort].filter(Boolean).join(" ")
  const duration = totals ? totals.duration : run.durationMs
  const totalTokens = totals ? totals.tokens : run.totalTokens
  const base = {
    toolUseId,
    description: run.description,
    totalToolCount: totals?.toolCount ?? run.toolUses ?? 0,
    ownsSettlement: ownsAttempt || run.status !== "failed",
    ...(run.agentType ? { agentType: run.agentType } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(model ? { model } : {}),
    ...(run.childSessionId ? { linkUri: `flywheel://session/${run.childSessionId}` } : {}),
  }
  switch (run.status) {
    case "completed":
    case "partial":
      return { ...base, status: run.status, summary: agentResultSummary(run.result) }
    case "cancelled":
    case "stopped":
      return { ...base, status: run.status }
    case "failed":
      return { ...base, status: "error", failure: formatAgentFailureDisplay(run.result ?? run.resultPreview ?? "Subagent failed") }
    case "paused": {
      if (!run.pausedBy) throw new Error(`Paused subagent run ${run.childRunId} does not record who paused it`)
      // The child's own last turn end names who interrupted it last: a
      // person, its parent agent, or the runtime. `subagent.paused` saves
      // the parent agent's interrupt as a person's, so the turn end is the
      // one authority. A planned replacement's cut reads as the active child
      // the successor resumes: it shows nothing. An interrupt recorded over
      // that cut reads as its own. A run whose conversation holds no turn
      // end keeps the actor that its fact records.
      const end = run.conversationId !== undefined ? (await readChatTurnEnd(reader, run.conversationId))?.end : undefined
      if (!isVisibleTurnEnd(end)) return { ...base, status: "active" }
      return { ...base, status: "paused", pausedBy: end?.reason === "paused" ? end.pausedBy : run.pausedBy }
    }
    // A `created` run is owned by a live child. The cold boundary converts
    // every ownerless one before a fold reads it: recovery records
    // `subagent.interrupted` after a crash and the planned shutdown records
    // `subagent.paused`. A fold read while the child runs (a client that
    // attaches to the parent later) therefore shows the same active card as
    // the client that watched the dispatch.
    case "created":
      return { ...base, status: "active" }
    case "interrupted":
      return { ...base, status: "interrupted" }
  }
}

/** The figures a card states: the tool count and tokens its child's history
 *  measures before the run's completion, or the recorded figures where the
 *  history holds none of them. */
function measureRun(summary: ToolHistorySummary, run: SubagentRunEntry, measure: ChildMeasure, warnedUnreadableRuns: Set<string>): ToolHistorySummary {
  let totalToolCount = summary.totalToolCount
  if (measure.toolCount === "unreadable") {
    if (!warnedUnreadableRuns.has(run.childRunId)) {
      warnedUnreadableRuns.add(run.childRunId)
      log.warn("subagent run history is unreadable; using recorded tool count", {
        childRunId: run.childRunId,
        failureKind: "tool_execution_timeline",
      })
    }
  } else if (measure.toolCount !== undefined) {
    totalToolCount = measure.toolCount
  }
  const totalTokens = measure.tokens ?? summary.totalTokens
  if (totalToolCount === summary.totalToolCount && totalTokens === summary.totalTokens) return summary
  return { ...summary, totalToolCount, ...(totalTokens !== undefined ? { totalTokens } : {}) }
}
