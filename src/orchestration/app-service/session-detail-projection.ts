import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { SessionManager } from "../session/manager.js"
import type { ReplayedSession } from "../session/schemas.js"
import type { SessionEntry, SessionStore } from "../session-store/types.js"
import { type SessionView, toSessionView } from "../session-store/view.js"
import { readBudgetSummaryFromReader, type BudgetSummary } from "../session/budget-summary.js"
import { readSessionDurationFromReader } from "../session/session-duration-projection.js"
import { projectSessionView } from "./frontend-projection.js"
import { readRecordedExecutionCwd } from "../session/session-execution-directory.js"
import type { RuntimeSessionDetailView, RuntimeSessionDetailResult } from "../../protocol/session-detail-protocol-types.js"
import type { StatusView } from "../../protocol/status-protocol-types.js"
import type { ProcessorClaims } from "../agent-runtime/tools/processor-claims.js"
import { hydrateDerivedOutputGroupChildren, hydrateDerivedOutputRange, hydrateDerivedOutputBlockBody, paginateOutputGroupChildren, unavailableHydratedOutputRange } from "./transcript-queries.js"
import { readOutputSequence, type OutputSequence } from "./output-sequence.js"
import type { ShippedOutput } from "./shipped-output.js"
import { indexOutputBlocks } from "../session/conversation/branch-history-builder.js"
import type { CommandKeeper } from "./command-keeper.js"
import { createTranscriptProjectionCache, type TranscriptProjectionCache } from "./transcript-projection-cache.js"
import type {
  HydratedOutputRange,
  HydratedOutputGroupChildrenBatch,
  HydratedOutputBlockBody,
  OutputGroupChildrenRequest,
  TranscriptUnavailable,
  OutputRangeRequest,
  OutputBlockBodyRequest,
} from "../../protocol/transcript-protocol-types.js"
import type { SessionSummaryIndex } from "../session/session-summary-index.js"
import { durableCatalogRowFromSession, parentIdentity, projectSessionCatalogRow, replaceCatalogTotals, type SessionActionEvidence } from "../session/session-catalog-row.js"
import { readChildSessionRunEvidence } from "../session/child-session-run-evidence.js"
import { readChatTurnEnd } from "../session/chat-session-run-evidence.js"
import { awaitsPlannedContinuation, capacityContinuations } from "../session/planned-session-continuation.js"
import { capacityWaitNotice } from "../session/capacity-wait.js"
import { hasPendingRetainedOperation } from "../session/module-session-operations.js"
import { keptCommandsOf } from "../session/command-handover.js"
import { presentedTurn } from "./status-projection.js"
import { readReplyWaitViews, toReplyWaitViews, type OpenReplyWaitView } from "../session/reply-waits.js"
import { displayedReplyWait } from "../../protocol/client/session-controls.js"
import { budgetViewFromRuntimeSummary, type RuntimeSummaryProjection, type RuntimeSummaryView } from "./runtime-summary-projection.js"
import type { SessionRow } from "../../protocol/app-service-types.js"
import { workflowRunReader } from "../module-catalog.js"

export interface SessionDetailProjection {
  sessionDetail(sessionId: string): Promise<RuntimeSessionDetailResult>
  outputWindow(sessionId: string, request: OutputRangeRequest): Promise<{ readonly totalBlocks: number; readonly visibleMessageCount: number; readonly range: HydratedOutputRange }>
  outputRange(sessionId: string, request: OutputRangeRequest): Promise<HydratedOutputRange>
  outputGroupChildren(sessionId: string, request: OutputGroupChildrenRequest): Promise<HydratedOutputGroupChildrenBatch>
  outputBlockBody(sessionId: string, request: OutputBlockBodyRequest): Promise<HydratedOutputBlockBody>
  dispose(): Promise<void>
}

