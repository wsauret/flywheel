import { CorruptEventRowError, type AsyncEventStateReadSurface, type AsyncEventWriter, type StoredFact } from "../../infra/event-store-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { createLiveWorkflowView, createWorkflowQueueProjection, QUEUE_STATUS_FACT_TYPES, normalizedWorkflowView } from "./view-projection.js"
import type { WorkflowView } from "./types.js"
import { selectWorkflowFactSource } from "../session-fact-source.js"
import { createEventProjection, parseProjectionFact } from "../../infra/event-projection.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { WORKFLOW_ROOT_FACT_TYPES, workflowFamilyBoundary } from "../workflow-root.js"
import { WORKFLOW_RUN_FACT_TYPES } from "../run-facts.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { parseWorkflowQueueFact } from "./view-facts.js"

interface WorkflowStateResult {
  statuses: Map<string, WorkflowView["status"] | undefined>
  errors: Array<{ sessionId: string; reason: string }>
}

/**
 * Read held queue lifecycle status for many sessions over a shared event store.
 * A retained queue stays readable when strict execution control needs recovery,
 * so this display index is separate from the recovery owner of strict control.
 *
 * `undefined` means "no queue facts" (e.g. a chat session that never ran a workflow).
 * Corrupt status facts surface as `errors[]` entries; the session id is omitted
 * from `statuses` so callers can render an error sentinel without conflating it
 * with the no-queue case.
 */
export async function readWorkflowStatees(
  sessionIds: readonly string[],
  reader: AsyncEventStateReadSurface,
): Promise<WorkflowStateResult> {
  const owner = workflowStatuses(reader)
  // Seeds and catch-ups run one at a time, so a seed never lands after a later fold of its workflow.
  const advance = owner.seeding.then(async () => {
    const state = await owner.replay()
    const unseeded = [...new Set(sessionIds)].filter((id) => !owner.seeded.has(id))
    // One tolerant read per new workflow keeps a damaged row inside its own
    // workflow; a read that names several aggregates refuses a damaged row.
    for (const id of unseeded) {
      const query = { aggregateId: `workflow:${id}` }
      for (let after = 0; ;) {
        const page = await reader.readPage(query, owner.getReadPosition(), after, true)
        for (const fact of page.facts) advanceWorkflowStatus(state, fact)
        if (page.continuationPosition === null) break
        after = page.continuationPosition
      }
      owner.seeded.add(id)
    }
    return state
  })
  owner.seeding = advance.then(() => undefined, () => undefined)
  const state = await advance
  const statuses = new Map<string, WorkflowView["status"] | undefined>()
  const errors: WorkflowStateResult["errors"] = []
  for (const sessionId of sessionIds) {
    const evidence = state.workflows.get(sessionId)
    if (evidence?.error) errors.push({ sessionId, reason: evidence.error })
    else statuses.set(sessionId, evidence?.status)
  }
  return { statuses, errors }
}

/** One cursor over every workflow aggregate, built at the position where it
 *  is first used. A workflow enters the index only when a reader names it,
 *  from one read of that workflow's own history, so the index holds the
 *  workflows that readers ask about and never reads the workspace's past.
 *  No index orders the `workflow:` family by position, so a cold read of the
 *  whole family would walk the full event table. */
function workflowStatuses(reader: AsyncEventStateReadSurface) {
  return heldProjection(reader, "workflow-statuses", () => {
    const seeded = new Set<string>()
    return Object.assign(createEventProjection<WorkflowStatuses>(reader, {
      name: "workflow-statuses",
      aggregatePrefix: "workflow:",
      tolerateScopedCorruption: true,
      initialState: () => ({ workflows: new Map() }),
      seed: async () => ({ state: { workflows: new Map() }, position: await reader.capturePosition() }),
      // This private index is never published, so a change updates its one workflow in place.
      draft: (state) => state,
      reduce: (state, event) => seeded.has(workflowIdOf(event)) ? advanceWorkflowStatus(state, event) : state,
      reduceCorruptRow: (state, row) => seeded.has(workflowIdOf(row)) ? advanceWorkflowStatus(state, row) : state,
    }), { seeding: Promise.resolve(), seeded })
  })
}

interface WorkflowStatuses {
  readonly workflows: Map<string, WorkflowStatusEvidence>
}

type StatusRow = StoredFact | CorruptEventRowError
interface ParsedStatusRow {
  readonly type: string
  readonly position: number
  readonly status?: WorkflowView["status"]
  readonly error?: string
}
interface WorkflowStatusEvidence {
  /** The position of the current root. The root's body is checked once on arrival and never retained. */
  readonly rootPosition?: number
  readonly rootError?: string
  readonly control: boolean
  readonly rows: readonly ParsedStatusRow[]
  readonly status?: WorkflowView["status"]
  readonly error?: string
}

/** Keep only the current root's verdict and the latest row of each status family.
 *  Superseded malformed rows do not poison a readable replacement. */
function workflowIdOf(event: StatusRow): string {
  return (event instanceof CorruptEventRowError ? event.row : event).aggregateId.slice("workflow:".length)
}

