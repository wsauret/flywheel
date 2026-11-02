import type { EventProjection } from "../../infra/event-projection.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { createEventProjection, parseProjectionFact, reduceEvents } from "../../infra/event-projection.js"
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { workflowProjectionBoundary } from "../session-fact-source.js"
import { workflowAggregateId } from "../vm/session-facts.js"
import { workflowFamilyEvents } from "../workflow-root.js"
import {
  createContextAccumulator,
  type AccumulatedContext,
  type AccumulatorState,
  type ContextAccumulator,
  type ContextRecipient,
} from "./context.js"
import { accumulatedEntry, addendumRecord, parseWorkflowContextFact, WORKFLOW_CONTEXT_FACT_TYPES } from "./context-facts.js"

interface ContextProjectionState {
  readonly [key: string]: unknown
  accumulator: ContextAccumulator
}

export function createWorkflowContextProjection(
  reader: AsyncEventStateReadSurface,
  sessionId: string,
): EventProjection<ContextProjectionState> {
  const aggregateId = workflowAggregateId(sessionId)
  const projection = heldProjection(reader, `workflow-context:${sessionId}`, () => createEventProjection(reader, {
    aggregateId,
    factTypes: WORKFLOW_CONTEXT_FACT_TYPES,
    resetBoundary: workflowProjectionBoundary(reader, aggregateId),
    initialState,
    reduce: reduceContextEvent,
  }))
  return projection
}

function contextStateFromEvents(events: readonly StoredFact[]): ContextProjectionState {
  return reduceEvents(workflowFamilyEvents(events), {
    initialState,
    reduce: reduceContextEvent,
    factTypes: WORKFLOW_CONTEXT_FACT_TYPES,
  })
}

export function loadContextStateFromEvents(events: readonly StoredFact[]): AccumulatorState | null {
  return accumulatorStateFromProjection(contextStateFromEvents(events))
}

/** The context that one recipient of a session reads from its stored
 *  facts, with every record it leaves out and why. Without a recipient, it
 *  is the workflow scope. */
export function loadAccumulatedContextFromEvents(events: readonly StoredFact[], recipient?: ContextRecipient): AccumulatedContext {
  return contextFromProjection(contextStateFromEvents(events), recipient)
}

/** Whether the workflow's context records a request addendum under `key`:
 *  the record that a commit made of a held message before it retired the
 *  message's cell. A person's message to a workflow that a client sends
 *  again finds its earlier copy here once that copy's cell is gone. */
export async function workflowContextRecordsAddendum(reader: AsyncEventStateReadSurface, sessionId: string, key: string): Promise<boolean> {
  const state = await createWorkflowContextProjection(reader, sessionId).replay()
  return state.accumulator.serialize().addenda.some((addendum) => addendum.key === key)
}

export function accumulatorStateFromProjection(state: ContextProjectionState): AccumulatorState | null {
  const serialized = state.accumulator.serialize()
  return serialized.entries.length === 0 && Object.keys(serialized.artifacts).length === 0 ? null : serialized
}

export function contextFromProjection(
  state: ContextProjectionState,
  recipient?: ContextRecipient,
): AccumulatedContext {
  return state.accumulator.getContext(recipient)
}

function initialState(): ContextProjectionState {
  return { accumulator: createContextAccumulator() }
}

function reduceContextEvent(state: ContextProjectionState, event: StoredFact): ContextProjectionState {
  const fact = parseProjectionFact(event, parseWorkflowContextFact)
  switch (fact.type) {
    case "context.input.seeded":
      state.accumulator.seedInput({ ...fact.payload, timestamp: event.timestamp })
      break
    case "context.accumulated": {
      const { entry, scope } = accumulatedEntry(fact)
      state.accumulator.accumulate(entry, scope)
      break
    }
    case "step_context.input.added": {
      const record = addendumRecord(fact)
      if (record.kind === "addressed") state.accumulator.address(record.addendum, event)
      else state.accumulator.add(record.addendum, event, record.scope)
      break
    }
  }
  return state
}
