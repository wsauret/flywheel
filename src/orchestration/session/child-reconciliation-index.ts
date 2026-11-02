import { createEventProjection, type EventProjection } from "../../infra/event-projection.js"
import { CorruptEventRowError, type AsyncEventStateReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { heldProjection, pinHeldProjection } from "../../infra/projection-registry.js"
import { storedToolCallIdentity } from "../../infra/tool-content-hydration.js"
import { installedChildSessionHistory } from "./module-session-operations.js"
import { decodeSessionMetadataFactForReplay } from "./session-metadata-facts.js"
import { parseSessionRuntimeFact } from "./session-runtime-event-types.js"
import type { ToolExecutionEntry, ToolExecutionState } from "./tool-execution-types.js"

interface ChangeBatch {
  readonly facts: Array<StoredFact | CorruptEventRowError>
}

interface WorkflowChangeBatch {
  readonly workflowIds: Set<string>
}

/** The pending batches one sweep replayed. */
interface SweepBatches {
  readonly changes: ChangeBatch
  readonly workflowChanges: WorkflowChangeBatch
}

/** The parent facts that change membership or a launching call's result. */
const PARENT_FACT_TYPES = ["session.child.linked", "session.child.unlinked", "tool.result.recorded", "workflow.tool_result.corrected"]

/** The per-parent completion cursor and its derived membership. A sweep consumes
 * only facts committed after the cursor was built, including commits from
 * another process. The cursors start at the committed position: the initial
 * sweep reads membership and each child's runs from their owners, so no
 * cursor reads the workspace's past. The session cursor reads only run and
 * parent-call facts, and the workflow cursor keeps only the ids it saw, so a
 * batch holds no tool or queue bodies. Each catch-up appends to the pending
 * batch, and only a sweep that finishes releases what it read: a sweep that
 * fails, such as on a refused publication, leaves its changes for the retry.
 *
 * While an owner of the parent holds it (`holdChildReconciliationIndex`),
 * the registry keeps the index through churn of its family. An index that
 * the registry dropped would start again with a first sweep, which reads
 * every child of the parent and forgets the runs it saw. A sweep of a parent
 * that no owner holds, such as recovery's or a deletion's, keeps its index
 * only as long as the registry does, so such sweeps retain nothing for the
 * process's life. */
function childReconciliationIndex(reader: AsyncEventStateReadSurface, parentSessionId: string) {
  return heldProjection(reader, `child-reconciliation:${parentSessionId}`, () => {
    const seed = async <S extends object>(state: S) => ({ state, position: await reader.capturePosition() })
    const projection = createEventProjection<ChangeBatch>(reader, {
      name: `child-reconciliation:${parentSessionId}`,
      aggregatePrefix: "session:",
      factTypes: [...new Set([...installedChildSessionHistory().factTypes, ...PARENT_FACT_TYPES])],
      tolerateScopedCorruption: true,
      seed: () => seed({ facts: [] }),
      initialState: () => ({ facts: [] }),
      draft: (state) => state,
      reduce: (state, fact) => { state.facts.push(fact); return state },
      reduceCorruptRow: (state, fact) => { state.facts.push(fact); return state },
    })
    const workflowChanges = heldProjection(reader, `child-reconciliation-workflows:${parentSessionId}`, () => createEventProjection<WorkflowChangeBatch>(reader, {
      name: `child-reconciliation-workflows:${parentSessionId}`,
      aggregatePrefix: "workflow:",
      tolerateScopedCorruption: true,
      seed: () => seed({ workflowIds: new Set<string>() }),
      initialState: () => ({ workflowIds: new Set() }),
      draft: (state) => state,
      reduce: (state, fact) => { state.workflowIds.add(fact.aggregateId.slice("workflow:".length)); return state },
      reduceCorruptRow: (state, fact) => { state.workflowIds.add(fact.row.aggregateId.slice("workflow:".length)); return state },
    }))
    return Object.assign(projection, {
      workflowChanges,
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
       *  and nothing else folds these cursors, so the pending batches are
       *  exactly what the sweep read. A failed sweep marks nothing, so its
       *  retry reads the same children in full again. */
      consume(batches: SweepBatches, seededChildren: readonly string[]) {
        this.initialized = true
        for (const id of seededChildren) this.seenChildren.add(id)
        batches.changes.facts.splice(0)
        batches.workflowChanges.workflowIds.clear()
      },
    })
  })
}

type ChildReconciliationIndex = ReturnType<typeof childReconciliationIndex>

/** Keeps the completion index of a parent that is open, such as a chat that
 *  has a session actor or a child session that runs, and the child-run fold
 *  that its sweeps read, until the returned release, which is idempotent.
 *  The last release drops the index, so the parent's next sweep is a first
 *  sweep again. */
export function holdChildReconciliationIndex(reader: AsyncEventStateReadSurface, parentSessionId: string): () => void {
  const releases = [
    installedChildSessionHistory().holdParentReconciliationRuns(reader, parentSessionId),
    pinHeldProjection(reader, `child-reconciliation:${parentSessionId}`, { dropOnLastRelease: true }),
    pinHeldProjection(reader, `child-reconciliation-workflows:${parentSessionId}`, { dropOnLastRelease: true }),
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
  const childChanges = new Map<string, StoredFact[]>()
  const [changes, workflowChanges] = await Promise.all([index.replay(), index.workflowChanges.replay()])
  const first = !index.initialized
  const changedChildren = new Set<string>()
  const changedWorkflows = new Set(workflowChanges.workflowIds)
  for (const event of changes.facts) {
    const aggregateId = event instanceof CorruptEventRowError ? event.row.aggregateId : event.aggregateId
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
  return { index, batches: { changes, workflowChanges }, childChanges, first, changedChildren, changedWorkflows }
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
