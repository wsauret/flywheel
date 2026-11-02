import { createEventProjection, parseProjectionFact, reduceEvents } from "../../infra/event-projection.js"
import { heldProjection } from "../../infra/projection-registry.js"
import type { AsyncEventStateReadSurface, StoredFact, CorruptEventRowError } from "../../infra/event-store-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { Schema } from "effect"
import { attemptIdOf, parseWorkflowQueueFact } from "./view-facts.js"
import { attemptRowFromV9, mutationFromV9, WorkflowPlanSchema, WorkflowRowsSchema, workflowRowsFromV9, WorkflowTreeV1Schema, WorkflowViewSchema } from "./schemas.js"
import type { AttemptRow, AttemptStatus, MutationLogEntry, WorkflowView } from "./types.js"
import type { WorkflowTree, WorkflowTreeNode } from "../../protocol/workflow-view-protocol-types.js"
import { workflowProjectionBoundary } from "../session-fact-source.js"
import { parseWorkflowSessionFact, workflowAggregateId } from "../vm/session-facts.js"
import { workflowFamilyEvents } from "../workflow-root.js"
import { historicalWorkflowTree } from "./view-history-tree.js"


type RawQueue = Omit<WorkflowView, "tree">

/** A row fact whose body this build cannot read. No other fact restates the
 *  rows it held, so the view cannot be built until a later `queue.created`
 *  replaces every row. */
interface UnreadableRowFact {
  readonly type: string
  readonly version: number
  readonly position: number
  readonly aggregateId: string
  readonly detail: string
}

export interface QueueProjectionState extends Record<string, unknown> {
  queue: RawQueue | null
  /** Identity of retained tree evidence, shared by row-only live changes. */
  historicalTreeSource?: object
  /** The last tree the run recorded: a current one, or one before version
   *  4, which the reader rebuilds from control. */
  tree?: { readonly version: 4; readonly tree: WorkflowTree } | { readonly version: 1 | 2 | 3; readonly tree: typeof WorkflowTreeV1Schema.Type }
  /** The newest change of each node since the last tree, by node id, and
   *  the current agent that the newest change named. They replace the
   *  nodes of the tree that the reader holds: the stored one, or the one it
   *  rebuilds from control. */
  treeChanges?: { readonly nodes: ReadonlyMap<string, WorkflowTreeNode>; readonly currentAgentNodeId: string | null }
  historicalPlan?: typeof WorkflowPlanSchema.Type
  unreadableRows?: UnreadableRowFact
}

export const QUEUE_FACT_TYPES = [
  "attempt.succeeded",
  "attempt.failed",
  "attempt.retry_inserted",
  "queue.created",
  "queue.deleted",
  "queue.mutated",
  "queue.state.changed",
  "queue.plan.changed",
  "queue.tree.changed",
  "queue.tree.node.changed",
  "step.status.changed",
  "step.resume_state.recorded",
  "step.resume_revert.recorded",
  "follow_up.resume_state.recorded",
] as const

export const QUEUE_STATUS_FACT_TYPES = [
  "queue.created",
  "queue.deleted",
  "queue.state.changed",
] as const

export function createWorkflowQueueProjection(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
): ReturnType<typeof createEventProjection<QueueProjectionState>> {
  const aggregateId = workflowAggregateId(sessionId)
  const projection = heldProjection(reader, `workflow-queue:${sessionId}`, () => createEventProjection(reader, {
    aggregateId,
    factTypes: QUEUE_FACT_TYPES,
    resetBoundary: workflowProjectionBoundary(reader, aggregateId),
    initialState,
    reduce: reduceQueueEvent,
    reduceUnreadableFact: salvageUnreadableQueueFact,
  }))
  return projection
}

/** Rebuild an absent tree, or a tree before version 4, from control,
 *  without changing immutable facts or execution authority. Both
 *  event-array and held readers cross this boundary. Remove the rebuild
 *  after 2027-04-30. */
export function queueFromProjection(state: QueueProjectionState, events: readonly (StoredFact | CorruptEventRowError)[] = []): WorkflowView | null {
  if (state.unreadableRows) throw unreadableRowsViolation(state.unreadableRows)
  if (state.queue === null) return null
  const tree = state.tree?.version === 4
    ? state.tree.tree
    : historicalWorkflowTree(state.queue, state.tree?.tree, state.historicalPlan, events)
  return Schema.decodeUnknownSync(WorkflowViewSchema, { onExcessProperty: "error" })({ ...state.queue, tree: withTreeChanges(tree, state.treeChanges) })
}