interface SessionDetailReaderDeps {
  readonly sessionStore: Pick<SessionStore, "get"> & Partial<Pick<SessionStore, "revision">>
  readonly manager: Pick<SessionManager, "read">
  readonly readSession?: SessionManager["read"]
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly projectRoot: string
  readonly summaryIndex?: Pick<SessionSummaryIndex, "readImmediate">
  readonly summaries?: RuntimeSummaryProjection
  /** The shell commands of each session that processor admission holds.
   *  Absent in a process that owns no shell container, whose details show
   *  none held. */
  readonly processorHolds?: Pick<ProcessorClaims, "heldToolCallIds">
}

interface SessionDetailProjectionDeps extends SessionDetailReaderDeps {
  readonly transcriptCache?: TranscriptProjectionCache
  /** The keeper that carries the live output of commands no host holds. */
  readonly keptOutput?: Pick<CommandKeeper, "liveOutput">
  /** The owner of what the output cursor's clients hold, which learns what
   *  each output read serves. A process that publishes no output has none. */
  readonly shipped?: Pick<ShippedOutput, "serve">
}

/** One session's detail: its metadata, summaries, status, and admitted
 *  actions. It reads no transcript, so it holds nothing between calls, and
 *  the account history serves it for a session the executor does not hold. */
export function createSessionDetailReader(deps: SessionDetailReaderDeps): (sessionId: string) => Promise<RuntimeSessionDetailResult> {
  const reads: EvidenceReads = { reader: deps.reader, projectionReader: deps.projectionReader }
  async function sessionDetail(sessionId: string): Promise<RuntimeSessionDetailResult> {
    // A detail shows what the status stream shows: a session a successor
    // will continue after a planned replacement shows working, never at
    // rest, and offers its Interrupt, including after the service that cut
    // it has released it and before the successor resumes it.
    const continuationOwed = await awaitsPlannedContinuation({ reader: deps.reader, projectionReader: deps.projectionReader, manager: deps.manager }, sessionId)
    const view = await projectedDetail(sessionId, continuationOwed)
    if (view === null) return { view: null }
    const turn = await presentedTurn(view.status, async () => continuationOwed)
    const unchanged = turn.activity === view.status.activity && turn.waitingOnBackgroundWork === view.status.waitingOnBackgroundWork
    return { view: unchanged ? view : { ...view, status: { ...view.status, ...turn, activityStartedAt: turn.waitingOnBackgroundWork ? view.status.activityStartedAt : null } } }
  }

  const shellCalls = (sessionId: string, entry: Pick<SessionEntry, "activeForegroundBashToolCallIds">): ShellCalls => ({
    activeForegroundBashToolCallIds: entry.activeForegroundBashToolCallIds,
    processorHeldToolCallIds: deps.processorHolds?.heldToolCallIds(sessionId) ?? [],
  })

  async function projectedDetail(sessionId: string, continuationOwed: boolean): Promise<RuntimeSessionDetailView | null> {
    const read = deps.readSession ?? deps.manager.read
    const metadata = await read(sessionId)
    const entry = deps.sessionStore.get(sessionId)
    if (!metadata || metadata.kind === "workflow") return null
    const executionCwd = await readRecordedExecutionCwd(metadata, deps.projectRoot, deps.reader)
    await deps.summaries?.admit([sessionId])
    // The status reads the waits the session stores, as the executor's status
    // stream does, so no owner that serves a status can show a wait missing.
    const replyWaits = await readReplyWaitViews(deps.projectionReader, read, sessionId)
    if (entry) {
      const view = toSessionView(sessionId, entry, metadata.lifecycleState, metadata.kind === "workflow-agent" ? metadata.workflowMembership : undefined)
      // A turn that runs shows its own state; only a session at rest shows
      // the capacity wait its row owes.
      const evidence = await sessionActionEvidence(reads, sessionId, view.kind, view.conversationId, continuationOwed, metadata, view.activity !== "idle" && view.activity !== "absent")
      if (deps.summaries) {
        return projectLiveHistorySessionView(view, metadata, executionCwd, shellCalls(sessionId, entry), deps.summaries.view(sessionId), evidence, replyWaits)
      }
      const budget = await readBudgetSummaryFromReader(deps.projectionReader, sessionId)
      return projectLiveHistorySessionView(view, metadata, executionCwd, shellCalls(sessionId, entry), { totalsLoading: false, row: { ...budget, durationMs: view.accumulatedActiveMs } }, evidence, replyWaits)
    }
    return await projectDurableHistorySessionView(sessionId, metadata, deps, reads, executionCwd, continuationOwed, replyWaits)
  }

  return sessionDetail
}

