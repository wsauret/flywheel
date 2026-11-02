import { CorruptEventRowError, type AsyncEventStateReadSurface, type StoredFact } from "../infra/event-store-types.js"
import { InvariantViolation } from "../infra/invariant.js"
import { WORKFLOW_RUN_FACT_TYPES } from "./run-facts.js"
import { workflowAggregateId } from "./vm/session-facts.js"
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
export async function readWorkflowProjectionBoundary(reader: AsyncEventStateReadSurface, aggregateId: string): Promise<number | undefined> {
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

/** The commit time of the session's first workflow root, which is the launch,
 * or null before the launch commits. A recovery root keeps this launch: it
 * restarts a task inside the same workflow. The envelope timestamp needs no
 * payload decode, so a tolerant read keeps a launch row that no longer parses. */
export async function readWorkflowLaunchedAt(reader: AsyncEventStateReadSurface, sessionId: string): Promise<number | null> {
  const { facts } = await reader.readSlice(
    { aggregateId: workflowAggregateId(sessionId), types: [INITIALIZED_FACT_TYPE], order: "asc", limit: 1 },
    true,
  )
  const launch = facts[0]
  if (!launch) return null
  return launch instanceof CorruptEventRowError ? launch.row.timestamp : launch.timestamp
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
