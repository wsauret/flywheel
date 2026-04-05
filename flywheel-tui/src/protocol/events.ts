import type { DispatcherDecision } from "../workflows/dispatcher/schemas";
import type { EvaluatorResult } from "../workflows/evaluator/schemas";
import type { WorkerResult, WorkerFailureReason } from "../orchestration/worker/schemas";
import type { QuestionInfo, QuestionAnswer } from "../workflows/queue/question-service";

// ---------------------------------------------------------------------------
// FlywheelEvent discriminated union (~25 event types, namespace:verb naming)
// ---------------------------------------------------------------------------

export type FlywheelEvent =
  | DispatcherInvoked
  | DispatcherCompleted
  | DispatcherFailed
  | DispatcherOutput
  | EvaluatorInvoked
  | EvaluatorCompleted
  | EvaluatorFailed
  | EvaluatorRevisionRequested
  | EvaluatorOutput
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
  | BudgetWarning
  | BudgetExhausted
  | QueueInitialized
  | QueueCompleted
  | QueueFailed
  | QueueStepStarted
  | QueueStepCompleted
  | QueueStepFailed
  | QueueStepInserted
  | QueueStepRemoved;

// -- Dispatcher events --

export interface DispatcherInvoked {
  type: "dispatcher:invoked";
  workflowId: string;
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

export interface DispatcherOutput {
  type: "dispatcher:output";
  workflowId: string;
  stream: "stdout" | "stderr";
  data: string;
  engineName: string;
  timestamp: number;
}

// -- Evaluator events --

export interface EvaluatorInvoked {
  type: "evaluator:invoked";
  workflowId: string;
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

export interface EvaluatorRevisionRequested {
  type: "evaluator:revision-requested";
  workflowId: string;
  stepIndex: number;
  revisionAttempt: number;
  maxRevisions: number;
  reason: string;
  timestamp: number;
}

export interface EvaluatorOutput {
  type: "evaluator:output";
  workflowId: string;
  stream: "stdout" | "stderr";
  data: string;
  engineName: string;
  timestamp: number;
}

// -- Worker events --

export interface WorkerSpawned {
  type: "worker:spawned";
  workflowId: string;
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

// -- Queue lifecycle events --

export interface QueueInitialized {
  type: "queue:initialized";
  workflowId: string;
  /** IDs of all steps in the initial queue. */
  stepIds: string[];
  timestamp: string;
}

export interface QueueCompleted {
  type: "queue:completed";
  workflowId: string;
  /** Number of steps that completed successfully. */
  stepsCompleted: number;
  timestamp: string;
}

export interface QueueFailed {
  type: "queue:failed";
  workflowId: string;
  reason: string;
  /** Number of steps that completed before the failure. */
  stepsCompleted: number;
  timestamp: string;
}

// -- Queue step lifecycle events --

export interface QueueStepStarted {
  type: "queue:step-started";
  workflowId: string;
  stepId: string;
  stepType: string;
  stepTitle: string;
  timestamp: string;
}

export interface QueueStepCompleted {
  type: "queue:step-completed";
  workflowId: string;
  stepId: string;
  stepType: string;
  stepTitle: string;
  timestamp: string;
}

export interface QueueStepFailed {
  type: "queue:step-failed";
  workflowId: string;
  stepId: string;
  stepType: string;
  stepTitle: string;
  reason: string;
  timestamp: string;
}

// -- Queue mutation events --

export interface QueueStepInserted {
  type: "queue:step-inserted";
  workflowId: string;
  stepId: string;
  stepType: string;
  stepTitle: string;
  /** ID of the step after which this step was inserted. */
  afterStepId: string;
  timestamp: string;
}

export interface QueueStepRemoved {
  type: "queue:step-removed";
  workflowId: string;
  stepId: string;
  stepType: string;
  stepTitle: string;
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