/** A workflow has no transcript of its own (PI-INTERACTION-051). */
const WORKFLOW_HAS_NO_TRANSCRIPT: TranscriptUnavailable = {
  title: "A workflow has no transcript",
  message: "This workflow shows on its card in the parent chat, and each of its agents opens in its own view.",
  diagnostic: "Workflow aggregates have no transcript. Read the ordinary output of an agent session.",
}

export function createSessionDetailProjection(deps: SessionDetailProjectionDeps): SessionDetailProjection {
  const transcriptCache = deps.transcriptCache ?? createTranscriptProjectionCache(deps)
  const outputSequenceDeps = { ...deps, transcriptCache }
  const sessionDetail = createSessionDetailReader(deps)

  async function readRange(sessionId: string, request: OutputRangeRequest): Promise<{ readonly sequence: OutputSequence | null; readonly range: HydratedOutputRange }> {
    const session = await deps.manager.read(sessionId)
    if (session?.kind === "workflow") return { sequence: null, range: unavailableHydratedOutputRange(request.anchor, WORKFLOW_HAS_NO_TRANSCRIPT) }
    const sequence = await readOutputSequence(sessionId, session, outputSequenceDeps)
    if (!sequence) return { sequence, range: unavailableHydratedOutputRange(request.anchor, sessionHistoryUnavailable(sessionId)) }
    const range = await hydrateDerivedOutputRange(sequence, request)
    return { sequence, range: range.kind === "ok" ? { ...range, streamingToolText: sequence.streamingToolText, streamingOutputChars: sequence.streamingOutputChars } : range }
  }

  /** A range that a client installs. The owner of the output cursor serves
   *  it, because the read can hold changes no delta has shipped yet. */
  function servedRange(sessionId: string, request: OutputRangeRequest) {
    return deps.shipped ? deps.shipped.serve(sessionId, () => readRange(sessionId, request), (read) => read.range) : readRange(sessionId, request)
  }

  async function outputWindow(sessionId: string, request: OutputRangeRequest): Promise<{ readonly totalBlocks: number; readonly visibleMessageCount: number; readonly range: HydratedOutputRange }> {
    const { sequence, range } = await servedRange(sessionId, request)
    return { totalBlocks: sequence?.blockCount ?? 0, visibleMessageCount: sequence?.visibleMessageCount ?? 0, range }
  }

  async function outputRange(sessionId: string, request: OutputRangeRequest): Promise<HydratedOutputRange> {
    return (await servedRange(sessionId, request)).range
  }

  async function outputGroupChildren(sessionId: string, request: OutputGroupChildrenRequest): Promise<HydratedOutputGroupChildrenBatch> {
    const session = await deps.manager.read(sessionId)
    const sequence = await readOutputSequence(sessionId, session, outputSequenceDeps)
    if (!sequence || !session) throw new Error(`Session ${sessionId} has no readable history: it is not in the workspace session catalog.`)
    const requested = new Set(request.groupBlockIds)
    const groups = [...requested].map((id) => ({ id, index: sequence.indexOf(id) })).sort((a, b) => a.index - b.index)
    if (groups.some((group) => group.index < 0)) throw new Error("one or more requested output groups are missing from the bounded output sequence")
    const hydrated = await Promise.all(groups.map(async ({ id }) => hydrateDerivedOutputGroupChildren(id, await sequence.groupChildren(id))))
    return paginateOutputGroupChildren(hydrated, request)
  }

  async function outputBlockBody(sessionId: string, request: OutputBlockBodyRequest): Promise<HydratedOutputBlockBody> {
    // A pre-runner row can be replaced while durable history is read.
    const entry = deps.sessionStore.get(sessionId)
    if (entry) {
      // Projected together, so the subagent cards share one snapshot replay,
      // as in `readOutputSequence`.
      const live = indexOutputBlocks(await Promise.all(entry.outputBlocks().map((block) => transcriptCache.projectBlock(sessionId, block))))
      const index = live.indexOf(request.blockId)
      if (index >= 0) return hydrateDerivedOutputBlockBody(live, request)
    }
    const sequence = await readOutputSequence(sessionId, await deps.manager.read(sessionId), outputSequenceDeps)
    if (!sequence) throw new Error(`Session ${sessionId} has no readable history: it is not in the workspace session catalog.`)
    return hydrateDerivedOutputBlockBody(sequence, request)
  }

  function sessionHistoryUnavailable(sessionId: string): TranscriptUnavailable {
    return {
      title: "Session history unavailable",
      message: "This session is missing from the workspace catalog, so its conversation history cannot be read.",
      diagnostic: `session ${sessionId} has no metadata in the event store`,
    }
  }

  return { sessionDetail, outputWindow, outputRange, outputGroupChildren, outputBlockBody, dispose: async () => { if (!deps.transcriptCache) await transcriptCache.dispose() } }
}

