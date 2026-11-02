import { parseProjectionFact, reduceEvents } from "../infra/event-projection.js"
import { factTypes } from "../infra/event-registry.js"
import { readCapturedFacts, type AsyncEventReadSurface, type StoredFact } from "../infra/event-store-types.js"
import {
  DefinitionProvenanceFactSchemas,
  parseDefinitionProvenanceFact,
  recordedLaunchAdmission,
  type DefinitionDriftRejectedPayload,
  type DefinitionHashRecordedPayload,
  type DefinitionLoadedPayload,
  type WorkflowCompiledPayload,
} from "./definition-provenance-facts.js"
import { workflowAggregateId } from "./vm/session-facts.js"
import { pathInSessionDir } from "../infra/paths.js"

/** Where a workflow's definition came from: the workflow file that a chat
 *  agent wrote and launched, by its path in that chat's session directory,
 *  such as `scratch/workflows/review.workflow.yaml`, or the registry layer
 *  that installed a named workflow in a recorded run. */
type WorkflowDefinitionSource =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "registered"; readonly layer: "bundled" | "user" | "project" }

/** What the launch of a workflow recorded about its definition. A member is
 *  absent when the launch recorded none, as for a run from an earlier build. */
export interface WorkflowLaunch {
  readonly source?: WorkflowDefinitionSource
  /** The verifier result of the launch. Only the launch of a workflow file
   *  runs the verifier, and it runs a file that the verifier did not prove. */
  readonly verification?: "proved" | "partially_proved" | "invalid"
  /** The most attempts the launched workflow could queue: every attempt it
   *  held, each list at its declared width, each declared retry, and each
   *  attempt that its loops and follow-ups could insert, up to its queue
   *  length. */
  readonly worstCaseAttempts?: number
  /** What the launch of a workflow file warned about, one short located
   *  line each. Absent when it warned about nothing. */
  readonly warnings?: readonly string[]
}


/** Folded view of the definition provenance facts. Every member is the typed
 *  payload of the owning fact, so the view can never drift from what the fact
 *  schemas admit: `parseProjectionFact` decodes each fact once at the read
 *  boundary and the fold only rearranges the decoded values.
 *
 *  The index signatures satisfy `reduceEvents` while keeping each collection's
 *  payload type explicit. */
interface LoadedDefinitions {
  readonly [key: string]: DefinitionLoadedPayload
}

interface RecordedDefinitionHashes {
  readonly [key: string]: DefinitionHashRecordedPayload
}

export interface DefinitionLineageView {
  readonly [key: string]: unknown
  readonly definitions: LoadedDefinitions
  readonly definitionOrder: readonly string[]
  readonly hashes: RecordedDefinitionHashes
  readonly compiledWorkflow: WorkflowCompiledPayload | null
  readonly driftRejections: readonly DefinitionDriftRejectedPayload[]
}

const DEFINITION_PROVENANCE_FACT_TYPES = factTypes(DefinitionProvenanceFactSchemas)

export function loadDefinitionLineageFromEvents(events: readonly StoredFact[]): DefinitionLineageView {
  return reduceEvents(events, {
    initialState,
    reduce: reduceDefinitionEvent,
    factTypes: DEFINITION_PROVENANCE_FACT_TYPES,
  })
}

function initialState(): DefinitionLineageView {
  return {
    definitions: {},
    definitionOrder: [],
    hashes: {},
    compiledWorkflow: null,
    driftRejections: [],
  }
}

function reduceDefinitionEvent(state: DefinitionLineageView, event: StoredFact): DefinitionLineageView {
  const fact = parseProjectionFact(event, parseDefinitionProvenanceFact)

  switch (fact.type) {
    case "definition.loaded":
      return recordDefinition(state, fact.payload)
    case "definition.hash_recorded":
      return {
        ...state,
        hashes: { ...state.hashes, [definitionKey(fact.payload)]: fact.payload },
      }
    case "workflow.compiled":
      return { ...state, compiledWorkflow: fact.payload }
    case "definition.drift_rejected":
      return { ...state, driftRejections: [...state.driftRejections, fact.payload] }
  }
}

function recordDefinition(
  state: DefinitionLineageView,
  definition: DefinitionLoadedPayload,
): DefinitionLineageView {
  const key = definitionKey(definition)
  return {
    ...state,
    definitions: { ...state.definitions, [key]: definition },
    definitionOrder: state.definitionOrder.includes(key) ? state.definitionOrder : [...state.definitionOrder, key],
  }
}

function definitionKey(input: { kind: string; id: string }): string {
  return `${input.kind}:${input.id}`
}

/** The definition lineage that one workflow run recorded on its aggregate. */
export async function readRunDefinitionLineage(reader: AsyncEventReadSurface, sessionId: string): Promise<DefinitionLineageView> {
  return loadDefinitionLineageFromEvents(await readCapturedFacts(reader, { aggregateId: workflowAggregateId(sessionId), types: DEFINITION_PROVENANCE_FACT_TYPES }))
}

/** What the launch of one workflow run recorded about its definition: the
 *  source that the provenance of its workflow names, and the worst case and
 *  the verifier result that its compilation records. Undefined when the run
 *  recorded none of them. */
export function workflowLaunchOf(lineage: DefinitionLineageView): WorkflowLaunch | undefined {
  const compiled = lineage.compiledWorkflow
  const key = compiled === null ? lineage.definitionOrder.find((candidate) => candidate.startsWith("workflow:")) : `workflow:${compiled.workflowDefinitionId}`
  const provenance = key === undefined ? undefined : lineage.definitions[key]?.provenance
  const admission = compiled === null ? undefined : recordedLaunchAdmission(compiled)
  const launch: WorkflowLaunch = {
    ...(provenance === undefined ? {} : { source: definitionSource(provenance) }),
    ...(admission?.verification == null ? {} : { verification: admission.verification }),
    ...(admission === undefined ? {} : { worstCaseAttempts: admission.worstCaseAttempts }),
    ...(admission === undefined || admission.warnings.length === 0 ? {} : { warnings: admission.warnings }),
  }
  return Object.keys(launch).length === 0 ? undefined : launch
}

/** A workflow file is named by its path in the session directory of the
 *  chat that launched it, as the author wrote it. */
function definitionSource(provenance: NonNullable<DefinitionLoadedPayload["provenance"]>): WorkflowDefinitionSource {
  return provenance.layer === "session"
    ? { kind: "file", path: pathInSessionDir(provenance.filePath) ?? provenance.filePath }
    : { kind: "registered", layer: provenance.layer }
}
