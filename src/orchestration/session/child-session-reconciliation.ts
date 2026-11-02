import { requireGuardedEventAppender, type AggregateSeqConflict, type AsyncEventStateReadSurface, type AsyncEventWriter, type GuardedEventStoreAppend, type StoredFact } from "../../infra/event-store-types.js"
import type { BackgroundWorkResult } from "../agent-runtime/background-work.js"
import { liveWorkflowControl } from "./live-session-control.js"
import {
  childSessionBackgroundResult,
  durableSubagentCompletionNotification,
  hasDurableSubagentNotificationEvidence,
} from "../agent-runtime/background-work-notifications.js"
import { installedChildSessionHistory } from "./module-session-operations.js"
import type { ChildSessionRun, ModuleChildSessionHistory } from "../module-seams.js"
import { readPendingTurnEnds } from "./chat-session-run-evidence.js"
import { subagentRunCut } from "./child-continuation.js"
import { extractToolContentFact } from "../../infra/tool-content-extraction.js"
import { contentEvidence } from "../../infra/content-evidence.js"
import { createOrderedLane, type OrderedLane } from "../../infra/ordered-lane.js"
import { Log } from "../../infra/log.js"
import { containSessionReads } from "../../infra/session-read-containment.js"
import { childSessionResultFact, historicalCompletionEntryId, isCompletionEntry, revisedCompletionEntryId, workflowCompletionEntryId } from "./child-session-completion.js"
import type { ToolOutcome } from "../../infra/tool-outcome.js"
import { terminalOnlyCompletionContent, workflowCompletionContent, type WorkflowCompletionInput } from "../../workflows/output-contract/workflow-completion.js"
import { readChildCompletionConversation } from "./child-completion-conversation.js"
import { createSessionPlacementProjection, createSingleSessionMetadataProjection, sessionMetadataStateOf } from "./session-metadata-projection.js"
import type { ReplayedSession } from "./schemas.js"
import { workflowRunReader } from "../module-catalog.js"
import type { WorkflowRunRecord } from "../workflow-host/run-record.js"
import { prepareSessionFactAppend } from "./session-fact-writer.js"
import { buildSessionMetadataAppend } from "./session-metadata-store.js"
import { createToolExecutionProjection } from "./tool-execution-projection.js"
import type { ToolExecutionEntry, ToolExecutionState } from "./tool-execution-types.js"
import type { EventProjection } from "../../infra/event-projection.js"
import { readChildReconciliationChanges, readParentTools, type ChildReconciliationReadContext } from "./child-reconciliation-index.js"
import { sweepWithFaultNotice } from "./child-reconciliation-fault.js"
import { offerChildCompletion, reofferChildCompletions } from "./child-completion-delivery.js"
import { completionCandidate, type SettledCandidate } from "./child-workflow-candidate.js"
import { createConversationTreeProjection } from "./conversation/conversation-projection.js"
import {
  QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND,
  type HeldBackgroundNotification,
} from "./conversation/queued-background-notifications.js"

const MAX_CONFLICT_RETRIES = 3
/** One child's unreadable history, a workflow's or a subagent's, must not
 *  stop its parent from taking a message or its siblings from settling. Such
 *  a child's call stays open, as it would before the child finished. */
const childReads = containSessionReads(Log.create({ service: "child-session-reconciliation" }), "reconcile child session")
const reconciliationLanes = new WeakMap<AsyncEventStateReadSurface, Map<string, OrderedLane>>()

interface ReconcileChildSessionCompletionsInput {
  readonly parentSessionId: string
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader?: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly deliverNotification?: (notification: HeldBackgroundNotification) => Promise<boolean>
  /** The parent's tool-execution projection when the caller holds it, such
   *  as an activation that repairs the same calls next: the parent's calls
   *  then fold once for both. */
  readonly parentTools?: EventProjection<ToolExecutionState>
}

/** What a session's caller adds to a sweep of its children. */
export type ChildSessionReconciliationOptions = Pick<ReconcileChildSessionCompletionsInput, "deliverNotification" | "parentTools">

interface ReconciliationContext extends ChildReconciliationReadContext {
  readonly input: ReconcileChildSessionCompletionsInput
  readonly childChanges: Map<string, StoredFact[]>
}

/** The fields of a child that the workspace placement fold keeps current,
 *  for each kind of session. Its label and lifecycle are not current there. */