/** The tree with each node that a later change replaced. */
function withTreeChanges(tree: WorkflowTree, changes: QueueProjectionState["treeChanges"]): WorkflowTree {
  if (!changes) return tree
  const { currentAgentNodeId: _current, ...rest } = tree
  return {
    ...rest,
    nodes: tree.nodes.map((node) => changes.nodes.get(node.id) ?? node),
    ...(changes.currentAgentNodeId === null ? {} : { currentAgentNodeId: changes.currentAgentNodeId }),
  }
}

const normalizedViews = new WeakMap<QueueProjectionState, Promise<WorkflowView | null>>()
const normalizedTrees = new WeakMap<object, Promise<WorkflowTree>>()

/** Current proposals write a v4 fact when the tree changes. A retained tree
 *  therefore needs one reconstruction, shared across row-only live states. */
export function normalizedWorkflowView(reader: AsyncEventStateReadSurface, sessionId: string, state: QueueProjectionState, upperPosition: number): Promise<WorkflowView | null> {
  const existing = normalizedViews.get(state)
  if (existing) return existing
  const normalized = (async () => {
    if (state.queue === null || state.unreadableRows || state.tree?.version === 4) return queueFromProjection(state)
    const source = state.historicalTreeSource ?? state
    let tree = normalizedTrees.get(source)
    if (!tree) {
      tree = normalizeHistoricalTree(reader, sessionId, state, upperPosition)
      normalizedTrees.set(source, tree)
      void tree.catch(() => { normalizedTrees.delete(source) })
    }
    return queueFromProjection({ ...state, tree: { version: 4, tree: await tree } })
  })()
  normalizedViews.set(state, normalized)
  void normalized.catch(() => { normalizedViews.delete(state) })
  return normalized
}

/** Reconstruct one retained tree before current live proposals replace it. */
async function normalizeHistoricalTree(reader: AsyncEventStateReadSurface, sessionId: string, state: QueueProjectionState, upperPosition: number): Promise<WorkflowTree> {
  const { facts } = await reader.readSlice({ aggregateId: workflowAggregateId(sessionId), beforePosition: upperPosition + 1 }, true)
  // SAFETY: only a readable, nonempty historical queue reaches reconstruction.
  return queueFromProjection(state, facts)!.tree
}

export interface LiveWorkflowView {
  read(): Promise<WorkflowView | null>
  apply(events: StoredFact | readonly StoredFact[]): Promise<void>
}

/** Push-fed and replaying views share state-identity normalization. */
function workflowView(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
  projection: ReturnType<typeof createEventProjection<QueueProjectionState>>,
  freshen: () => Promise<QueueProjectionState>,
): LiveWorkflowView {
  return {
    async read() {
      const state = await freshen()
      return normalizedWorkflowView(reader, sessionId, state, projection.getReadPosition())
    },
    async apply(event) {
      await projection.apply(event)
    },
  }
}

/**
 * Push-fed sibling of loadQueueSnapshotFromReader for hot read paths. The
 * projection seeds from SQLite once at creation; after that the OWNER feeds
 * every stored queue and root batch through `apply` (the store's post-commit `onStored`
 * broadcast), so `read()` touches no SQL at all. Use this only where such an
 * owner exists: with no one feeding it, `read()` returns the seed forever.
 * A seed that fails is not kept: the next `read()` seeds again.
 */
export function createLiveWorkflowView(reader: AsyncEventStateReadSurface, sessionId: string): LiveWorkflowView {
  const projection = createWorkflowQueueProjection(reader, sessionId)
  let seed: Promise<QueueProjectionState> | undefined
  return workflowView(reader, sessionId, projection, async () => {
    seed ??= projection.replay()
    const seeding = seed
    try {
      await seeding
    } catch (error) {
      if (seed === seeding) seed = undefined
      throw error
    }
    return projection.getState()
  })
}

