import type { DispatcherDecision, EvaluatorResult } from "./workflow-types";
import type { NDJSONEvent } from "./subprocess-types";

// ---------------------------------------------------------------------------
// FlywheelEvent discriminated union (namespace:verb naming)
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
  | SubprocessOutput
  | SubprocessNDJSON
  | SubprocessInjected
  | BudgetMetricsChanged
  | BudgetExhausted
  | QueueInitialized
  | QueueCompleted
  | QueueFailed
  | QueueStepStarted
  | QueueStepCompleted
  | QueueStepFailed
  | TraceToolStarted
  | TraceToolCompleted
  | TraceSubagentStarted
  | TraceSubagentCompleted;

// -- Dispatcher events --

interface DispatcherInvoked {
  type: "dispatcher:invoked";
  workflowId: string;
  stepIndex: number;
  timestamp: number;
}

interface DispatcherCompleted {
  type: "dispatcher:completed";
  workflowId: string;
  decision: DispatcherDecision;
  timestamp: number;
}

interface DispatcherFailed {
  type: "dispatcher:failed";
  workflowId: string;
  reason: string;
  timestamp: number;
}

interface DispatcherOutput {
  type: "dispatcher:output";
  workflowId: string;
  stream: "stdout" | "stderr";
  data: string;
  engineName: string;
  timestamp: number;
}

// -- Evaluator events --

interface EvaluatorInvoked {
  type: "evaluator:invoked";
  workflowId: string;
  stepIndex: number;
  timestamp: number;
}

interface EvaluatorCompleted {
  type: "evaluator:completed";
  workflowId: string;
  result: EvaluatorResult;
  timestamp: number;
}

interface EvaluatorFailed {
  type: "evaluator:failed";
  workflowId: string;
  reason: string;
  timestamp: number;
}

interface EvaluatorRevisionRequested {
  type: "evaluator:revision-requested";
  workflowId: string;
  stepIndex: number;
  revisionAttempt: number;
  maxRevisions: number;
  reason: string;
  timestamp: number;
}

interface EvaluatorOutput {
  type: "evaluator:output";
  workflowId: string;
  stream: "stdout" | "stderr";
  data: string;
  engineName: string;
  timestamp: number;
}

// -- Subprocess events --

interface SubprocessSpawned {
  type: "subprocess:spawned";
  workflowId: string;
  stepIndex: number;
  timestamp: number;
}

interface SubprocessOutput {
  type: "subprocess:output";
  workflowId: string;
  stream: "stdout" | "stderr";
  data: string;
  timestamp: number;
  /** Engine that produced this output (e.g. "claude", "opencode"). */
  engineId: string;
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

interface SubprocessInjected {
  type: "subprocess:injected";
  workflowId: string;
  message: string;
  timestamp: number;
  /** Who originated this message. "user" = typed by the user (steering/chat). "system" = observer, self-review, etc. */
  origin: "user" | "system";
  /** True when this is a user-steering message shown immediately as pending. */
  pending?: boolean;
}

// -- Budget events --

interface BudgetMetricsChanged {
  type: "budget:metrics-changed";
  workflowId: string;
  tokens: number;
  cost: number;
  timestamp: number;
}

interface BudgetExhausted {
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

// -- Trace events (from NDJSON pipeline) --

interface TraceToolStarted {
  type: "trace:tool-started";
  workflowId: string;
  toolUseId: string;
  toolName: string;
  toolInput: string;
  timestamp: number;
}

interface TraceToolCompleted {
  type: "trace:tool-completed";
  workflowId: string;
  toolUseId: string;
  toolOutput: string;
  isError: boolean;
  timestamp: number;
}

interface TraceSubagentStarted {
  type: "trace:subagent-started";
  workflowId: string;
  toolUseId: string;
  agentType: string;
  description: string;
  prompt: string;
  timestamp: number;
}

interface TraceSubagentCompleted {
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
