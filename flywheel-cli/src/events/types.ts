import type { DispatcherDecision } from "../schemas/dispatcher";
import type { EvaluatorResult } from "../schemas/evaluator";
import type { WorkerResult, WorkerFailureReason } from "../schemas/worker";
import type { ExecutionStatus } from "../schemas/execution";

// ---------------------------------------------------------------------------
// FlywheelEvent discriminated union (~22 event types, namespace:verb naming)
// ---------------------------------------------------------------------------

export type FlywheelEvent =
  | WorkflowStarted
  | WorkflowCompleted
  | WorkflowFailed
  | WorkflowInterrupted
  | PhaseStarted
  | PhaseCompleted
  | PhaseFailed
  | StepStarted
  | StepCompleted
  | StepFailed
  | DispatcherInvoked
  | DispatcherCompleted
  | DispatcherFailed
  | EvaluatorInvoked
  | EvaluatorCompleted
  | EvaluatorFailed
  | WorkerSpawned
  | WorkerCompleted
  | WorkerFailed
  | WorkerRetrying
  | ApprovalRequested
  | ApprovalReceived;

// -- Workflow events --

export interface WorkflowStarted {
  type: "workflow:started";
  workflowId: string;
  planPath: string;
  timestamp: string;
}

export interface WorkflowCompleted {
  type: "workflow:completed";
  workflowId: string;
  timestamp: string;
}

export interface WorkflowFailed {
  type: "workflow:failed";
  workflowId: string;
  reason: string;
  timestamp: string;
}

export interface WorkflowInterrupted {
  type: "workflow:interrupted";
  workflowId: string;
  reason: string;
  timestamp: string;
}

// -- Phase events --

export interface PhaseStarted {
  type: "phase:started";
  workflowId: string;
  phaseIndex: number;
  phaseName: string;
  timestamp: string;
}

export interface PhaseCompleted {
  type: "phase:completed";
  workflowId: string;
  phaseIndex: number;
  timestamp: string;
}

export interface PhaseFailed {
  type: "phase:failed";
  workflowId: string;
  phaseIndex: number;
  reason: string;
  timestamp: string;
}

// -- Step events --

export interface StepStarted {
  type: "step:started";
  workflowId: string;
  phaseIndex: number;
  stepIndex: number;
  description: string;
  timestamp: string;
}

export interface StepCompleted {
  type: "step:completed";
  workflowId: string;
  phaseIndex: number;
  stepIndex: number;
  timestamp: string;
}

export interface StepFailed {
  type: "step:failed";
  workflowId: string;
  phaseIndex: number;
  stepIndex: number;
  reason: string;
  timestamp: string;
}

// -- Dispatcher events --

export interface DispatcherInvoked {
  type: "dispatcher:invoked";
  workflowId: string;
  phaseIndex: number;
  stepIndex: number;
  timestamp: string;
}

export interface DispatcherCompleted {
  type: "dispatcher:completed";
  workflowId: string;
  decision: DispatcherDecision;
  timestamp: string;
}

export interface DispatcherFailed {
  type: "dispatcher:failed";
  workflowId: string;
  reason: string;
  timestamp: string;
}

// -- Evaluator events --

export interface EvaluatorInvoked {
  type: "evaluator:invoked";
  workflowId: string;
  phaseIndex: number;
  stepIndex: number;
  timestamp: string;
}

export interface EvaluatorCompleted {
  type: "evaluator:completed";
  workflowId: string;
  result: EvaluatorResult;
  timestamp: string;
}

export interface EvaluatorFailed {
  type: "evaluator:failed";
  workflowId: string;
  reason: string;
  timestamp: string;
}

// -- Worker events --

export interface WorkerSpawned {
  type: "worker:spawned";
  workflowId: string;
  phaseIndex: number;
  stepIndex: number;
  timestamp: string;
}

export interface WorkerCompleted {
  type: "worker:completed";
  workflowId: string;
  result: WorkerResult;
  timestamp: string;
}

export interface WorkerFailed {
  type: "worker:failed";
  workflowId: string;
  failure: WorkerFailureReason;
  timestamp: string;
}

export interface WorkerRetrying {
  type: "worker:retrying";
  workflowId: string;
  attempt: number;
  maxAttempts: number;
  reason: string;
  timestamp: string;
}

// -- Approval events --

export interface ApprovalRequested {
  type: "approval:requested";
  workflowId: string;
  phaseIndex: number;
  stepIndex: number;
  description: string;
  timestamp: string;
}

export interface ApprovalReceived {
  type: "approval:received";
  workflowId: string;
  approved: boolean;
  skipped: boolean;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Exhaustiveness check helper
// ---------------------------------------------------------------------------

/**
 * Use in switch default case to ensure all FlywheelEvent types are handled.
 * TypeScript will error at compile time if a case is missing.
 */
export function assertNever(event: never): never {
  throw new Error(`Unhandled event type: ${(event as FlywheelEvent).type}`);
}