type ChildPlacement = ReplayedSession extends infer Session ? Session extends ReplayedSession ? Pick<Session, "kind" | "launchedFrom"> : never : never

export interface ChildSessionReconciliation {
  readonly reconciledCount: number
  /** Workflow aggregate reads performed by this reconciliation request. */
  readonly workflowAggregateReads: number
  readonly durableTerminalChildSessionIds?: readonly string[]
  readonly linkedNonterminalWorkflowToolUseIds?: readonly string[]
}

interface SubagentCompletionCandidate {
  readonly childSessionId: string
  readonly run: ChildSessionRun
  readonly settlesLifecycle: boolean
  readonly tool: ToolExecutionEntry
  readonly result: BackgroundWorkResult
}

interface ReconciliationMeasurement {
  workflowAggregateReads: number
}

interface ChildReconciliation {
  readonly wrote: boolean
  readonly durable: boolean
  readonly terminalSequence?: number
  readonly linkedNonterminalToolUseId?: string
}

interface SubagentReconciliation {
  readonly reconciledCount: number
  readonly durableTerminalChildSessionIds: readonly string[]
  /** Children whose runs this sweep read in full; later sweeps read only their changes. */
  readonly seededChildSessionIds: readonly string[]
}

/** Reconstructs child completion delivery from terminal child facts, the durable
 * parent binding, and the bound parent tool. Result settlement and notification
 * admission share one writer-lane transaction. */