/** A live session's totals: its summary, or, where no summary owner
 *  serves the detail, its durable budget beside its live duration. */
type LiveTotals = RuntimeSummaryView | { readonly totalsLoading: false; readonly row: BudgetSummary & { readonly durationMs: number } }

/** A live session's running shell calls: those its turn holds, and those
 *  processor admission holds. */
type ShellCalls = Pick<StatusView, "activeForegroundBashToolCallIds" | "processorHeldToolCallIds">

function projectLiveHistorySessionView(
  view: SessionView,
  metadata: ReplayedSession,
  executionCwd: string,
  shell: ShellCalls,
  totals: LiveTotals,
  evidence: SessionActionEvidence,
  replyWaits: readonly OpenReplyWaitView[],
): RuntimeSessionDetailView {
  const completeRow = <Row extends SessionRow>(row: Row) => replaceCatalogTotals({
    ...row,
    title: metadata.label || metadata.name || view.id,
    ...(metadata.shortLabel !== undefined ? { shortTitle: metadata.shortLabel } : {}),
    lastUpdated: metadata.lastUpdated,
    ...(metadata.createdAt !== undefined ? { createdAt: metadata.createdAt } : {}),
    ...(metadata.childSessionIds !== undefined ? { childSessionIds: metadata.childSessionIds } : {}),
    ...parentIdentity(metadata.launchedFrom),
  }, totals)
  const base = {
    source: "live" as const,
    id: view.id,
    streamingToolText: view.streamingToolText ?? {},
    status: {
      activity: view.activity,
      activityStartedAt: view.activity === "idle" || view.activity === "absent" ? displayedReplyWait(replyWaits, (wait) => wait.isParent)?.openedAtMs ?? view.activityStartedAt : view.activityStartedAt,
      settledOutputPosition: null,
      connectionState: view.connectionState,
      activeSubagentCount: 0,
      activeBackgroundCommands: [],
      activeForegroundBashToolCallIds: metadata.lifecycleState === "active" ? shell.activeForegroundBashToolCallIds : [],
      processorHeldToolCallIds: metadata.lifecycleState === "active" ? shell.processorHeldToolCallIds : [],
      waitingOnBackgroundWork: false,
      startedAt: view.startedAt,
      streamingStartedAt: view.streamingStartedAt,
      accumulatedActiveMs: view.accumulatedActiveMs,
      compactionStartedAt: view.compactionStartedAt,
      replyWaits: toReplyWaitViews(replyWaits),
    },
    budget: budgetViewFromRuntimeSummary(totals),
  }

    const conversation = {
      ...base,
      conversationId: view.conversationId,
      ...(view.providerConversationId !== undefined ? { providerConversationId: view.providerConversationId } : {}),
      ...(view.seedContext !== undefined ? { seedContext: view.seedContext } : {}),
    }
    return view.kind === "chat"
      ? { ...conversation, kind: "chat", row: completeRow(projectSessionView(view, executionCwd, evidence).row) }
      : view.kind === "workflow-agent"
      ? { ...conversation, kind: "workflow-agent", row: completeRow(projectSessionView(view, executionCwd, evidence).row) }
      : { ...conversation, kind: "subagent", row: completeRow(projectSessionView(view, executionCwd, evidence).row) }
}

