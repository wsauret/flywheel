import { createEventProjection, parseProjectionFact, type EventProjection } from "../../infra/event-projection.js"
import { CorruptEventRowError, type AsyncEventReadSurface, type AsyncEventStateReadSurface, type FactQuery, type StoredFact } from "../../infra/event-store-types.js"
import { heldProjection, pinHeldProjection } from "../../infra/projection-registry.js"
import { yieldToNextTask } from "../../infra/task-scheduling.js"
import { storedToolCallIdentity } from "../../infra/tool-content-hydration.js"
import { workflowRunOwner } from "../module-catalog.js"
import { installedChildSessionHistory } from "./module-session-operations.js"
import { decodeSessionMetadataFactForReplay } from "./session-metadata-facts.js"
import { parseSessionRuntimeFact } from "./session-runtime-event-types.js"
import type { ToolExecutionEntry, ToolExecutionState } from "./tool-execution-types.js"

/** The member facts that no finished sweep handled. */
interface PendingChanges {
  readonly facts: Array<StoredFact | CorruptEventRowError>
  readonly workflowIds: Set<string>
}

/** A parent's member cursor. Every member fact at or below `position` is in
 *  `pending` or handled; `position` is unset until the first catch-up
 *  captures the committed position. */
interface MemberCursor {
  position: number | undefined
  readonly pending: PendingChanges
}

/** Each parent's workflows that a binding fact placed under it, with the
 *  position of that fact. */
interface WorkflowBindings {
  readonly byParent: Map<string, Map<string, number>>
}

/** The pending changes one sweep read, with the workflow bindings it took
 *  from the routed state. */
interface SweepBatches {
  readonly changes: PendingChanges
  readonly bindings: { readonly routed: WorkflowBindings; readonly taken: ReadonlyMap<string, number> }
}

/** The parent facts that change membership or a launching call's result. */
const PARENT_FACT_TYPES = ["session.child.linked", "session.child.unlinked", "tool.result.recorded", "workflow.tool_result.corrected"]

/** The one workspace cursor over the facts that bind a workflow to a parent.
 *  No fact on a parent's own aggregate records a workflow launch or an
 *  adoption, so this cursor routes each new binding to the parent that it
 *  names, and that parent's next sweep takes it. It starts at the committed
 *  position and reads only binding facts, through the type index, so it
 *  reads no history. Its key is a family of one, which the registry never
 *  evicts, so no binding is lost while the reader lives. A binding that
 *  does not read names no parent, and the workflow's own reads contain its
 *  damage. */
function workflowBindings(reader: AsyncEventReadSurface) {
  return heldProjection(reader, "child-reconciliation-bindings", () => {
    const { accounting } = workflowRunOwner()
    return createEventProjection<WorkflowBindings>(reader, {
      name: "child-reconciliation-bindings",
      factTypes: accounting.factTypes,
      seed: async () => ({ state: { byParent: new Map() }, position: await reader.capturePosition() }),
      initialState: () => ({ byParent: new Map() }),
      draft: (state) => state,
      reduce: (state, fact) => {
        // The wrap turns a parse throw of `ancestry` into the schema-mismatch
        // violation that routes the fact to `reduceUnreadableFact`.
        const binding = parseProjectionFact(fact, () => accounting.ancestry(fact))
        if (!binding) return state
        const workflows = state.byParent.get(binding.parent) ?? new Map<string, number>()
        workflows.set(binding.owner.slice("workflow:".length), fact.position)
        state.byParent.set(binding.parent, workflows)
        return state
      },
      reduceCorruptRow: (state) => state,
      reduceUnreadableFact: (state) => state,
    })
  })
}

/** The per-parent completion cursor and its derived membership. A catch-up
 *  reads only the parent's own aggregate, its subagent children, and its
 *  workflows, through the per-aggregate indexes, so a parent's work grows
 *  with its own children and never with its siblings'. New workflows arrive
 *  through `workflowBindings`. The cursor starts at the committed position:
 *  the first sweep reads membership and each child's runs from their owners,
 *  so no read covers the past. The session read takes only run and
 *  parent-call facts, and the workflow read keeps only the ids it saw, so a
 *  batch holds no tool or queue bodies. Each catch-up appends to the pending
 *  batch, and only a sweep that finishes releases what it read: a sweep that
 *  fails, such as on a refused publication, leaves its changes for the retry.
 *
 *  While an owner of the parent holds it (`holdChildReconciliationIndex`),
 *  the registry keeps the index through churn of its family. An index that
 *  the registry dropped would start again with a first sweep, which reads
 *  every child of the parent and forgets the runs it saw. A sweep of a parent
 *  that no owner holds, such as recovery's or a deletion's, keeps its index
 *  only as long as the registry does, so such sweeps retain nothing for the
 *  process's life. */