export async function reconcileChildSessionCompletions(
  input: ReconcileChildSessionCompletionsInput,
): Promise<ChildSessionReconciliation> {
  const sweep = async (): Promise<ChildSessionReconciliation> => {
    await settleSweptSessions(input)
    return parentLane(input.reader, input.parentSessionId).run(async () => {
      const reader = input.projectionReader ?? input.reader
      const previousHolds = new Set((await reader.readInFlight(input.parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).map(({ key }) => key))
      const { completeDelivery } = await reconcileChildSessionCompletionsNow(input)
      return completeDelivery(await reofferChildCompletions(input, previousHolds, sweepAfterCommit(input)))
    })
  }
  return sweepWithFaultNotice(input.reader, input.parentSessionId, sweep)
}

/** The ordered lane of one parent's sweeps. It is taken after the settle
 *  step, because a lane that went idle while the step waited is gone, and a
 *  second sweep would then run in a new lane beside it. */
function parentLane(reader: AsyncEventStateReadSurface, parentSessionId: string): OrderedLane {
  const lanes = reconciliationLanes.get(reader) ?? new Map<string, OrderedLane>()
  reconciliationLanes.set(reader, lanes)
  let lane = lanes.get(parentSessionId)
  if (!lane) {
    lane = createOrderedLane(() => { lanes.delete(parentSessionId) })
    lanes.set(parentSessionId, lane)
  }
  return lane
}

/** Settles, through the reader, each session that the sweep writes or reads
 *  a guard sequence of: the parent and its subagent children. The state
 *  Worker's reader recovers such a session first if it owes recovery. That
 *  recovery sweeps the same parent, so it must finish before this sweep
 *  takes the parent's lane: started inside the sweep, it would wait behind
 *  the sweep forever. Other readers settle nothing. */
async function settleSweptSessions(input: ReconcileChildSessionCompletionsInput): Promise<void> {
  const reader = input.projectionReader ?? input.reader
  if (!reader.settleBefore) return
  const parent = await readSession({ input }, input.parentSessionId)
  await reader.settleBefore([input.parentSessionId, ...parent?.childSessionIds ?? []])
}

async function reconcileChildSessionCompletionsNow(
  input: ReconcileChildSessionCompletionsInput,
): Promise<{ completeDelivery: (heldKeys: ReadonlySet<string>) => Promise<ChildSessionReconciliation> }> {
  const reader = input.projectionReader ?? input.reader
  const { index, batches, childChanges, first, changedChildren, changedWorkflows } = await readChildReconciliationChanges(reader, input.parentSessionId)
  const context: ReconciliationContext = { input, index, childChanges, parentTools: input.parentTools ?? createToolExecutionProjection(reader, input.parentSessionId) }
  const measurement: ReconciliationMeasurement = { workflowAggregateReads: 0 }
  const parent = await readSession(context, input.parentSessionId)
  if (!parent) return { completeDelivery: async () => ({ reconciledCount: 0, workflowAggregateReads: 0, durableTerminalChildSessionIds: [], linkedNonterminalWorkflowToolUseIds: [] }) }

  let reconciledCount = 0
  if (first) {
    for (const id of parent.childSessionIds ?? []) changedChildren.add(id)
    for (const { workflowId, run } of await workflowRunReader(reader).listForParent(input.parentSessionId)) {
      index.workflows.add(workflowId)
      index.toolChildren.set(run.launchedFrom.toolUseId, workflowId)
      changedWorkflows.add(workflowId)
    }
    if (changedChildren.size > 0 || index.workflows.size > 0) {
      await context.parentTools.replay()
      if (parent.kind === "chat") await createConversationTreeProjection(reader, parent.conversationId).replay()
    }
  }
  // One replay of the workspace placement fold places every changed child.
  const placements = changedChildren.size === 0 ? undefined : await createSessionPlacementProjection(reader).replay()
  const children = [...changedChildren].map((id) => {
    const state = placements && sessionMetadataStateOf(placements, id)
    const session: ChildPlacement | null = !state || state.deleted[id] || state.errors[id] ? null : state.sessions[id] ?? null
    if (session?.kind === "subagent" && session.launchedFrom.parentSessionId === input.parentSessionId) {
      index.children.add(id)
      index.toolChildren.set(session.launchedFrom.toolUseId, id)
    }
    return { id, session }
  })
  const runs = (await Promise.all([...changedWorkflows].map(async (workflowId) => {
    const run = await childReads.read(workflowId, () => workflowRunReader(reader).read(workflowId), null)
    if (!run || run.launchedFrom.parentSessionId !== input.parentSessionId) {
      index.workflows.delete(workflowId)
      index.durable.delete(workflowId)
      index.nonterminal.delete(workflowId)
      return null
    }
    index.workflows.add(workflowId)
    index.toolChildren.set(run.launchedFrom.toolUseId, workflowId)
    return { workflowId, run }
  }))).filter((run) => run !== null)
  const workflowToolUseIds = runs.map(({ run }) => run.launchedFrom.toolUseId)
  const parentToolSequence = runs.length === 0 ? -1 : await reader.aggregateSeq(`session:${input.parentSessionId}`)
  const workflowTools = await readParentTools(context, workflowToolUseIds)
  const workflows = await Promise.all(runs.map(async ({ workflowId: id, run: child }) => {
    const candidate = await childReads.read(id, () => completionCandidate(context, parent, id, child, measurement, workflowTools.get(child.launchedFrom?.toolUseId ?? "")), null)
    return { id, child, candidate }
  }))
  for (const workflow of workflows) {
    if (!workflow) continue
    const childSessionId = workflow.id
    const reconciliation = await reconcileChild(context, parent, childSessionId, workflow.child, measurement, workflow.candidate, parentToolSequence)
    if (reconciliation.wrote) reconciledCount += 1
    if (reconciliation.durable) {
      index.durable.add(childSessionId)
      index.pendingWorkflows.delete(childSessionId)
    } else {
      index.durable.delete(childSessionId)
    }
    if (reconciliation.durable && reconciliation.terminalSequence !== undefined) liveWorkflowControl(input.reader, childSessionId)?.acknowledgeCompletion?.(reconciliation.terminalSequence)
    if (reconciliation.linkedNonterminalToolUseId) index.nonterminal.set(childSessionId, reconciliation.linkedNonterminalToolUseId)
    else index.nonterminal.delete(childSessionId)
  }
  const subagents = await reconcileSubagentCompletions(context, children)
  reconciledCount += subagents.reconciledCount
  for (const id of subagents.durableTerminalChildSessionIds) index.durable.add(id)
  index.consume(batches, subagents.seededChildSessionIds)
  const linkedNonterminalWorkflowToolUseIds = [...index.nonterminal.values()]
  return { completeDelivery: async (heldKeys) => {
    const conversations = new Map<string, Awaited<ReturnType<typeof readChildCompletionConversation>>>()
    try {
      for (const [id, notification] of index.pendingWorkflows) {
        if (heldKeys.has(notification.key)) continue
        let tree = conversations.get(notification.conversationId)
        if (!conversations.has(notification.conversationId)) {
          tree = await readChildCompletionConversation(context, input.parentSessionId, notification.conversationId)
          conversations.set(notification.conversationId, tree)
        }
        if (!tree || !await tree.getEntry(notification.key)) continue
        index.pendingWorkflows.delete(id)
        index.durable.add(id)
        if (notification.sequence !== undefined) liveWorkflowControl(input.reader, id)?.acknowledgeCompletion?.(notification.sequence)
      }
    } finally { for (const tree of conversations.values()) tree?.getStorage().dispose() }
    return {
      reconciledCount,
      workflowAggregateReads: measurement.workflowAggregateReads,
      durableTerminalChildSessionIds: [...index.durable],
      ...(linkedNonterminalWorkflowToolUseIds.length > 0 ? { linkedNonterminalWorkflowToolUseIds } : {}),
    }
  } }
}

async function reconcileSubagentCompletions(
  context: ReconciliationContext,
  children: readonly { readonly id: string; readonly session: ChildPlacement | null }[],
): Promise<SubagentReconciliation> {
  const { input } = context
  const reader = input.projectionReader ?? input.reader
  const pending: Array<Omit<SubagentCompletionCandidate, "tool"> & { readonly toolUseId: string }> = []
  const durableTerminalChildSessionIds = new Set<string>()
  const subagents = children.flatMap(({ id, session }) => session?.kind === "subagent" && session.launchedFrom.parentSessionId === input.parentSessionId ? [id] : [])
  // One fold of the parent's children serves all of them: a child seen in a
  // finished sweep reads only the runs that its new facts name. The fold
  // keeps a child's unreadable history inside that child, which then has no
  // runs, so its siblings still settle. A read that throws is the parent's
  // shared read, so it holds back every subagent child and none of the
  // parent's workflows.
  const none: Awaited<ReturnType<ModuleChildSessionHistory["readParentReconciliationRuns"]>> = new Map()
  const histories = subagents.length === 0 ? none : await childReads.read(input.parentSessionId,
    () => installedChildSessionHistory().readParentReconciliationRuns(reader, input.parentSessionId,
      new Map(subagents.map((id) => [id, context.index.seenChildren.has(id) ? context.childChanges.get(id) ?? [] : undefined]))),
    none)
  const cuts = await readPendingTurnEnds(reader, [...histories.values()].flatMap(({ runs }) =>
    runs.flatMap((run) => run.status === "paused" && run.conversationId ? [run.conversationId] : [])))
  for (const [childSessionId, { runs, latestRunId }] of histories) {
    let active = context.index.activeByChild.get(childSessionId) ?? 0
    const activeRuns = context.index.activeByRun.get(childSessionId) ?? new Map<string, boolean>()
    for (const run of runs) {
      if (
        run.childSessionId !== childSessionId
        || run.parentSessionId !== input.parentSessionId
        || !run.parentConversationId
        || !run.parentToolUseId
      ) continue
      const wasActive = activeRuns.get(run.childRunId) ?? false
      const cut = run.status === "paused" ? subagentRunCut(run, run.conversationId ? cuts.get(run.conversationId) : undefined) : undefined
      const isActive = run.status === "created" || (cut?.kind === "interrupt" && cut.by === "person")
      active += Number(isActive) - Number(wasActive)
      activeRuns.set(run.childRunId, isActive)
      if (run.status === "created") {
        continue
      }
      if (run.status === "paused") {
        continue
      }
      if (run.status === "interrupted" && run.interruptionReason === "runtime_restarted") continue
      pending.push({
        childSessionId,
        run,
        settlesLifecycle: run.childRunId === latestRunId,
        toolUseId: run.parentToolUseId,
        result: childSessionBackgroundResult(run),
      })
    }
    context.index.active += active - (context.index.activeByChild.get(childSessionId) ?? 0)
    context.index.activeByChild.set(childSessionId, active)
    context.index.activeByRun.set(childSessionId, activeRuns)
  }
  const toolsById = await readParentTools(context, pending.map(({ toolUseId }) => toolUseId))
  const candidates = pending.flatMap(({ toolUseId, ...candidate }) => {
    const tool = toolsById.get(toolUseId)
    if (!tool || tool.toolName !== "subagent" || tool.traceKind !== "subagent" || !tool.childHasOwnViewport) return []
    durableTerminalChildSessionIds.add(candidate.childSessionId)
    return [{ ...candidate, tool }]
  })

  let reconciledCount = 0
  const byConversation = new Map<string, SubagentCompletionCandidate[]>()
  for (const candidate of candidates) {
    const conversationId = candidate.run.parentConversationId
    if (!conversationId) continue
    const group = byConversation.get(conversationId) ?? []
    group.push(candidate)
    byConversation.set(conversationId, group)
  }
  for (const [conversationId, group] of byConversation) {
    reconciledCount += await publishSubagentCompletions(context, conversationId, group, context.index.active)
  }
  return {
    reconciledCount,
    durableTerminalChildSessionIds: [...durableTerminalChildSessionIds],
    seededChildSessionIds: [...histories.keys()].filter((id) => !context.index.seenChildren.has(id)),
  }
}

async function publishSubagentCompletions(
  context: ReconciliationContext,
  conversationId: string,
  candidates: readonly SubagentCompletionCandidate[],
  remainingActive: number,
): Promise<number> {
  const { input } = context
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    const reader = input.projectionReader ?? input.reader
    // Bind publication to a sequence read before the evidence. A Stop can
    // settle a parent call outside this reconciliation's ordered lane.
    const parentExpectedSeq = await reader.aggregateSeq(`session:${input.parentSessionId}`) + 1
    const tree = await readChildCompletionConversation(context, input.parentSessionId, conversationId)
    if (!tree) return 0
    const state = await tree.getState()
    const currentTools = await readParentTools(context, candidates.map(({ tool }) => tool.toolUseId))
    const currentCandidates = candidates.flatMap((candidate) => {
      const tool = currentTools.get(candidate.tool.toolUseId)
      return tool ? [{ ...candidate, tool }] : []
    })
    const held = await reader.readInFlight(input.parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
    const notificationCandidates = currentCandidates.filter((candidate) =>
      !hasDurableSubagentNotificationEvidence(state.completedNotificationRunIds, held, candidate.run.childRunId))
    const missingResults = currentCandidates.filter((candidate) =>
      candidate.tool.status === "called" || candidate.tool.status === "interrupted")
    if (notificationCandidates.length === 0 && missingResults.length === 0) {
      tree.getStorage().dispose()
      return 0
    }

    const notification = notificationCandidates.length > 0
      ? durableSubagentCompletionNotification(notificationCandidates.map((candidate) => ({
          childRunId: candidate.run.childRunId,
          type: "subagent",
          description: candidate.run.description,
          toolUseId: candidate.run.parentToolUseId,
          sessionId: candidate.childSessionId,
          result: candidate.result,
        })), remainingActive)
      : null
    const resultAppends: GuardedEventStoreAppend[] = missingResults.map((candidate, index) => ({
      ...prepareSessionFactAppend(
        input.parentSessionId,
        childSessionResultFact(candidate.tool, candidate.result.content, subagentToolOutcome(candidate.run)),
      ),
      expectedSeq: parentExpectedSeq + index,
    }))
    if (notification && resultAppends.length > 0) {
      const last = resultAppends.at(-1)
      if (!last) throw new Error("Subagent completion batch has no terminal append")
      resultAppends[resultAppends.length - 1] = {
        ...last,
        inFlight: [{
          op: "put",
          kind: QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND,
          key: notification.key,
          payload: { conversationId, text: notification.text },
        }],
      }
    }
    const now = new Date().toISOString()
    const latestCandidateByChild = new Map<string, SubagentCompletionCandidate>()
    for (const candidate of candidates) {
      if (candidate.settlesLifecycle) latestCandidateByChild.set(candidate.childSessionId, candidate)
    }
    const lifecycleAppends = await prepareLifecycleAppends(context, [...latestCandidateByChild.values()], now)
    const appends: GuardedEventStoreAppend[] = [...resultAppends, ...lifecycleAppends]
    tree.getStorage().dispose()
    if (appends.length > 0) {
      const result = await requireGuardedEventAppender(input.writer, "Child reconciliation requires guarded append authority").appendBatchGuarded(appends)
      if (result.kind === "conflict") {
        const child = [...latestCandidateByChild.keys()].some((id) => result.conflict.aggregateId === `session:${id}`)
        if ((!child && !isRetryableConflict(result.conflict, input.parentSessionId, conversationId)) || attempt === MAX_CONFLICT_RETRIES) {
          throw new Error("Subagent completion reconciliation stayed contended", { cause: result.conflict })
        }
        continue
      }
    }
    if (notification && resultAppends.length === 0) {
      if (!input.writer.putInFlight) throw new Error("Child completion reconciliation requires durable in-flight notification writes")
      await input.writer.putInFlight(
        input.parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, notification.key,
        { conversationId, text: notification.text },
      )
    }
    if (notification) await offerChildCompletion(input, notification)
    return new Set([...missingResults, ...notificationCandidates].map((candidate) => candidate.run.childRunId)).size
  }
  return 0
}

/** The appends that mark each child inactive whose newest run `candidates`
 *  settles. Each guard sequence is read before the evidence, so an append
 *  conflicts with any child fact that the evidence did not see, such as a
 *  run that started since the candidates were read. */
async function prepareLifecycleAppends(context: ReconciliationContext, candidates: readonly SubagentCompletionCandidate[], now: string): Promise<GuardedEventStoreAppend[]> {
  if (candidates.length === 0) return []
  const reader = context.input.projectionReader ?? context.input.reader
  const sequences = await Promise.all(candidates.map((candidate) => reader.aggregateSeq(`session:${candidate.childSessionId}`)))
  const current = await installedChildSessionHistory().readParentReconciliationRuns(reader, context.input.parentSessionId,
    new Map(candidates.map((candidate) => [candidate.childSessionId, undefined])))
  const appends = await Promise.all(candidates.map(async (candidate, index) => {
    const runs = current.get(candidate.childSessionId)
    const latest = runs?.runs.find((run) => run.childRunId === runs.latestRunId)
    if (latest?.childRunId !== candidate.run.childRunId || latest.status !== candidate.run.status) return null
    const session = await readSession(context, candidate.childSessionId)
    if (session?.lifecycleState !== "active") return null
    return {
      ...buildSessionMetadataAppend(candidate.childSessionId, {
        type: "session.lifecycle.changed",
        version: 1,
        actor: "flywheel",
        payload: { lifecycleState: "inactive", lastUpdated: now },
      }),
      expectedSeq: (sequences[index] ?? 0) + 1,
    }
  }))
  return appends.filter((append) => append !== null)
}

function subagentToolOutcome(run: ChildSessionRun): ToolOutcome {
  if (run.status === "completed" || run.status === "partial") return "ok"
  if (run.status === "cancelled" || run.status === "stopped") return run.status
  if (run.status === "interrupted") return "interrupted"
  return "error"
}

async function reconcileChild(
  context: ReconciliationContext,
  parent: ReplayedSession,
  childSessionId: string,
  child: WorkflowRunRecord,
  measurement: ReconciliationMeasurement,
  initialCandidate: Awaited<ReturnType<typeof completionCandidate>>,
  parentToolSequence: number,
): Promise<ChildReconciliation> {
  const { input } = context
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    let candidate = attempt === 0 ? initialCandidate
      : await childReads.read(childSessionId, () => completionCandidate(context, parent, childSessionId, child, measurement), null)
    if (!candidate) return { wrote: false, durable: false }
    if (candidate.kind === "nonterminal") return { wrote: false, durable: false, linkedNonterminalToolUseId: candidate.toolUseId }
    if (candidate.kind === "delivered") return { wrote: false, durable: true }
    const reader = input.projectionReader ?? input.reader
    const parentExpectedSeq = await reader.aggregateSeq(`session:${input.parentSessionId}`) + 1
    // An unmoved aggregate proves the batched evidence is still current.
    // Any writer, including our preceding child, invalidates that evidence.
    const tool = attempt === 0 && parentExpectedSeq === parentToolSequence + 1 && candidate.kind === "terminal"
      ? candidate.tool
      : (await readParentTools(context, [child.launchedFrom?.toolUseId ?? ""])).get(child.launchedFrom?.toolUseId ?? "")
    if (!tool) return { wrote: false, durable: false }
    if (candidate.kind === "settled" || tool.resultEventId !== candidate.tool.resultEventId) {
      candidate = await childReads.read(childSessionId, () => completionCandidate(context, parent, childSessionId, child, measurement, tool), null)
      if (!candidate) return { wrote: false, durable: false }
      if (candidate.kind === "nonterminal") return { wrote: false, durable: false, linkedNonterminalToolUseId: candidate.toolUseId }
      if (candidate.kind === "delivered") return { wrote: false, durable: true }
    }
    if (candidate.kind === "settled") return await deliverSettledNotification(context, candidate)

    const tree = await readChildCompletionConversation(context, input.parentSessionId, candidate.conversationId)
    if (!tree) return { wrote: false, durable: false }
    const state = await tree.getState()
    const completion: WorkflowCompletionInput = {
      status: candidate.terminal.status,
      label: candidate.notificationLabel,
      sessionId: candidate.childSessionId,
      results: candidate.results,
      handoff: candidate.handoff,
      tree: candidate.terminal.tree,
      failedAgents: candidate.failedAgents,
      resumable: candidate.resumable,
      reason: candidate.reason,
    }
    const message = workflowCompletionContent(completion)
    // A result that an earlier build recorded in its own words is current
    // while the run is unchanged, so only a run that changed since, such as
    // a resumed one, gets a corrected result and a new completion.
    const recorded = [message, terminalOnlyCompletionContent(completion)]
    const isRecordedCompletion = (entry: Parameters<typeof isCompletionEntry>[0]): boolean => recorded.some((words) => isCompletionEntry(entry, words))
    const notificationId = `workflow-completion:${childSessionId}`
    const expectedOutcome = "ok"
    const expectedContent = contentEvidence(message)
    const resultMissing = candidate.tool.status === "called" || candidate.tool.status === "interrupted"
    const priorResultEventId = candidate.tool.resultEventId
    const resultCorrection = !resultMissing && !candidate.unchangedSinceResult
      && priorResultEventId !== undefined
      && (candidate.tool.resultOutcome !== expectedOutcome || !recorded.some((words) => candidate.tool.contentSha256 === contentEvidence(words).sha256))
    const existingBaseEntry = state.entriesById[notificationId]
    if (candidate.unchangedSinceResult && existingBaseEntry) {
      tree.getStorage().dispose()
      return { wrote: false, durable: true, terminalSequence: candidate.terminal.aggregateSeq }
    }
    const entryId = existingBaseEntry && isRecordedCompletion(existingBaseEntry)
      ? notificationId
      : workflowCompletionEntryId(childSessionId, candidate.terminal.aggregateSeq, message, existingBaseEntry)
    const existingEntry = state.entriesById[entryId]
    if (existingEntry && !isRecordedCompletion(existingEntry)) {
      tree.getStorage().dispose()
      return { wrote: false, durable: false }
    }
    const notificationHeld = (await (input.projectionReader ?? input.reader).readInFlight(
      input.parentSessionId,
      QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND,
    )).some((row) => row.key === entryId)
    const deliveredAsHistory = state.entriesById[historicalCompletionEntryId(childSessionId)] !== undefined
    const durable = existingEntry !== undefined || deliveredAsHistory
    if (!durable) context.index.pendingWorkflows.set(childSessionId, { conversationId: candidate.conversationId, key: entryId, sequence: candidate.terminal.aggregateSeq })
    const delivery = !durable && !notificationHeld ? { key: entryId, text: message } : null
    tree.getStorage().dispose()
    if (!resultMissing && !resultCorrection && !delivery) return {
      wrote: false, durable, terminalSequence: candidate.terminal.aggregateSeq,
    }
    const appends: GuardedEventStoreAppend[] = []
    if (resultMissing) {
      const fact = childSessionResultFact(candidate.tool, message, expectedOutcome)
      const extracted = extractToolContentFact(fact)
      appends.push({
        ...prepareSessionFactAppend(input.parentSessionId, extracted.fact, extracted.contentRows),
        expectedSeq: parentExpectedSeq,
      })
    }
    if (resultCorrection) {
      appends.push({
        ...prepareSessionFactAppend(input.parentSessionId, {
          type: "workflow.tool_result.corrected",
          version: 1,
          actor: "flywheel",
          payload: {
            toolUseId: candidate.tool.toolUseId,
            childSessionId,
            workflowDefinitionId: candidate.workflowDefinitionId,
            description: candidate.description,
            priorResultEventId,
            outcome: expectedOutcome,
            ...expectedContent,
          },
        }),
        expectedSeq: parentExpectedSeq,
      })
    }
    if (delivery && appends.length > 0) {
      const last = appends.at(-1)
      if (!last) throw new Error("Workflow completion batch has no terminal append")
      appends[appends.length - 1] = {
        ...last,
        inFlight: [{
          op: "put",
          kind: QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND,
          key: delivery.key,
          payload: { conversationId: candidate.conversationId, text: delivery.text },
        }],
      }
    }

    if (appends.length > 0) {
      const result = await requireGuardedEventAppender(input.writer, "Child reconciliation requires guarded append authority").appendBatchGuarded(appends)
      if (result.kind === "conflict") {
        if (!isRetryableConflict(result.conflict, input.parentSessionId, candidate.conversationId) || attempt === MAX_CONFLICT_RETRIES) {
          throw new Error("Child workflow reconciliation stayed contended", { cause: result.conflict })
        }
        continue
      }
    }
    if (delivery && appends.length === 0) {
      if (!input.writer.putInFlight) throw new Error("Child completion reconciliation requires durable in-flight notification writes")
      await input.writer.putInFlight(
        input.parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, delivery.key,
        { conversationId: candidate.conversationId, text: delivery.text },
      )
    }
    if (delivery) await offerChildCompletion(input, delivery, sweepAfterCommit(input))
    return {
      wrote: true, durable, terminalSequence: candidate.terminal.aggregateSeq,
    }
  }
  return { wrote: false, durable: false }
}

