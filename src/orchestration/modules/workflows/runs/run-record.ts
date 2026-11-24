import { HashMap, HashSet, Option } from "effect"
import { createEventProjection, parseProjectionFact } from "../../../../infra/projection/event-projection.js"
import type { AsyncEventReadSurface, AsyncEventStateReadSurface, StoredFact } from "../../../../infra/store/event-store-types.js"
import { createPushFedView } from "../../../../infra/projection/push-fed-view.js"
import type { WorkflowPlacements } from "../../../module-seams.js"
import { heldProjection } from "../../../../infra/projection/projection-registry.js"
import { factTypes } from "../../../../infra/event-registry.js"
import { readRunDefinitionLineage } from "../../../../workflows/run/definition-provenance-projection.js"
import { readWorkflowInputSeed } from "../../../../workflows/context-bundle/context-recovery.js"
import { parseWorkflowRunFact, WorkflowRunFactSchemas, type WorkflowCapabilityBoundary } from "../../../../workflows/run/run-facts.js"
import { nextRunCut, type WorkflowRunCut, type WorkflowRunReader, type WorkflowRunRecord } from "../../../workflow-host/run-record.js"
import { readWorkflowRecovery } from "../../../../workflows/vm/recovery/recovery-fold.js"
import type { Attempt } from "../../../../workflows/control-facts/graph-types.js"
import { readAttemptStarts, servedAttempts } from "../../../../workflows/vm/host/attempt-conversations.js"

interface RunRegistration {
  /** The position of the registration, which orders the runs as they were registered. */
  readonly position: number
  readonly run: WorkflowRunRecord
  readonly request: string | null
  readonly capabilityBoundary: WorkflowCapabilityBoundary | undefined
  readonly cut: WorkflowRunCut | null
}
/** Keyed with structural sharing, so a fact copies the path to its own run
 *  and never the index of every run. `completed` holds every workflow whose
 *  control completed, also one that a conversion registered later. */
interface RunIndex { readonly runs: HashMap.HashMap<string, RunRegistration>; readonly completed: HashSet.HashSet<string> }

/** A completed workflow is read-only (PI-INTERACTION-022): it takes no turn
 *  again, and only this fact of its control ends it. A paused, aborted, or
 *  failed workflow can resume. */
const WORKFLOW_COMPLETED = "workflow.completed"
const RUN_INDEX_FACT_TYPES = [...factTypes(WorkflowRunFactSchemas), WORKFLOW_COMPLETED]
const RUN_INDEX_FACT_TYPE_SET: ReadonlySet<string> = new Set(RUN_INDEX_FACT_TYPES)

/** Reads lifetime run facts across every control epoch. No session metadata or workflow/session alias is consulted. */
export function createWorkflowSettingsReader(reader: AsyncEventReadSurface): Omit<WorkflowRunReader, "readRequest" | "readDefinitionLineage" | "readAttempt" | "readMemberAttempt"> {
  function projection(workflowId?: string) {
    return heldProjection(reader, `workflow-runs:${workflowId ?? "all"}`, () => createEventProjection(reader, {
      name: "workflow-runs",
      ...(workflowId === undefined ? {} : { aggregateId: `workflow:${workflowId}` }),
      factTypes: RUN_INDEX_FACT_TYPES,
      initialState: emptyRunIndex,
      reduce: reduceRunIndex,
    }))
  }
  async function registration(id: string): Promise<RunRegistration | null> {
    return Option.getOrNull(HashMap.get((await projection(id).replay()).runs, id))
  }
  async function registered(include: (workflowId: string, run: WorkflowRunRecord, completed: RunIndex["completed"]) => boolean): Promise<Array<{ workflowId: string, run: WorkflowRunRecord }>> {
    const { runs, completed } = await projection().replay()
    return [...runs].filter(([workflowId, { run }]) => include(workflowId, run, completed))
      .sort(([, left], [, right]) => left.position - right.position)
      .map(([workflowId, { run }]) => ({ workflowId, run }))
  }
  return {
    read: async (id) => (await registration(id))?.run ?? null,
    readOpen: async (id) => {
      const index = await projection(id).replay()
      return HashSet.has(index.completed, id) ? null : Option.getOrNull(HashMap.get(index.runs, id))?.run ?? null
    },
    readCut: async (id) => (await registration(id))?.cut ?? null,
    readCreationRequest: async (id) => (await registration(id))?.request ?? null,
    readCapabilityBoundary: async (id) => (await registration(id))?.capabilityBoundary,
    listForParent: (parentSessionId) => registered((_id, run) => run.launchedFrom.parentSessionId === parentSessionId),
    list: () => registered(() => true),
    listOpen: () => registered((workflowId, _run, completed) => !HashSet.has(completed, workflowId)),
    changedRuns: (events) => {
      const changed = new Set<string>()
      for (const { type, aggregateId } of events) if (RUN_INDEX_FACT_TYPE_SET.has(type)) changed.add(aggregateId.slice("workflow:".length))
      return changed
    },
  }
}