function advanceWorkflowStatus(state: WorkflowStatuses, event: StatusRow): WorkflowStatuses {
  const envelope = event instanceof CorruptEventRowError ? event.row : event
  if (!envelope.aggregateId.startsWith("workflow:")) return state
  const id = workflowIdOf(event)
  const previous: WorkflowStatusEvidence = state.workflows.get(id) ?? { control: false, rows: [] }
  const isRoot = WORKFLOW_ROOT_FACT_TYPES.some((type) => type === envelope.type)
  const rootPosition = isRoot ? event.position : previous.rootPosition
  const control = previous.control || !WORKFLOW_RUN_FACT_TYPES.some((type) => type === envelope.type)
  let rows = isRoot && envelope.type === "workflow.control.recovered" ? [] : previous.rows
  if (QUEUE_STATUS_FACT_TYPES.some((type) => type === envelope.type)) {
    rows = [...rows.filter((row) => row.type !== envelope.type), parseStatusRow(event)]
      .sort((a, b) => a.position - b.position)
  }
  if (!isRoot && control === previous.control && rows === previous.rows) return state
  let rootError = previous.rootError
  if (isRoot) {
    try { workflowFamilyBoundary([event]); rootError = undefined } catch (error) { rootError = errorMessage(error) }
  }
  let evidence: WorkflowStatusEvidence
  try {
    if (rootError) throw new Error(rootError)
    if (rootPosition === undefined && control) throw new InvariantViolation({
      kind: "missing-producer-event", eventType: "workflow.control.initialized", eventPosition: 0, aggregateId: envelope.aggregateId,
      detail: `nonempty workflow aggregate ${envelope.aggregateId} has no workflow.control.initialized marker`,
    })
    let exists = false
    let status: WorkflowView["status"] | undefined
    let missingCreation: ParsedStatusRow | undefined
    for (const row of rows) {
      if (row.error) throw new Error(row.error)
      if (row.type === "queue.created" || row.type === "queue.deleted") {
        exists = row.type === "queue.created"
        missingCreation = undefined
        status = row.status
      } else if (exists) status = row.status
      else missingCreation = row
    }
    if (missingCreation) throw new InvariantViolation({
      kind: "missing-producer-event", eventType: missingCreation.type, eventPosition: missingCreation.position, aggregateId: envelope.aggregateId,
      detail: `queue.created has not been observed before ${missingCreation.type}`,
    })
    evidence = { rootPosition, rootError, control, rows, status }
  } catch (error) {
    evidence = { rootPosition, rootError, control, rows, error: errorMessage(error) }
  }
  state.workflows.set(id, evidence)
  return state
}

function parseStatusRow(event: StatusRow): ParsedStatusRow {
  const envelope = event instanceof CorruptEventRowError ? event.row : event
  const row = { type: envelope.type, position: event.position }
  try {
    if (event instanceof CorruptEventRowError) throw event
    const fact = parseProjectionFact(event, parseWorkflowQueueFact)
    return { ...row, status: fact.type === "queue.created" ? (fact.version === 9 ? fact.payload.queue.status : fact.payload.rows.status)
      : fact.type === "queue.state.changed" ? fact.payload.status : undefined }
  } catch (error) {
    return { ...row, error: errorMessage(error) }
  }
}

export async function loadQueueSnapshotFromReader(reader: AsyncEventStateReadSurface, sessionId: string): Promise<WorkflowView | null> {
  const projection = createWorkflowQueueProjection(reader, sessionId)
  const state = await projection.replay()
  return normalizedWorkflowView(reader, sessionId, state, projection.getReadPosition())
}

/** Drops the superseded rows of the view's replace-only families.
 *
 *  `queue.state.changed`, `queue.plan.changed`, `queue.tree.changed`, and
 *  `follow_up.resume_state.recorded` are one live value per workflow, and
 *  `step.resume_revert.recorded` is one per attempt and `queue.tree.node.changed`
 *  one per tree node: every reader folds only the
 *  newest row, so older rows are loss-free dead weight the moment the next
 *  revision commits. The incremental families
 *  (`queue.mutated`, `step.status.changed`) and `step.resume_state.recorded`
 *  are history - the efficiency projection reads every resume-state row
 *  to map each historical conversation to its attempt - and are never touched.
 *
 *  Session close is the seam: writes ride VM proposal commits where the store
 *  refuses deletion, and once per close costs the run path nothing. */
export async function pruneSupersededWorkflowViewFacts(reader: AsyncEventStateReadSurface, writer: AsyncEventWriter, sessionId: string): Promise<number> {
  let aggregateId: string
  try {
    aggregateId = await selectWorkflowFactSource(reader, sessionId)
  } catch {
    // An uninitialized or damaged workflow aggregate is not this sweep's
    // problem; the projection error surfaces where the workflow is read.
    return 0
  }
  if (await reader.countByAggregate(aggregateId) === 0) return 0
  let pruned = 0
  pruned += await writer.pruneSupersededEvents(aggregateId, "queue.state.changed")
  pruned += await writer.pruneSupersededEvents(aggregateId, "queue.plan.changed")
  pruned += await writer.pruneSupersededEvents(aggregateId, "queue.tree.changed")
  pruned += await writer.pruneSupersededEvents(aggregateId, "follow_up.resume_state.recorded")
  pruned += await writer.pruneSupersededKeyedEvents?.(aggregateId, "step.resume_revert.recorded", "$.attemptId") ?? 0
  pruned += await writer.pruneSupersededKeyedEvents?.(aggregateId, "queue.tree.node.changed", "$.node.id") ?? 0
  return pruned
}

export interface WorkflowViewStore {
  loadQueue(): Promise<WorkflowView | null>
  applyStoredFact(events: StoredFact | readonly StoredFact[]): Promise<void>
  dispose(): void
}

interface WorkflowViewStoreDeps {
  sessionId: string
  reader: AsyncEventStateReadSurface
}

export function createWorkflowViewStore(deps: WorkflowViewStoreDeps): WorkflowViewStore {
  const { sessionId, reader } = deps
  const view = createLiveWorkflowView(reader, sessionId)
  let disposed = false

  function loadQueue(): Promise<WorkflowView | null> {
    return view.read()
  }

  async function applyStoredFact(events: StoredFact | readonly StoredFact[]): Promise<void> {
    if (!disposed) await view.apply(events)
  }

  function dispose(): void {
    disposed = true
  }

  return { loadQueue, applyStoredFact, dispose }
}