/** Holds and delivers the notification a settled child owes its parent,
 *  once. The Stop or the start failure itself committed the tool result;
 *  this is the part a restart between the two may have left undone. */
async function deliverSettledNotification(context: ReconciliationContext, candidate: SettledCandidate): Promise<ChildReconciliation> {
  const { input } = context
  const tree = await readChildCompletionConversation(context, input.parentSessionId, candidate.conversationId)
  if (!tree) return { wrote: false, durable: false }
  const state = await tree.getState()
  const baseId = `workflow-completion:${candidate.childSessionId}`
  const baseEntry = state.entriesById[baseId]
  const heldRows = await (input.projectionReader ?? input.reader).readInFlight(input.parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
  // The parent already read or still holds an earlier outcome of this call,
  // such as the start failure before a Resume; a different one is new.
  const heldBase = heldRows.find((row) => row.key === baseId)
  const priorDiffers = baseEntry ? !isCompletionEntry(baseEntry, candidate.content) : heldBase !== undefined && heldBase.payload.text !== candidate.content
  const entryId = priorDiffers ? revisedCompletionEntryId(candidate.childSessionId, candidate.revision, candidate.content) : baseId
  const existing = state.entriesById[entryId] ?? state.entriesById[historicalCompletionEntryId(candidate.childSessionId)]
  if (!existing) context.index.pendingWorkflows.set(candidate.childSessionId, { conversationId: candidate.conversationId, key: entryId })
  tree.getStorage().dispose()
  const held = heldRows.some((row) => row.key === entryId)
  if (existing || held) return { wrote: false, durable: existing !== undefined }
  if (!input.writer.putInFlight) throw new Error("Child completion reconciliation requires durable in-flight notification writes")
  const payload = { conversationId: candidate.conversationId, text: candidate.content }
  await input.writer.putInFlight(input.parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, entryId, payload)
  const notification = { key: entryId, text: candidate.content }
  await offerChildCompletion(input, notification, sweepAfterCommit(input))
  return { wrote: true, durable: false }
}

/** The parent's next sweep, which finds a delivered workflow completion
 *  committed and acknowledges it to the workflow's runner. */
function sweepAfterCommit(input: ReconcileChildSessionCompletionsInput): () => Promise<void> {
  return async () => { await reconcileChildSessionCompletions(input) }
}

// The metadata projection is the one reader of session rows (ARCH-SUBSTRATE-012): it
// salvages every creation version a store can hold and errors the session
// when an identity row is unreadable. Reconciliation runs on every activation,
// so a stricter pass here would refuse every session written before the
// current `session.created` version.
async function readSession(context: Pick<ReconciliationContext, "input">, sessionId: string): Promise<ReplayedSession | null> {
  const state = await createSingleSessionMetadataProjection(context.input.projectionReader ?? context.input.reader, sessionId).replay()
  if (state.deleted[sessionId] || state.errors[sessionId]) return null
  return state.sessions[sessionId] ?? null
}

function isRetryableConflict(conflict: AggregateSeqConflict, parentSessionId: string, conversationId: string): boolean {
  return conflict.aggregateId === `session:${parentSessionId}` || conflict.aggregateId === `conversation:${conversationId}`
}