/** What the evidence of a session's admitted actions reads. */
interface EvidenceReads {
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
}

/** The evidence one session's admitted actions read: a child's run, a
 *  chat's turn end, or a workflow's control state and the turn end of its
 *  current agent, beside whether a successor owes it its continuation. Only the
 *  detail read serves it, so only it pays for it. */
async function sessionActionEvidence({ reader, projectionReader }: EvidenceReads, sessionId: string, kind: ReplayedSession["kind"], conversationId: string | undefined, continuationOwed: boolean, metadata: ReplayedSession, running = false): Promise<SessionActionEvidence> {
  const [wait] = running ? [] : await capacityContinuations(projectionReader, [sessionId])
  const capacityNotice = wait === undefined ? undefined : capacityWaitNotice({ sessionId, agentName: kind === "chat" ? "Chat" : metadata.label || metadata.name || sessionId, atMs: wait.continuesAt, now: Date.now() })
  const owed = { ...(continuationOwed ? { continuationOwed } : {}), ...(capacityNotice ? { capacityNotice } : {}) }
  if (kind === "subagent") return { childRun: await readChildSessionRunEvidence(projectionReader, sessionId), ...owed }
  if (metadata.kind === "workflow-agent") {
    const member = metadata.workflowMembership
    const memberActive = member.kind === "attempt" && (await workflowRunReader(reader).readAttempt(member.workflowId, member.attemptId))?.state._tag === "running"
    return { memberActive, ...(conversationId ? { chatTurnEnd: await readChatTurnEnd(projectionReader, conversationId) } : {}), ...owed }
  }
  if (kind === "chat" && conversationId !== undefined) {
    const chatTurnEnd = await readChatTurnEnd(projectionReader, conversationId)
    const retainedInput = await hasPendingRetainedOperation(reader, sessionId, conversationId)
    return { ...(chatTurnEnd ? { chatTurnEnd } : {}), retainedInput, ...owed }
  }
  return owed
}

