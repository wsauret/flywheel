import { parseProjectionFact, reduceEvents } from "../../infra/event-projection.js"
import { factTypes } from "../../infra/event-registry.js"
import { readCapturedFacts, type AsyncEventReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import {
  DefinitionProvenanceFactSchemas,
  parseDefinitionProvenanceFact,
  type DefinitionDriftRejectedPayload,
  type DefinitionHashRecordedPayload,
  type DefinitionLoadedPayload,
  type WorkflowCompiledPayload,
} from "../provenance/definition-provenance-facts.js"
import { workflowAggregateId } from "./run-facts.js"

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

function loadDefinitionLineageFromEvents(events: readonly StoredFact[]): DefinitionLineageView {
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
