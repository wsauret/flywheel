import type { DispatcherDecision, EvaluatorResult } from "./workflow-types.js";
import type { NDJSONEvent } from "./subprocess-types.js";

/** Base shape shared by all flywheel events. */
type Ev<T extends string, P = {}> = { type: T; workflowId: string; timestamp: number } & P;

/**
 * A parsed NDJSON event from a subprocess.
 *
 * Distinct from `subprocess:output` which carries raw stdout/stderr chunks for display.
 * `subprocess:ndjson` carries parsed NDJSON events for consumption by budget tracking,
 * tracing, transcript persistence, and stream observers.
 */
export type SubprocessNDJSON = Ev<"subprocess:ndjson", { ndjsonEvent: NDJSONEvent }>;

export type FlywheelEvent =
  | Ev<"dispatcher:invoked", { stepIndex: number }>
  | Ev<"dispatcher:completed", { decision: DispatcherDecision }>
  | Ev<"dispatcher:failed", { reason: string }>
  | Ev<"dispatcher:output", { stream: "stdout" | "stderr"; data: string; engineName: string }>
  | Ev<"evaluator:invoked", { stepIndex: number }>
  | Ev<"evaluator:completed", { result: EvaluatorResult }>
  | Ev<"evaluator:failed", { reason: string }>
  | Ev<"evaluator:revision-requested", { stepIndex: number; revisionAttempt: number; maxRevisions: number; reason: string }>
  | Ev<"evaluator:output", { stream: "stdout" | "stderr"; data: string; engineName: string }>
  | Ev<"subprocess:spawned", { stepIndex: number }>
  | Ev<"subprocess:output", { stream: "stdout" | "stderr"; data: string; engineId: string }>
  | SubprocessNDJSON
  | Ev<"subprocess:injected", { message: string; origin: "user" | "system"; pending?: boolean }>
  | Ev<"budget:metrics-changed", { tokens: number; cost: number }>
  | Ev<"budget:exhausted", { reason: string }>
  | Ev<"queue:initialized", { stepIds: string[] }>
  | Ev<"queue:completed", { stepsCompleted: number }>
  | Ev<"queue:failed", { reason: string; stepsCompleted: number }>
  | Ev<"queue:step-started", { stepId: string; stepType: string; stepTitle: string }>
  | Ev<"queue:step-completed", { stepId: string; stepType: string; stepTitle: string }>
  | Ev<"queue:step-failed", { stepId: string; stepType: string; stepTitle: string; reason: string }>
  | Ev<"trace:tool-started", { toolUseId: string; toolName: string; toolInput: string }>
  | Ev<"trace:tool-completed", { toolUseId: string; toolOutput: string; isError: boolean }>
  | Ev<"trace:subagent-started", { toolUseId: string; agentType: string; description: string; prompt: string }>
  | Ev<"trace:subagent-completed", { toolUseId: string; result: string; isError: boolean }>;

// Placed here (not in a generic utils file) because its error message references FlywheelEvent
// and its only consumer (tui/adapters/opentui.ts) already imports from this module.
export function assertNever(event: never): never {
  throw new Error(`Unhandled event type: ${(event as FlywheelEvent).type}`);
}

// Not an event type — a domain state enum. Co-located here because both
// infra/output (StructuredOutputBuilder) and orchestration (session-store-types)
// import it, and placing it in either layer would create a wrong-direction import.
export type ModelActivity = "idle" | "thinking" | "generating" | "tool_executing";