/**
 * Pull-fed sibling for a reader with no owner feeding it stored facts, which
 * is what a long-lived background reader is. `read()` replays, and replay
 * compares against the live SQLite position and folds only what is new, so a
 * repeated read costs a position check rather than a fold of the whole
 * aggregate from zero. Rebuilding the projection per call instead is what made
 * one background sweep re-read every workflow session's whole history on every
 * pass.
 */
export function createReplayingWorkflowView(reader: AsyncEventStateReadSurface, sessionId: string): LiveWorkflowView {
  const projection = createWorkflowQueueProjection(reader, sessionId)
  return workflowView(reader, sessionId, projection, () => projection.replay())
}

export function loadQueueFromEvents(events: readonly StoredFact[]): WorkflowView | null {
  return queueFromProjection(foldQueueFacts(workflowFamilyEvents(events)), events)
}

/** Folds family facts into a queue state with the one queue reducer and its
 *  salvage rules. A caller that holds a state passes it as `from` and folds
 *  only the facts after it. */
export function foldQueueFacts(events: readonly StoredFact[], from: QueueProjectionState = initialState()): QueueProjectionState {
  return reduceEvents(events, {
    initialState: () => from,
    reduce: reduceQueueEvent,
    reduceUnreadableFact: salvageUnreadableQueueFact,
    factTypes: QUEUE_FACT_TYPES,
  })
}

export function loadWorkflowStateFromEvents(events: readonly StoredFact[]): WorkflowView["status"] | undefined {
  let queueExists = false
  let status: WorkflowView["status"] | undefined
  let missingCreation: StoredFact | null = null
  for (const event of workflowFamilyEvents(events)) {
    if (!QUEUE_STATUS_FACT_TYPES.some((type) => type === event.type)) continue
    const fact = parseProjectionFact(event, parseWorkflowQueueFact)
    switch (fact.type) {
      case "queue.created":
        queueExists = true
        missingCreation = null
        status = fact.version === 9 ? fact.payload.queue.status : fact.payload.rows.status
        break
      case "queue.deleted":
        queueExists = false
        missingCreation = null
        status = undefined
        break
      case "queue.state.changed":
        if (queueExists) status = fact.payload.status
        else missingCreation = event
        break
    }
  }
  if (missingCreation) throw missingQueue(missingCreation)
  return status
}

function initialState(): QueueProjectionState {
  return { queue: null }
}

/** The workflow view's salvage rules for a fact whose body this build cannot
 *  read. The fact keeps its bytes. The tree, its node changes, and the plan
 *  only describe control, so an unreadable one folds as absent and the view rebuilds the
 *  tree from control, as it does for a run that never recorded one. A tool
 *  use count only decorates an attempt row, so an unreadable attempt outcome
 *  leaves the row as it was. Any other fact holds rows that no other fact
 *  restates, so the view records the fact as a typed gap and is unavailable
 *  until a later `queue.created` replaces every row. Every reader of the
 *  view then reports the gap for this session only. */
function salvageUnreadableQueueFact(state: QueueProjectionState, event: StoredFact, violation: InvariantViolation): QueueProjectionState {
  switch (event.type) {
    // An unreadable node change leaves the stored tree stale at that node,
    // so the view drops it and rebuilds the tree from control.
    case "queue.tree.changed":
    case "queue.tree.node.changed": {
      const { tree: _tree, treeChanges: _changes, ...rest } = state
      return { ...rest, historicalTreeSource: {} }
    }
    case "queue.plan.changed": {
      const { historicalPlan: _plan, ...rest } = state
      return { ...rest, historicalTreeSource: {} }
    }
    case "attempt.succeeded":
    case "attempt.failed":
    case "attempt.retry_inserted":
      return state
    default:
      return {
        queue: null,
        unreadableRows: { type: event.type, version: event.version, position: event.position, aggregateId: event.aggregateId, detail: violation.detail },
      }
  }
}

function unreadableRowsViolation(fact: UnreadableRowFact): InvariantViolation {
  return new InvariantViolation({ kind: "schema-mismatch", eventType: fact.type, eventVersion: fact.version, eventPosition: fact.position, aggregateId: fact.aggregateId, detail: fact.detail })
}