function childReconciliationIndex(reader: AsyncEventReadSurface, parentSessionId: string) {
  return heldProjection(reader, `child-reconciliation:${parentSessionId}`, () => {
    const cursor: MemberCursor = { position: undefined, pending: { facts: [], workflowIds: new Set() } }
    return Object.assign(cursor, {
      initialized: false,
      children: new Set<string>(),
      workflows: new Set<string>(),
      toolChildren: new Map<string, string>(),
      durable: new Set<string>(),
      nonterminal: new Map<string, string>(),
      pendingWorkflows: new Map<string, { readonly conversationId: string; readonly key: string; readonly sequence?: number }>(),
      activeByChild: new Map<string, number>(),
      activeByRun: new Map<string, Map<string, boolean>>(),
      seenChildren: new Set<string>(),
      resultPositions: new Map<string, { readonly id: string; readonly position: number }>(),
      active: 0,
      /** Marks a finished sweep's batches and full child reads handled, and
       *  releases the batches. Sweeps of one parent run in its ordered lane,
       *  and nothing else reads into its pending batch, so that batch is
       *  exactly what the sweep read. Other parents' sweeps can route new
       *  bindings to this parent meanwhile, so only the bindings the sweep
       *  took are released. A failed sweep marks nothing, so its retry reads
       *  the same children in full again. */
      consume(batches: SweepBatches, seededChildren: readonly string[]) {
        this.initialized = true
        for (const id of seededChildren) this.seenChildren.add(id)
        batches.changes.facts.splice(0)
        batches.changes.workflowIds.clear()
        const { routed: { byParent }, taken } = batches.bindings
        const routed = byParent.get(parentSessionId)
        for (const [id, position] of taken) {
          const current = routed?.get(id)
          if (current !== undefined && current <= position) routed?.delete(id)
        }
        if (routed?.size === 0) byParent.delete(parentSessionId)
      },
    })
  })
}

type ChildReconciliationIndex = ReturnType<typeof childReconciliationIndex>

/** Reads into `index.pending` every member fact committed after its cursor.
 *  Both reads finish before the batch changes, so a failed catch-up adds
 *  nothing and its retry reads the same range once. */
async function replayPending(reader: AsyncEventReadSurface, parentSessionId: string, index: ChildReconciliationIndex): Promise<void> {
  const upper = await reader.capturePosition()
  const after = index.position
  if (after === undefined) {
    index.position = upper
    return
  }
  if (upper <= after) return
  const sessionIds = [parentSessionId, ...index.children].map((id) => `session:${id}`)
  const types = [...new Set([...installedChildSessionHistory().factTypes, ...PARENT_FACT_TYPES])]
  const workflowIds = [...index.workflows].map((id) => `workflow:${id}`)
  const [facts, workflowFacts] = await Promise.all([
    readMembers(reader, { aggregateIds: sessionIds, types }, after, upper),
    readMembers(reader, { aggregateIds: workflowIds }, after, upper),
  ])
  index.pending.facts.push(...facts)
  for (const fact of workflowFacts) index.pending.workflowIds.add(aggregateIdOf(fact).slice("workflow:".length))
  index.position = upper
}

/** The facts of `query` after `after` through `upper`, damaged rows included. */
async function readMembers(reader: AsyncEventReadSurface, query: FactQuery, after: number, upper: number): Promise<Array<StoredFact | CorruptEventRowError>> {
  const facts: Array<StoredFact | CorruptEventRowError> = []
  if (query.aggregateIds?.length === 0) return facts
  let cursor = after
  for (;;) {
    const page = await reader.readPage(query, upper, cursor, true, "deferred")
    facts.push(...page.facts)
    if (page.continuationPosition === null) return facts
    cursor = page.continuationPosition
    await yieldToNextTask()
  }
}

function aggregateIdOf(fact: StoredFact | CorruptEventRowError): string {
  return fact instanceof CorruptEventRowError ? fact.row.aggregateId : fact.aggregateId
}

