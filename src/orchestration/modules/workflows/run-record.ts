import { HashMap, Option } from "effect"
import { createEventProjection, parseProjectionFact } from "../../../infra/event-projection.js"
import type { AsyncEventReadSurface, AsyncEventStateReadSurface, StoredFact } from "../../../infra/event-store-types.js"
import { createPushFedView } from "../../../infra/push-fed-view.js"
import type { WorkflowPlacements } from "../../module-seams.js"
import { heldProjection } from "../../../infra/projection-registry.js"
import { factTypes } from "../../../infra/event-registry.js"
import { readRunDefinitionLineage } from "../../../workflows/definition-provenance-projection.js"
import { readWorkflowInputSeed } from "../../../workflows/context-bundle/context-recovery.js"
import { parseWorkflowRunFact, WorkflowRunFactSchemas } from "../../../workflows/run-facts.js"
import { nextRunCut, type WorkflowRunCut, type WorkflowRunReader, type WorkflowRunRecord } from "../../workflow-host/run-record.js"
import { readWorkflowRecovery } from "../../../workflows/vm/recovery-fold.js"
import type { Attempt } from "../../../workflows/vm/graph-types.js"

interface RunRegistration {
  /** The position of the registration, which orders the runs as they were registered. */
  readonly position: number
  readonly run: WorkflowRunRecord
  readonly request: string | null
  readonly cut: WorkflowRunCut | null
}
/** Keyed with structural sharing, so a fact copies the path to its own run
 *  and never the index of every run. */
interface RunIndex { readonly runs: HashMap.HashMap<string, RunRegistration> }

/** Reads lifetime run facts across every control epoch. No session metadata or workflow/session alias is consulted. */
export function createWorkflowSettingsReader(reader: AsyncEventReadSurface): Omit<WorkflowRunReader, "readRequest" | "readDefinitionLineage" | "readAttempt"> {
  function projection(workflowId?: string) {
    return heldProjection(reader, `workflow-runs:${workflowId ?? "all"}`, () => createEventProjection(reader, {
      name: "workflow-runs",
      ...(workflowId === undefined ? {} : { aggregateId: `workflow:${workflowId}` }),
      factTypes: factTypes(WorkflowRunFactSchemas),
      initialState: emptyRunIndex,
      reduce: reduceRunIndex,
    }))
  }
  async function registration(id: string): Promise<RunRegistration | null> {
    return Option.getOrNull(HashMap.get((await projection(id).replay()).runs, id))
  }
  async function registered(include: (run: WorkflowRunRecord) => boolean): Promise<Array<{ workflowId: string, run: WorkflowRunRecord }>> {
    return [...(await projection().replay()).runs].filter(([, { run }]) => include(run))
      .sort(([, left], [, right]) => left.position - right.position)
      .map(([workflowId, { run }]) => ({ workflowId, run }))
  }
  return {
    read: async (id) => (await registration(id))?.run ?? null,
    readCut: async (id) => (await registration(id))?.cut ?? null,
    readCreationRequest: async (id) => (await registration(id))?.request ?? null,
    listForParent: (parentSessionId) => registered((run) => run.launchedFrom.parentSessionId === parentSessionId),
    list: () => registered(() => true),
  }
}

function emptyRunIndex(): RunIndex {
  return { runs: HashMap.empty() }
}

function reduceRunIndex(state: RunIndex, event: StoredFact): RunIndex {
  const fact = parseProjectionFact(event, parseWorkflowRunFact)
  const id = event.aggregateId.slice("workflow:".length)
  const previous = Option.getOrUndefined(HashMap.get(state.runs, id))
  switch (fact.type) {
    case "workflow.run.registered":
      if (previous) throw new Error(`Workflow ${id} has multiple run registrations`)
      return { runs: HashMap.set(state.runs, id, { position: event.position, run: { ...fact.payload.settings, launchedFrom: fact.payload.launchedFrom }, request: fact.payload.request, cut: null }) }
    case "workflow.run.settings.updated":
      if (!previous) throw new Error(`Workflow ${id} settings precede registration`)
      return { runs: HashMap.set(state.runs, id, { ...previous, run: { ...fact.payload.settings, ...(previous.run.userNamed && fact.payload.labelSource !== "user" ? { label: previous.run.label, shortLabel: previous.run.shortLabel, name: previous.run.name, userNamed: true } : {}), launchedFrom: previous.run.launchedFrom } }) }
    case "workflow.run.adopted":
      if (!previous) throw new Error(`Workflow ${id} adoption precedes registration`)
      return { runs: HashMap.set(state.runs, id, { ...previous, run: { ...previous.run, ...fact.payload } }) }
    case "workflow.run.deleted":
      return { runs: HashMap.remove(state.runs, id) }
    case "workflow.run.cut.updated":
      if (!previous) throw new Error(`Workflow ${id} cut precedes registration`)
      return { runs: HashMap.set(state.runs, id, { ...previous, cut: nextRunCut(previous.cut, fact.payload.cut) }) }
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
  }
}
