import type { DispatcherDecision } from "../schemas/dispatcher";
import type { EvaluatorResult } from "../schemas/evaluator";
import type { WorkerResult, WorkerFailureReason } from "../schemas/worker";
import type { ExecutionStatus } from "../schemas/execution";
import type { QuestionInfo, QuestionAnswer } from "../controller/question-service";

// ---------------------------------------------------------------------------
// FlywheelEvent discriminated union (~25 event types, namespace:verb naming)
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
  | WorkerOutput
  | WorkerInjected
  | ApprovalRequested
  | ApprovalReceived
  | QuestionAsked
  | QuestionReplied
  | QuestionRejected
  | PipelineStarted
  | PipelineCompleted
  | PipelineFailed
  | PipelineStageTransition
  | BudgetWarning
  | BudgetExhausted;

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

export interface WorkerOutput {
  type: "worker:output";
  workflowId: string;
  stream: "stdout" | "stderr";
  data: string;
  timestamp: string;
  /** Engine that produced this output (e.g. "claude", "opencode"). Optional for backward compat. */
  engineId?: string;
}

export interface WorkerInjected {
  type: "worker:injected";
  workflowId: string;
  message: string;
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

// -- Question events --

export interface QuestionAsked {
  type: "question:asked";
  requestId: string;
  questions: QuestionInfo[];
  timestamp: string;
}

export interface QuestionReplied {
  type: "question:replied";
  requestId: string;
  answers: QuestionAnswer[];
  timestamp: string;
}

export interface QuestionRejected {
  type: "question:rejected";
  requestId: string;
  timestamp: string;
}

// -- Pipeline events --

export interface PipelineStarted {
  type: "pipeline:started";
  pipelineId: string;
  stages: string[];
  timestamp: string;
}

export interface PipelineCompleted {
  type: "pipeline:completed";
  pipelineId: string;
  stagesCompleted: number;
  timestamp: string;
}

export interface PipelineFailed {
  type: "pipeline:failed";
  pipelineId: string;
  reason: string;
  stagesCompleted: number;
  timestamp: string;
}

export interface PipelineStageTransition {
  type: "pipeline:stage-transition";
  pipelineId: string;
  from: string;
  to: string;
  timestamp: string;
}

// -- Budget events --

export interface BudgetWarning {
  type: "budget:warning";
  workflowId: string;
  metric: "invocations" | "tokens" | "wall_clock";
  used: number;
  limit: number;
  remaining: number;
  timestamp: string;
}

export interface BudgetExhausted {
  type: "budget:exhausted";
  workflowId: string;
  reason: string;
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
