import { Schema } from "effect"
import type { createEventProjection } from "../../../infra/projection/event-projection.js"
import type { AsyncEventStateReadSurface, StoredFact, CorruptEventRowError } from "../../../infra/store/event-store-types.js"
import { InvariantViolation } from "../../../infra/invariant.js"
import type { WorkflowTree } from "../../../protocol/workflow-view-protocol-types.js"
import { workflowAggregateId } from "../../run/run-facts.js"
import { workflowFamilyEvents } from "../../control-facts/workflow-root.js"
import { WorkflowViewSchema } from "../../view/schemas.js"
import type { WorkflowView } from "../../view/types.js"
import { createWorkflowQueueProjection, foldQueueFacts, type QueueProjectionState, type UnreadableRowFact } from "../../view/view-projection.js"
import { historicalWorkflowTree } from "./view-history-tree.js"

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
function normalizedWorkflowView(reader: AsyncEventStateReadSurface, sessionId: string, state: QueueProjectionState, upperPosition: number): Promise<WorkflowView | null> {
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


function unreadableRowsViolation(fact: UnreadableRowFact): InvariantViolation {
  return new InvariantViolation({ kind: "schema-mismatch", eventType: fact.type, eventVersion: fact.version, eventPosition: fact.position, aggregateId: fact.aggregateId, detail: fact.detail })
}

export async function loadQueueSnapshotFromReader(reader: AsyncEventStateReadSurface, sessionId: string): Promise<WorkflowView | null> {
  const projection = createWorkflowQueueProjection(reader, sessionId)
  const state = await projection.replay()
  return normalizedWorkflowView(reader, sessionId, state, projection.getReadPosition())
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