function emptyRunIndex(): RunIndex {
  return { runs: HashMap.empty(), completed: HashSet.empty() }
}

function reduceRunIndex(state: RunIndex, event: StoredFact): RunIndex {
  const id = event.aggregateId.slice("workflow:".length)
  // Only the type of a completion is read; its payload is empty.
  if (event.type === WORKFLOW_COMPLETED) return { ...state, completed: HashSet.add(state.completed, id) }
  const fact = parseProjectionFact(event, parseWorkflowRunFact)
  const previous = Option.getOrUndefined(HashMap.get(state.runs, id))
  const withRuns = (runs: RunIndex["runs"]): RunIndex => ({ ...state, runs })
  switch (fact.type) {
    case "workflow.run.registered":
      if (previous) throw new Error(`Workflow ${id} has multiple run registrations`)
      return withRuns(HashMap.set(state.runs, id, { position: event.position, run: { ...fact.payload.settings, launchedFrom: fact.payload.launchedFrom }, request: fact.payload.request, capabilityBoundary: fact.payload.capabilityBoundary, cut: null }))
    case "workflow.run.settings.updated":
      if (!previous) throw new Error(`Workflow ${id} settings precede registration`)
      return withRuns(HashMap.set(state.runs, id, { ...previous, run: { ...fact.payload.settings, ...(previous.run.userNamed && fact.payload.labelSource !== "user" ? { label: previous.run.label, shortLabel: previous.run.shortLabel, name: previous.run.name, userNamed: true } : {}), launchedFrom: previous.run.launchedFrom } }))
    case "workflow.run.adopted":
      if (!previous) throw new Error(`Workflow ${id} adoption precedes registration`)
      return withRuns(HashMap.set(state.runs, id, { ...previous, run: { ...previous.run, ...fact.payload } }))
    case "workflow.run.deleted":
      return withRuns(HashMap.remove(state.runs, id))
    case "workflow.run.cut.updated":
      if (!previous) throw new Error(`Workflow ${id} cut precedes registration`)
      return withRuns(HashMap.set(state.runs, id, { ...previous, cut: nextRunCut(previous.cut, fact.payload.cut) }))
  }
}

/** The run facts that place a workflow in the session tree: its registration
 *  names the session that launched it, an adoption moves it under another
 *  session, and a deletion ends it. */
const WORKFLOW_PLACEMENT_FACT_TYPES = ["workflow.run.registered", "workflow.run.adopted", "workflow.run.deleted"] as const

/** Where workflows sit in the session tree, from a held fold of the run
 *  placement facts that `observe` advances. The run settings in that fold
 *  are not current, because only the placement facts reach it. */
export function createWorkflowPlacements(reader: AsyncEventReadSurface): WorkflowPlacements {
  const view = createPushFedView(() => heldProjection(reader, "workflow-placement", () => createEventProjection(reader, {
    name: "workflow-placement",
    factTypes: WORKFLOW_PLACEMENT_FACT_TYPES,
    initialState: emptyRunIndex,
    reduce: reduceRunIndex,
  })))
  return {
    parent: async (workflowId) => Option.getOrUndefined(HashMap.get((await view.read()).runs, workflowId))?.run.launchedFrom.parentSessionId,
    observe: view.observe,
  }
}

/** The attempts of a workflow's committed control, from the held recovery
 *  fold, which validates the whole aggregate once and then advances by the
 *  facts committed after its last read. Every agent's start commits to this
 *  aggregate, and a member's detail, input delivery, and the workflow's
 *  publication read an attempt after each commit: a whole read per commit
 *  made each start cost the history of every start before it. */
async function validatedAttempts(reader: AsyncEventStateReadSurface, id: string): Promise<readonly Attempt[]> {
  const { plan } = await readWorkflowRecovery(reader, id)
  if (!plan.executable) throw new Error(`Workflow ${id} has unreadable control`)
  return plan.control.attempts
}

/** Complete run reads add state-worker recovery reads to the read-only settings projection. */
export function createWorkflowRunReader(reader: AsyncEventStateReadSurface): WorkflowRunReader {
  const settings = createWorkflowSettingsReader(reader)
  return {
    ...settings,
    readRequest: async (id) => await readWorkflowInputSeed(reader, id) ?? await settings.readCreationRequest(id),
    readDefinitionLineage: (id) => readRunDefinitionLineage(reader, id),
    async readAttempt(id, attemptId) {
      return (await validatedAttempts(reader, id)).find((attempt) => attempt.id === attemptId) ?? null
    },
    async readMemberAttempt(id, { attemptId, conversationId }) {
      const [attempts, starts] = await Promise.all([validatedAttempts(reader, id), readAttemptStarts(reader, id)])
      const held = attempts.map((attempt) => attempt.conversationId === null ? { id: attempt.id } : { id: attempt.id, lastConversationId: attempt.conversationId })
      const served = servedAttempts(starts, held).get(conversationId) ?? attemptId
      return attempts.find((attempt) => attempt.id === served) ?? null
    },
  }
}
