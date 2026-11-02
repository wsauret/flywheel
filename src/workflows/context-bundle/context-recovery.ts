import { CorruptEventRowError, type AsyncEventStateReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { isRecord } from "../../infra/record.js"
import { parseWorkflowSessionFact, workflowAggregateId, type WorkflowRecoveryDegradationReason, type WorkflowSessionFact } from "../vm/session-facts.js"
import { WORKFLOW_ROOT_FACT_TYPES, workflowFamilyBoundary } from "../workflow-root.js"
import { parseWorkflowContextFact, WORKFLOW_CONTEXT_FACT_TYPES, type WorkflowContextFact } from "./context-facts.js"

type Seed = Extract<WorkflowContextFact, { type: "context.input.seeded" }>
type Recorded = Exclude<WorkflowContextFact, { type: "context.input.seeded" }>
export interface RecoveredWorkflowContext {
  readonly seed: { readonly fact: Seed; readonly timestamp: number } | null
  /** Handoff entries and request addenda in one recorded order. The context
   *  places a branch addendum that a join promotes at the join entry's
   *  position, so recovery keeps entries and addenda interleaved as they
   *  were recorded. */
  readonly records: readonly { readonly fact: Recorded; readonly timestamp: number }[]
  readonly reasons: readonly WorkflowRecoveryDegradationReason[]
}

const CONTEXT_FACT_TYPES: ReadonlySet<string> = new Set(WORKFLOW_CONTEXT_FACT_TYPES)

/** Reads the original input in the current recoverable epoch without publishing recovery. */
export async function readWorkflowInputSeed(reader: AsyncEventStateReadSurface, sessionId: string): Promise<string | null> {
  const { facts } = await reader.readSlice({
    aggregateId: workflowAggregateId(sessionId),
    types: [...WORKFLOW_ROOT_FACT_TYPES, "attempt.recovered", "context.input.seeded"],
  }, true)
  const context = recoverWorkflowContext(facts)
  return context.seed?.fact.payload.userRequest ?? null
}

/** Recover context in its current epoch without changing historical bytes.
 * The old v1 two-fact recovery batch carried no context at all. Only that exact
 * producer shape permits reading its predecessor epoch. Valid initialization
 * preserves its preceding input seed; malformed and unsupported roots fence. */
export function recoverWorkflowContext(events: readonly (StoredFact | CorruptEventRowError)[]): RecoveredWorkflowContext {
  let start = 0
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // SAFETY: The reverse loop bounds index within this unchanged event array.
    const event = events[index]!
    const type = event instanceof CorruptEventRowError ? event.row.type : event.type
    if (!WORKFLOW_ROOT_FACT_TYPES.some((rootType) => rootType === type)) continue
    if (contextlessRecoveryRoot(event, events[index + 1])) continue
    try {
      if (workflowFamilyBoundary([event]) === null) continue
    } catch {
      // An unreadable root still fences context, but readable later facts can survive.
    }
    start = index + 1
    break
  }
  let seed: RecoveredWorkflowContext["seed"] = null
  const records: Array<{ fact: Recorded; timestamp: number }> = []
  const reasons: WorkflowRecoveryDegradationReason[] = []
  for (const event of events.slice(start)) {
    const envelope = event instanceof CorruptEventRowError ? event.row : event
    if (!CONTEXT_FACT_TYPES.has(envelope.type)) continue
    try {
      // oxlint-disable-next-line no-throw-literal -- CorruptEventRowError extends Error and retains the damaged row evidence.
      if (event instanceof CorruptEventRowError) throw event
      const fact = recoverContextFact(event)
      if (fact.type === "context.input.seeded") seed = { fact, timestamp: event.timestamp }
      else records.push({ fact, timestamp: event.timestamp })
    } catch {
      reasons.push({ kind: "malformed_fact", seq: envelope.seq })
    }
  }
  return { seed, records, reasons }
}

function recoverContextFact(event: StoredFact): WorkflowContextFact {
  const envelope = { type: event.type, version: event.version, actor: event.actor, payload: event.payload }
  try {
    return parseWorkflowContextFact(envelope)
  } catch (error) {
    // v3 predates addressed blocker reports; its handoff was ordinary prior context.
    if (event.type !== "context.accumulated" || event.version !== 3 || !isRecord(event.payload.entry) || "recipientStepId" in event.payload.entry) throw error
    return parseWorkflowContextFact({
      ...envelope,
      version: 4,
      payload: { ...event.payload, entry: { ...event.payload.entry, recipientStepId: null } },
    })
  }
}

/** Recognize the historical v1 two-fact recovery producer, returning its strictly
 * decoded root. Unreadable or uncorrelated pairs establish no provenance. */
export function contextlessRecoveryRoot(
  event: StoredFact | CorruptEventRowError,
  evidence: StoredFact | CorruptEventRowError | undefined,
): Extract<WorkflowSessionFact, { type: "workflow.control.recovered"; version: 1 }> | null {
  if (event instanceof CorruptEventRowError || !evidence || evidence instanceof CorruptEventRowError) return null
  try {
    const root = parseWorkflowSessionFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
    const attempt = parseWorkflowSessionFact({ type: evidence.type, version: evidence.version, actor: evidence.actor, payload: evidence.payload })
    if (root.type !== "workflow.control.recovered" || root.version !== 1) return null
    return root.payload.control.aggregateSeq === event.seq + 2
      && root.payload.supersededThroughSeq === Math.max(event.seq - 1, 0)
      && evidence.seq === event.seq + 1
      && attempt.type === "attempt.recovered"
      && attempt.payload.attemptId === root.payload.identities.attempt?.value
      && attempt.payload.conversationId === root.payload.identities.conversation?.value
      ? root : null
  } catch {
    return null
  }
}
