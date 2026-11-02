import { CorruptEventRowError, type StoredFact } from "../../infra/event-store-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { recoverWorkflowContext } from "../context-bundle/context-recovery.js"
import { loadQueueFromEvents, QUEUE_FACT_TYPES } from "../view/view-projection.js"
import type { CommittedWorkflowControl } from "./committed-control.js"
import { recoverWorkflowControl, workflowRecoveryBasis, type WorkflowRecoveryPlan } from "./recovery.js"
import type { WorkflowRecoveryDegradationReason } from "./session-facts.js"
import { selectNewestWorkflowRoot } from "../workflow-root.js"

/** Execution needs strict control, a current-epoch queue with the same concrete
 * identities, and a canonical input seed. Inspection alone never repairs them. */
export function validateWorkflowBootstrap(facts: readonly (StoredFact | CorruptEventRowError)[]): WorkflowRecoveryPlan {
  const plan = recoverWorkflowControl(facts)
  const control = plan.executable ? plan.control : workflowRecoveryBasis(facts)
  if (!control) return plan
  const missing: WorkflowRecoveryDegradationReason[] = []
  // SAFETY: Both executable recovery and workflowRecoveryBasis require a root in these unchanged facts.
  const root = selectNewestWorkflowRoot(facts)!
  const epoch = root.type === "workflow.control.recovered" ? facts.slice(root.index + 1) : facts
  const context = recoverWorkflowContext(epoch)
  missing.push(...context.reasons)
  for (const fact of epoch) {
    if (fact instanceof CorruptEventRowError && QUEUE_FACT_TYPES.some((type) => type === fact.row.type)) missing.push({ kind: "malformed_fact", seq: fact.row.seq })
  }
  if (context.seed === null) missing.push({ kind: "missing_companion", family: "context.input.seeded" })
  const stored = facts.filter((fact): fact is StoredFact => !(fact instanceof CorruptEventRowError))
  try {
    const queue = loadQueueFromEvents(stored)
    if (!queue || !matchingIdentities(control, queue)) missing.push({ kind: "missing_companion", family: "queue.created" })
  } catch (error) {
    missing.push(unreadableQueueReason(stored, error) ?? { kind: "missing_companion", family: "queue.created" })
  }
  return missing.length === 0 ? plan : { kind: "recovery", executable: false, status: "paused", control: null, reasons: [...missing, ...(plan.executable ? [] : plan.reasons)] }
}

/** The attempt-row fact whose body this build cannot read, named as the
 *  reason, because the attempt list exists and only that fact fails. */
function unreadableQueueReason(facts: readonly StoredFact[], error: unknown): WorkflowRecoveryDegradationReason | undefined {
  if (!(error instanceof InvariantViolation) || error.kind !== "schema-mismatch") return undefined
  const fact = facts.find(({ position }) => position === error.eventPosition)
  return fact && { kind: "unknown_version", seq: fact.seq, type: fact.type, version: fact.version }
}

/** Whether the current-epoch queue names the same concrete attempts and follow-up as control. */
export function matchingIdentities(control: CommittedWorkflowControl, queue: NonNullable<ReturnType<typeof loadQueueFromEvents>>): boolean {
  return queue.attempts.length === control.attempts.length
    && queue.attempts.every((row, index) => {
      // SAFETY: The preceding length equality bounds each queue index within control.attempts.
      const attempt = control.attempts[index]!
      return row.id === attempt.id && (row.lastConversationId ?? null) === attempt.conversationId
        && row.definitionId === attempt.definitionId && row.workflowDefinitionId === attempt.workflowDefinitionId
    })
    && (queue.followUpConversationId ?? null) === (control.followUp?.conversationId ?? null)
}