async function projectDurableHistorySessionView(sessionId: string, session: Exclude<ReplayedSession, { kind: "workflow" }>, deps: SessionDetailReaderDeps, reads: EvidenceReads, executionCwd: string, continuationOwed: boolean, replyWaits: readonly OpenReplyWaitView[]): Promise<RuntimeSessionDetailView> {
  const runtimeSummary = deps.summaries?.view(sessionId)
  const indexed = runtimeSummary === undefined && deps.summaryIndex ? await deps.summaryIndex.readImmediate([sessionId]) : undefined
  const summary = indexed?.status === "ready" ? indexed.summaries.get(sessionId) : undefined
  if (indexed?.status === "ready" && !summary) throw new Error(`Session summary index omitted requested session ${sessionId}`)
  const runtimeReady = runtimeSummary?.totalsLoading === false ? runtimeSummary : undefined
  const runtimeReadyRow = runtimeReady?.row
  const budget = runtimeReadyRow ?? (runtimeSummary ? undefined : indexed === undefined ? await readBudgetSummaryFromReader(deps.projectionReader, sessionId) : summary?.budget)
  const duration = runtimeReadyRow
    ? { accumulatedActiveMs: runtimeReadyRow.durationMs }
    : runtimeSummary ? undefined : indexed === undefined ? await readSessionDurationFromReader(deps.projectionReader, sessionId) : summary?.duration
  const diffStats = runtimeReadyRow?.diffStats ?? (runtimeSummary ? undefined : indexed === undefined ? undefined : summary?.diffStats)
  const speed = runtimeReady?.averageGenerationTokensPerSecond ?? summary?.averageGenerationTokensPerSecond
  const accumulatedActiveMs = duration?.accumulatedActiveMs ?? 0
  const totalsLoading = runtimeSummary?.totalsLoading === true || indexed?.status === "loading"
  // A generation error withholds only the speed, so it leaves the budget standing.
  const budgetFailed = summary?.errors.budget !== undefined || summary?.errors.descendants !== undefined
  let budgetView: RuntimeSessionDetailView["budget"] = null
  if (totalsLoading) {
    budgetView = budgetViewFromRuntimeSummary({ totalsLoading: true })
  } else if (!budgetFailed) {
    if (!budget) throw new Error(`Session summary index omitted budget for ${sessionId}`)
    budgetView = budgetViewFromRuntimeSummary({ totalsLoading: false, row: budget, ...(speed === undefined ? {} : { averageGenerationTokensPerSecond: speed }) })
  }
  const startedAt = session.createdAt ? new Date(session.createdAt).getTime() : Date.now()
  const catalogMetadata = durableCatalogRowFromSession(sessionId, session, executionCwd)
  const catalogSource = totalsLoading || !budget || !duration
    ? catalogMetadata
    : {
      ...catalogMetadata,
      totalTokens: budget.totalTokens,
      totalCost: budget.totalCost,
      totalBilledCost: budget.totalBilledCost,
      priceUnavailable: budget.priceUnavailable,
      contextPercent: budget.contextPercent,
      contextPromptTokens: budget.contextPromptTokens,
      durationMs: accumulatedActiveMs,
      ...(diffStats ? { diffStats } : {}),
    }
  const evidence = await sessionActionEvidence(reads, sessionId, session.kind, session.conversationId, continuationOwed, session)
  const base = {
    source: "durable" as const,
    id: sessionId,
    status: {
      activity: "absent" as const,
      settledOutputPosition: null,
      connectionState: "connected" as const,
      activeSubagentCount: 0,
      // A command handed to the session that the executor's keeper holds
      // shows with its Stop, which the keeper answers.
      activeBackgroundCommands: await keptCommandsOf(deps.reader, sessionId),
      activeForegroundBashToolCallIds: [],
      processorHeldToolCallIds: deps.processorHolds?.heldToolCallIds(sessionId) ?? [],
      waitingOnBackgroundWork: false,
      startedAt,
      streamingStartedAt: null,
      activityStartedAt: displayedReplyWait(replyWaits, (wait) => wait.isParent)?.openedAtMs ?? null,
      accumulatedActiveMs,
      compactionStartedAt: null,
      replyWaits: toReplyWaitViews(replyWaits),
    },
    budget: budgetView,
  }

    const conversation = {
      ...base,
      conversationId: session.conversationId,
      ...(session.providerConversationId !== undefined ? { providerConversationId: session.providerConversationId } : {}),
      ...(session.seedContext !== undefined ? { seedContext: session.seedContext } : {}),
    }
    const { kind: _kind, workflowMembership: _membership, ...catalog } = catalogSource
    return session.kind === "chat"
      ? { ...conversation, kind: "chat", row: projectSessionCatalogRow({ ...catalog, kind: "chat" }, evidence) }
      : session.kind === "workflow-agent"
      ? { ...conversation, kind: "workflow-agent", row: projectSessionCatalogRow({ ...catalog, kind: "workflow-agent", workflowMembership: session.workflowMembership }, evidence) }
      : { ...conversation, kind: "subagent", row: projectSessionCatalogRow({ ...catalog, kind: "subagent" }, evidence) }
}
