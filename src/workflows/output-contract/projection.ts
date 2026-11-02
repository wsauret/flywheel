import { parseProjectionFact, reduceEvents } from "../../infra/event-projection.js"
import type { StoredFact } from "../../infra/event-store-types.js"
import { parseHandoffFact, type HandoffFact, type HandoffIssue } from "./facts.js"

/** The latest output fact of one attempt, folded from its `handoff.written` and
 *  `handoff.validated` facts. */
export interface HandoffRecord {
  attemptId: string
  agentName: string
  definitionId: string
  workflowDefinitionId: string
  content?: { readonly [key: string]: unknown }
  bytes?: number
  sha256?: string
  preview?: string
  validationStatus?: "passed" | "failed"
  validationIssues: HandoffIssue[]
}

interface HandoffRecords {
  readonly [attemptId: string]: HandoffRecord
}

interface HandoffProjectionState {
  readonly [key: string]: unknown
  records: HandoffRecords
  order: string[]
}

const HANDOFF_FACT_TYPES = ["handoff.written", "handoff.validated"] as const

function handoffsFromProjection(state: HandoffProjectionState): HandoffRecord[] {
  // reduceHandoffEvent only appends a key to `order` when it also writes the
  // matching record, so a missing record is a reducer bug, not a tolerable gap.
  return state.order.map((key) => {
    const record = state.records[key]
    if (!record) {
      throw new Error(`handoff projection: order key "${key}" has no record; reduceHandoffEvent is broken`)
    }
    return record
  })
}

export function loadHandoffsFromEvents(events: readonly StoredFact[]): HandoffRecord[] {
  return handoffsFromProjection(reduceEvents(events, {
    initialState,
    reduce: reduceHandoffEvent,
    factTypes: HANDOFF_FACT_TYPES,
  }))
}

function initialState(): HandoffProjectionState {
  return { records: {}, order: [] }
}

function reduceHandoffEvent(state: HandoffProjectionState, event: StoredFact): HandoffProjectionState {
  const fact = parseProjectionFact(event, parseHandoffFact)
  const key = fact.payload.attemptId
  const existing = state.records[key]
  return {
    records: { ...state.records, [key]: reduceHandoffRecord(existing, fact) },
    order: existing ? state.order : [...state.order, key],
  }
}

/** Advance one attempt's output with a decoded written or validation fact. */
export function reduceHandoffRecord(existing: HandoffRecord | undefined, fact: HandoffFact): HandoffRecord {
  const base = existing ?? {
    attemptId: fact.payload.attemptId,
    agentName: fact.payload.agentName,
    definitionId: fact.payload.definitionId,
    workflowDefinitionId: fact.payload.workflowDefinitionId,
    validationIssues: [],
  }

  return fact.type === "handoff.written"
    ? {
        ...base,
        content: fact.payload.content,
        bytes: fact.payload.bytes,
        sha256: fact.payload.sha256,
        preview: fact.payload.preview,
      }
    : {
        ...base,
        validationStatus: fact.payload.status,
        validationIssues: fact.payload.issues,
      }
}
