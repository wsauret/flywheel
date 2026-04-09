import type { DispatcherDecision, EvaluatorResult, QuestionInfo, QuestionAnswer } from "./workflow-types";
import type { SubprocessResult, SubprocessFailureReason, NDJSONEvent } from "./subprocess-types";

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
  | SubprocessSpawned
  | SubprocessCompleted
  | SubprocessFailed
  | SubprocessRetrying
  | SubprocessOutput
  | SubprocessNDJSON
  | SubprocessInjected
  | ApprovalRequested
  | ApprovalReceived
  | QuestionAsked
  | QuestionReplied
  | QuestionRejected
  | BudgetExhausted
  | QueueInitialized
  | QueueCompleted
  | QueueFailed
  | QueueStepStarted
  | QueueStepCompleted
  | QueueStepFailed
  | QueueStepInserted
  | QueueStepRemoved
  | TraceToolStarted
  | TraceToolCompleted
  | TraceSubagentStarted
  | TraceSubagentCompleted;

// -- Dispatcher events --

export interface DispatcherInvoked {
  type: "dispatcher:invoked";
  workflowId: string;
  stepIndex: number;
  timestamp: number;
}

export interface DispatcherCompleted {
  type: "dispatcher:completed";
  workflowId: string;
  decision: DispatcherDecision;
  timestamp: number;
}

export interface DispatcherFailed {
  type: "dispatcher:failed";
  workflowId: string;
  reason: string;
  timestamp: number;
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
  timestamp: number;
}

export interface EvaluatorCompleted {
  type: "evaluator:completed";
  workflowId: string;
  result: EvaluatorResult;
  timestamp: number;
}

export interface EvaluatorFailed {
  type: "evaluator:failed";
  workflowId: string;
  reason: string;
  timestamp: number;
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

// -- Subprocess events --

export interface SubprocessSpawned {
  type: "subprocess:spawned";
  workflowId: string;
  stepIndex: number;
  timestamp: number;
}

export interface SubprocessCompleted {
  type: "subprocess:completed";
  workflowId: string;
  result: SubprocessResult;
  timestamp: number;
}

export interface SubprocessFailed {
  type: "subprocess:failed";
  workflowId: string;
  failure: SubprocessFailureReason;
  timestamp: number;
}

export interface SubprocessRetrying {
  type: "subprocess:retrying";
  workflowId: string;
  attempt: number;
  maxAttempts: number;
  reason: string;
  timestamp: number;
}

export interface SubprocessOutput {
  type: "subprocess:output";
  workflowId: string;
  stream: "stdout" | "stderr";
  data: string;
  timestamp: number;
  /** Engine that produced this output (e.g. "claude", "opencode"). Optional for backward compat. */
  engineId?: string;
}

/**
 * A parsed NDJSON event from a subprocess.
 *
 * Distinct from `subprocess:output` which carries raw stdout/stderr chunks for display.
 * `subprocess:ndjson` carries parsed NDJSON events for consumption by budget tracking,
 * tracing, transcript persistence, and stream observers.
 */
export interface SubprocessNDJSON {
  type: "subprocess:ndjson";
  workflowId: string;
  ndjsonEvent: NDJSONEvent;
  timestamp: number;
}

export interface SubprocessInjected {
  type: "subprocess:injected";
  workflowId: string;
  message: string;
  timestamp: number;
}

// -- Approval events --

export interface ApprovalRequested {
  type: "approval:requested";
  workflowId: string;
  stepIndex: number;
  description: string;
  timestamp: number;
}

export interface ApprovalReceived {
  type: "approval:received";
  workflowId: string;
  approved: boolean;
  skipped: boolean;
  timestamp: number;
}

// -- Question events --

export interface QuestionAsked {
  type: "question:asked";
  requestId: string;
  questions: QuestionInfo[];
  timestamp: number;
}

export interface QuestionReplied {
  type: "question:replied";
  requestId: string;
  answers: QuestionAnswer[];
  timestamp: number;
}

export interface QuestionRejected {
  type: "question:rejected";
  requestId: string;
  timestamp: number;
}

// -- Budget events --

export interface BudgetExhausted {
  type: "budget:exhausted";
  workflowId: string;
  reason: string;
  timestamp: number;
}

// -- Queue lifecycle events --

export interface QueueInitialized {
  type: "queue:initialized";
  workflowId: string;
  /** IDs of all steps in the initial queue. */
  stepIds: string[];
  timestamp: number;
}

export interface QueueCompleted {
  type: "queue:completed";
  workflowId: string;
  /** Number of steps that completed successfully. */
  stepsCompleted: number;
  timestamp: number;
}

export interface QueueFailed {
  type: "queue:failed";
  workflowId: string;
  reason: string;
  /** Number of steps that completed before the failure. */
  stepsCompleted: number;
  timestamp: number;
}

// -- Queue step lifecycle events --

export interface QueueStepStarted {
  type: "queue:step-started";
  workflowId: string;
  stepId: string;
  stepType: string;
  stepTitle: string;
  timestamp: number;
}

export interface QueueStepCompleted {
  type: "queue:step-completed";
  workflowId: string;
  stepId: string;
  stepType: string;
  stepTitle: string;
  timestamp: number;
}

export interface QueueStepFailed {
  type: "queue:step-failed";
  workflowId: string;
  stepId: string;
  stepType: string;
  stepTitle: string;
  reason: string;
  timestamp: number;
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
  timestamp: number;
}

export interface QueueStepRemoved {
  type: "queue:step-removed";
  workflowId: string;
  stepId: string;
  stepType: string;
  stepTitle: string;
  timestamp: number;
}

// -- Trace events (from NDJSON pipeline) --

export interface TraceToolStarted {
  type: "trace:tool-started";
  workflowId: string;
  toolUseId: string;
  toolName: string;
  toolInput: string;
  timestamp: number;
}

export interface TraceToolCompleted {
  type: "trace:tool-completed";
  workflowId: string;
  toolUseId: string;
  toolOutput: string;
  isError: boolean;
  timestamp: number;
}

export interface TraceSubagentStarted {
  type: "trace:subagent-started";
  workflowId: string;
  toolUseId: string;
  agentType: string;
  description: string;
  prompt: string;
  timestamp: number;
}

export interface TraceSubagentCompleted {
  type: "trace:subagent-completed";
  workflowId: string;
  toolUseId: string;
  result: string;
  isError: boolean;
  timestamp: number;
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

export type ModelActivity = "idle" | "thinking" | "generating" | "tool_executing";
