import { errorMessage } from "../../infra/error-message.js"
import type { WorkflowView } from "../view/types.js"
import type { WorkflowTransitionResult } from "./commands.js"
import { WorkflowCommitStorageError } from "./commit-host.js"
import { publishedDefinitionDrift, WorkflowDefinitionDriftError } from "./definition-identity.js"
import { workflowDriftExplanation } from "../../protocol/client/workflow-drift-copy.js"
import {
  WorkflowAttemptRefusedError,
  WorkflowDriftEvidencePersistenceError,
  WorkflowHostFollowUpError,
  WorkflowHostInterruptionError,
  WorkflowHostLifecycleError,
  WorkflowHostStorageError,
  WorkflowHostWorkerError,
  WorkflowMalformedStateError,
  WorkflowPreCutoverError,
  type WorkflowVmHostFailure,
  type WorkflowVmHostRunResult,
} from "./host-types.js"

export function lifecycleError(operation: string, message: string): WorkflowHostLifecycleError {
  return new WorkflowHostLifecycleError({ operation, message, failures: [] })
}

export function toPublicFailure(error: unknown): WorkflowVmHostFailure {
  if (error instanceof WorkflowAttemptRefusedError) return { kind: "attempt_refused", attemptId: error.attemptId, message: error.message }
  if (error instanceof WorkflowHostStorageError) return { kind: "storage", operation: error.operation, message: error.message }
  if (error instanceof WorkflowHostWorkerError) return { kind: "worker", attemptId: error.attemptId, message: error.message }
  if (error instanceof WorkflowHostFollowUpError) return { kind: "follow_up", conversationId: error.conversationId, message: error.message }
  if (error instanceof WorkflowHostInterruptionError) return { kind: "interruption", operation: error.operation, message: error.message }
  if (error instanceof WorkflowHostLifecycleError) {
    return { kind: "lifecycle", operation: error.operation, message: error.message, failures: [...error.failures] }
  }
  if (error instanceof WorkflowDefinitionDriftError) {
    return {
      kind: "definition_drift",
      workflowId: error.workflowId,
      message: workflowDriftExplanation(publishedDefinitionDrift(error.workflowId, error.changes)),
    }
  }
  if (error instanceof WorkflowPreCutoverError) return { kind: "pre_cutover", sessionId: error.sessionId, message: error.message }
  if (error instanceof WorkflowMalformedStateError) return { kind: "malformed_state", sessionId: error.sessionId, message: error.message }
  if (error instanceof WorkflowDriftEvidencePersistenceError) return { kind: "drift_evidence_persistence", workflowId: error.workflowId, message: error.message }
  if (error instanceof WorkflowCommitStorageError) return { kind: "storage", operation: "commit", message: error.message }
  return { kind: "lifecycle", operation: "host", message: errorMessage(error), failures: [] }
}

export function publicFailureCause(failure: WorkflowVmHostFailure): Error {
  switch (failure.kind) {
    case "attempt_refused": return new WorkflowAttemptRefusedError({ attemptId: failure.attemptId, message: failure.message })
    case "storage": return new WorkflowHostStorageError({ operation: failure.operation, message: failure.message })
    case "worker": return new WorkflowHostWorkerError({ attemptId: failure.attemptId, message: failure.message })
    case "follow_up": return new WorkflowHostFollowUpError({ conversationId: failure.conversationId, message: failure.message })
    case "interruption": return new WorkflowHostInterruptionError({ operation: failure.operation, message: failure.message })
    case "lifecycle": return new WorkflowHostLifecycleError({ operation: failure.operation, message: failure.message, failures: [...failure.failures] })
    case "definition_drift": return lifecycleError("definition_drift", failure.message)
    case "pre_cutover": return new WorkflowPreCutoverError({ sessionId: failure.sessionId, message: failure.message })
    case "malformed_state": return new WorkflowMalformedStateError({ sessionId: failure.sessionId, message: failure.message })
    case "drift_evidence_persistence": return new WorkflowDriftEvidencePersistenceError({ workflowId: failure.workflowId, message: failure.message })
    case "workflow": return lifecycleError("workflow", failure.message)
  }
}

export function failureResult(failure: WorkflowVmHostFailure): WorkflowVmHostRunResult {
  return { kind: "failed", failure }
}

export function terminalResult(
  result: WorkflowTransitionResult,
  view: WorkflowView,
  pauseReason: string,
  refusalReason?: string,
): WorkflowVmHostRunResult {
  const controlSeq = result.state.context.committed.aggregateSeq
  if (result.state.lifecycle === "failed") {
    return { kind: "failed", failure: { kind: "workflow", message: refusalReason ?? "Workflow failed" }, view, controlSeq }
  }
  if (result.state.lifecycle !== "completed" && result.state.lifecycle !== "paused") {
    return {
      kind: "failed",
      failure: {
        kind: "lifecycle",
        operation: "protocol",
        message: `Workflow host stalled in ${result.state.lifecycle}`,
        failures: [],
      },
      view,
      controlSeq,
    }
  }
  const attemptsCompleted = view.attempts.filter(({ status }) => status === "completed").length
  const attemptsTotal = view.attempts.length
  return result.state.lifecycle === "completed"
    ? { kind: "completed", view, attemptsCompleted, attemptsTotal, controlSeq }
    : { kind: "paused", reason: pauseReason, view, attemptsCompleted, attemptsTotal, controlSeq }
}
