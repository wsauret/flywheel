import { createEventProjection, parseProjectionFact, reduceEvents } from "../../infra/projection/event-projection.js"
import { heldProjection } from "../../infra/projection/projection-registry.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/store/event-store-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { Schema } from "effect"
import { attemptIdOf, parseWorkflowQueueFact } from "./view-facts.js"
import { attemptRowFromV9, mutationFromV9, WorkflowRowsSchema, workflowRowsFromV9, type WorkflowPlanSchema, type WorkflowTreeV1Schema } from "./schemas.js"
import type { AttemptRow, AttemptStatus, MutationLogEntry, WorkflowView } from "./types.js"
import type { WorkflowTree, WorkflowTreeNode } from "../../protocol/session/workflow-view-protocol-types.js"
import { workflowProjectionBoundary } from "../control-facts/session-fact-source.js"
import { parseWorkflowControlFact } from "../control-facts/family.js"
import { workflowAggregateId } from "../run/run-facts.js"

type RawQueue = Omit<WorkflowView, "tree">

/** A row fact whose body this build cannot read. No other fact restates the
 *  rows it held, so the view cannot be built until a later `queue.created`
 *  replaces every row. */
export interface UnreadableRowFact {
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

function reduceQueueEvent(state: QueueProjectionState, event: StoredFact): QueueProjectionState {
  // The rows stay unreadable until a new `queue.created` replaces them.
  if (state.unreadableRows && event.type !== "queue.created") return state
  if (event.type === "attempt.succeeded" || event.type === "attempt.failed" || event.type === "attempt.retry_inserted") {
    const outcome = parseProjectionFact(event, parseWorkflowControlFact)
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
