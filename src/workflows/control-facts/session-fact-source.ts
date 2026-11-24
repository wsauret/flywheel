import { CorruptEventRowError, type AsyncEventStateReadSurface, type StoredFact } from "../../infra/store/event-store-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { WORKFLOW_RUN_FACT_TYPES, workflowAggregateId } from "../run/run-facts.js"
import { selectNewestWorkflowRoot, workflowFamilyBoundary, WORKFLOW_ROOT_FACT_TYPES } from "./workflow-root.js"

const INITIALIZED_FACT_TYPE = "workflow.control.initialized"

/** Selects the only aggregate whose workflow facts are valid for a session. */
export async function selectWorkflowFactSource(reader: AsyncEventStateReadSurface, sessionId: string): Promise<string> {
  const workflowId = workflowAggregateId(sessionId)
  await readWorkflowProjectionBoundary(reader, workflowId)
  return workflowId
}

/** The reset boundary of a workflow family projection: the newest recovery
 * root replaces the family state, and a newer ordinary launch root keeps it. */
export function workflowProjectionBoundary(reader: AsyncEventStateReadSurface, aggregateId: string) {
  return {
    types: WORKFLOW_ROOT_FACT_TYPES,
    read: () => readWorkflowProjectionBoundary(reader, aggregateId),
    within: (facts: readonly (StoredFact | CorruptEventRowError)[]) => workflowFamilyBoundary(facts)?.position,
  }
}

/** Read the validated family reset position through bounded root-type probes.
 * An aggregate without control history has no boundary; rootless control
 * history is invalid. */
async function readWorkflowProjectionBoundary(reader: AsyncEventStateReadSurface, aggregateId: string): Promise<number | undefined> {
  const { facts: roots } = await reader.readSlice(
    { aggregateId, types: WORKFLOW_ROOT_FACT_TYPES, order: "desc", limit: 1 },
    true,
  )
  if (!selectNewestWorkflowRoot(roots) && await holdsControlHistory(reader, aggregateId)) throw missingInitialization(aggregateId, 0)
  return workflowFamilyBoundary(roots)?.position
}

/** Only a rootless aggregate reaches this probe, so its run-fact read stays small. */
async function holdsControlHistory(reader: AsyncEventStateReadSurface, aggregateId: string): Promise<boolean> {
  const total = await reader.countByAggregate(aggregateId)
  if (total === 0) return false
  const { facts: runFacts } = await reader.readSlice({ aggregateId, types: WORKFLOW_RUN_FACT_TYPES }, true)
  return total > runFacts.length
}

function missingInitialization(aggregateId: string, eventPosition: number): InvariantViolation {
  return new InvariantViolation({
    kind: "missing-producer-event",
    eventType: INITIALIZED_FACT_TYPE,
    eventPosition,
    aggregateId,
    detail: `nonempty workflow aggregate ${aggregateId} has no ${INITIALIZED_FACT_TYPE} marker`,
  })
}