/** Keeps the completion index of a parent that is open, such as a chat that
 *  has a session actor or a child session that runs, and the child-run fold
 *  that its sweeps read, until the returned release, which is idempotent.
 *  The last release drops the index, so the parent's next sweep is a first
 *  sweep again. */
export function holdChildReconciliationIndex(reader: AsyncEventStateReadSurface, parentSessionId: string): () => void {
  const releases = [
    installedChildSessionHistory().holdParentReconciliationRuns(reader, parentSessionId),
    pinHeldProjection(reader, `child-reconciliation:${parentSessionId}`, { dropOnLastRelease: true }),
  ]
  return () => { for (const release of releases) release() }
}

export interface ChildReconciliationReadContext {
  readonly input: {
    readonly reader: AsyncEventStateReadSurface
    readonly projectionReader?: AsyncEventStateReadSurface
    readonly parentSessionId: string
  }
  readonly index: ChildReconciliationIndex
  /** The parent's one tool-execution projection for the whole sweep. */
  readonly parentTools: EventProjection<ToolExecutionState>
}

/** Selects changed child calls from the parent's advancing tool owner. */
export async function readParentTools(context: ChildReconciliationReadContext, toolUseIds: readonly string[]): Promise<Map<string, ToolExecutionEntry>> {
  if (toolUseIds.length === 0) return new Map()
  const state = await context.parentTools.replay()
  const tools = new Map<string, ToolExecutionEntry>()
  for (const id of toolUseIds) {
    const tool = state.tools[id]
    if (tool) tools.set(id, tool)
  }
  return tools
}

/** Routes one parent's new committed facts without probing its unchanged children. */
export async function readChildReconciliationChanges(reader: AsyncEventStateReadSurface, parentSessionId: string) {
  const index = childReconciliationIndex(reader, parentSessionId)
  const [, routed] = await Promise.all([replayPending(reader, parentSessionId, index), workflowBindings(reader).replay()])
  const bindings = { routed, taken: new Map(routed.byParent.get(parentSessionId)) }
  const changes = index.pending
  const childChanges = new Map<string, StoredFact[]>()
  const first = !index.initialized
  const changedChildren = new Set<string>()
  const changedWorkflows = new Set([...changes.workflowIds, ...bindings.taken.keys()])
  for (const event of changes.facts) {
    const aggregateId = aggregateIdOf(event)
    const id = aggregateId.slice("session:".length)
    if (index.children.has(id)) changedChildren.add(id)
    if (!(event instanceof CorruptEventRowError)) {
      const facts = childChanges.get(id) ?? []
      facts.push(event)
      childChanges.set(id, facts)
    }
    if (aggregateId !== `session:${parentSessionId}` || event instanceof CorruptEventRowError) continue
    if (event.type === "session.child.linked" || event.type === "session.child.unlinked") {
      const fact = decodeSessionMetadataFactForReplay({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
      if (fact?.type === "session.child.linked") changedChildren.add(fact.payload.childSessionId)
      if (fact?.type === "session.child.unlinked") {
        const childId = fact.payload.childSessionId
        index.children.delete(childId)
        index.durable.delete(childId)
        index.active -= index.activeByChild.get(childId) ?? 0
        index.activeByChild.delete(childId)
        index.activeByRun.delete(childId)
      }
    }
    if (event.type === "tool.result.recorded" || event.type === "workflow.tool_result.corrected") {
      const toolUseId = resultToolUseId(event)
      index.resultPositions.set(toolUseId, { id: event.id, position: event.position })
      const child = index.toolChildren.get(toolUseId)
      if (child && index.workflows.has(child)) changedWorkflows.add(child)
      else if (child) changedChildren.add(child)
    }
  }
  return { index, batches: { changes, bindings }, childChanges, first, changedChildren, changedWorkflows }
}

/** The call that a parent result fact names. A reference-backed stored result
 *  decodes from its stored version, so the index loads no tool content. */
function resultToolUseId(event: StoredFact): string {
  const stored = storedToolCallIdentity(event)
  if (stored) return stored.toolUseId
  const fact = parseSessionRuntimeFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
  if (fact.type !== "tool.result.recorded" && fact.type !== "workflow.tool_result.corrected") throw new Error(`Expected a parent result fact, got ${fact.type}`)
  return fact.payload.toolUseId
}