function reduceQueueEvent(state: QueueProjectionState, event: StoredFact): QueueProjectionState {
  // The rows stay unreadable until a new `queue.created` replaces them.
  if (state.unreadableRows && event.type !== "queue.created") return state
  if (event.type === "attempt.succeeded" || event.type === "attempt.failed" || event.type === "attempt.retry_inserted") {
    const outcome = parseProjectionFact(event, parseWorkflowSessionFact)
    switch (outcome.type) {
      case "attempt.succeeded":
      case "attempt.failed":
      case "attempt.retry_inserted": {
        if (!("toolUses" in outcome.payload)) return state
        const { attemptId, toolUses } = outcome.payload
        return { ...state, queue: updateAttempt(requireQueue(state.queue, event), attemptId, event, (attempt) => ({ ...attempt, toolUses })) }
      }
    }
  }
  const fact = parseProjectionFact(event, parseWorkflowQueueFact)

  switch (fact.type) {
    case "queue.created":
      return { queue: fact.version === 9 ? workflowRowsFromV9(fact.payload.queue) : Schema.decodeUnknownSync(WorkflowRowsSchema, { onExcessProperty: "error" })(fact.payload.rows), historicalTreeSource: {} }
    case "queue.deleted":
      return { queue: null }
    case "queue.mutated":
      return { ...state, historicalTreeSource: {}, queue: applyMutation(requireQueue(state.queue, event), fact.version === 9
        ? {
          mutation: mutationFromV9(fact.payload.mutation),
          insertions: contiguousInsertions(fact.payload.insertedSteps?.map(attemptRowFromV9), fact.payload.insertIndex),
          ...(fact.payload.removedStepIds === undefined ? {} : { removedAttemptIds: fact.payload.removedStepIds }),
        }
        : fact.version === 10
          ? {
            mutation: fact.payload.mutation,
            insertions: contiguousInsertions(fact.payload.insertedAttempts, fact.payload.insertIndex),
            ...(fact.payload.removedAttemptIds === undefined ? {} : { removedAttemptIds: fact.payload.removedAttemptIds }),
          }
          : fact.payload) }
    case "queue.state.changed":
      return { ...state, queue: applyRunState(requireQueue(state.queue, event), fact.payload.status, fact.payload.cursor, fact.version === 1 ? fact.payload.maxSteps : fact.payload.maxAttempts) }
    case "queue.plan.changed":
      requireQueue(state.queue, event)
      return { ...state, historicalPlan: fact.payload.plan, historicalTreeSource: {} }
    case "queue.tree.changed": {
      requireQueue(state.queue, event)
      const { treeChanges: _changes, ...rest } = state
      return { ...rest, historicalTreeSource: {}, tree: fact.version === 4 ? { version: 4, tree: fact.payload.tree } : { version: fact.version, tree: fact.payload.tree } }
    }
    case "queue.tree.node.changed": {
      requireQueue(state.queue, event)
      const nodes = new Map(state.treeChanges?.nodes)
      nodes.set(fact.payload.node.id, fact.payload.node)
      return { ...state, treeChanges: { nodes, currentAgentNodeId: fact.payload.currentAgentNodeId } }
    }
    case "step.status.changed":
      return { ...state, queue: updateAttempt(requireQueue(state.queue, event), attemptIdOf(fact), event, (attempt) => timedStatus(attempt, fact.payload.status, event.timestamp)) }
    case "step.resume_state.recorded":
      return { ...state, queue: updateResumeState(requireQueue(state.queue, event), attemptIdOf(fact), fact.payload.conversationId, event) }
    case "step.resume_revert.recorded":
      return { ...state, queue: updateAttempt(requireQueue(state.queue, event), attemptIdOf(fact), event, (attempt) => ({ ...attempt, resumeRevertCount: fact.payload.count })) }
    case "follow_up.resume_state.recorded":
      return { ...state, queue: applyFollowUpResumeState(requireQueue(state.queue, event), fact.payload.conversationId) }
  }
}

const SETTLED_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set(["completed", "failed", "skipped", "blocked"])

/** The attempt with its new status and the time the status changed. An
 *  attempt keeps the time it first ran across an interrupt, so its duration
 *  covers all of its work; it is settled from its latest settled status. */
function timedStatus(attempt: AttemptRow, status: AttemptStatus, timestamp: number): AttemptRow {
  const { completedAt: _completedAt, ...unsettled } = attempt
  if (SETTLED_ATTEMPT_STATUSES.has(status)) return { ...unsettled, status, completedAt: timestamp }
  return status === "running" ? { ...unsettled, status, startedAt: attempt.startedAt ?? timestamp } : { ...unsettled, status }
}

function applyFollowUpResumeState(queue: RawQueue, conversationId: string | null): RawQueue {
  const next = cloneQueue(queue)
  if (conversationId === null) delete next.followUpConversationId
  else next.followUpConversationId = conversationId
  return next
}

function missingQueue(event: StoredFact): InvariantViolation {
  return new InvariantViolation({
    kind: "missing-producer-event",
    eventType: event.type,
    eventPosition: event.position,
    aggregateId: event.aggregateId,
    detail: `queue.created has not been observed before ${event.type}`,
  })
}

function requireQueue(queue: RawQueue | null, event: StoredFact): RawQueue {
  if (queue) return queue
  throw missingQueue(event)
}

function requireAttempt(queue: RawQueue, attemptId: string, event: StoredFact): number {
  const index = queue.attempts.findIndex((attempt) => attempt.id === attemptId)
  if (index >= 0) return index
  throw new InvariantViolation({
    kind: "missing-producer-event",
    eventType: event.type,
    eventPosition: event.position,
    aggregateId: event.aggregateId,
    detail: `attempt ${attemptId} is not in the rows (${event.type})`,
  })
}

/** The insertions of a version 9 or 10 fact, which stored its rows as one
 *  run at one index and appended them when it stored no index. Remove after
 *  2027-04-30 with those versions. */
function contiguousInsertions(attempts: readonly AttemptRow[] | undefined, insertIndex: number | undefined): readonly { index: number; attempt: AttemptRow }[] {
  return (attempts ?? []).map((attempt, offset) => ({ index: (insertIndex ?? Number.MAX_SAFE_INTEGER) + offset, attempt }))
}

function applyMutation(
  queue: RawQueue,
  payload: {
    readonly mutation: MutationLogEntry
    readonly insertions?: readonly { readonly index: number; readonly attempt: AttemptRow }[]
    readonly removedAttemptIds?: readonly string[]
  },
): RawQueue {
  // No reader-side dedup: duplicate facts are producer bugs, not conditions to
  // repair in the projection (ARCH-BOUNDARIES-004).
  const next = cloneQueue(queue)
  let attempts = [...next.attempts]
  if (payload.removedAttemptIds) {
    const removed = new Set(payload.removedAttemptIds)
    attempts = attempts.filter((attempt) => !removed.has(attempt.id))
  }
  // Earlier versions clamped their index to the rows, so an index past the
  // end appends.
  for (const { index, attempt } of payload.insertions ?? []) attempts.splice(Math.min(index, attempts.length), 0, attempt)
  next.attempts = attempts
  next.mutationLog = [...next.mutationLog, payload.mutation]
  return next
}

function applyRunState(queue: RawQueue, status: WorkflowView["status"], cursor: number, maxAttempts: number | null | undefined): RawQueue {
  const next = cloneQueue(queue)
  next.status = status
  next.cursor = cursor
  if (maxAttempts === null) delete next.maxAttempts
  else if (maxAttempts !== undefined) next.maxAttempts = maxAttempts
  return next
}

function updateResumeState(queue: RawQueue, attemptId: string, conversationId: string | null, event: StoredFact): RawQueue {
  return updateAttempt(queue, attemptId, event, (attempt) => {
    const { lastConversationId: _previous, ...rest } = attempt
    return conversationId === null ? rest : { ...rest, lastConversationId: conversationId }
  })
}

function updateAttempt(queue: RawQueue, attemptId: string, event: StoredFact, update: (attempt: AttemptRow) => AttemptRow): RawQueue {
  const index = requireAttempt(queue, attemptId, event)
  const attempts = [...queue.attempts]
  // SAFETY: requireAttempt returns the index of an existing row.
  attempts[index] = update(attempts[index]!)
  return { ...cloneQueue(queue), attempts }
}

function cloneQueue(queue: RawQueue): RawQueue {
  return { ...queue, attempts: [...queue.attempts], mutationLog: [...queue.mutationLog] }
}
