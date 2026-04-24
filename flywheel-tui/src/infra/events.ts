import type { DispatcherDecision } from "./workflow-types.js";
import type { NDJSONEvent } from "./ndjson-event-types.js";

/** Base shape shared by all flywheel events. */
type Ev<T extends string, P = {}> = { type: T; workflowId: string; timestamp: number } & P;

type EngineNDJSON = Ev<"engine:ndjson", { ndjsonEvent: NDJSONEvent }>;

export type FlywheelEvent =
  | Ev<"dispatcher:invoked", { stepIndex: number }>
  | Ev<"dispatcher:completed", { decision: DispatcherDecision }>
  | Ev<"dispatcher:failed", { reason: string }>
  | Ev<"dispatcher:ndjson", { ndjsonEvent: NDJSONEvent }>
  | Ev<"evaluator:invoked", { stepIndex: number }>
  | Ev<"evaluator:completed", { result: { passed: boolean; reasoning: string } }>
  | Ev<"evaluator:failed", { reason: string }>
  | Ev<"evaluator:ndjson", { ndjsonEvent: NDJSONEvent }>
  | Ev<"evaluator:revision-requested", { stepIndex: number; revisionAttempt: number; maxRevisions: number; reason: string }>
  | Ev<"engine:started", { stepIndex: number }>
  | Ev<"engine:output", { stream: "stdout" | "stderr"; data: string; engineId: string }>
  | EngineNDJSON
  | Ev<"engine:injected", { message: string; origin: "user" | "system"; pending?: boolean }>
  | Ev<"budget:metrics-changed", { tokens: number; cost: number }>
  | Ev<"budget:exhausted", { reason: string }>
  | Ev<"queue:initialized", { stepIds: string[] }>
  | Ev<"queue:completed", { stepsCompleted: number }>
  | Ev<"queue:failed", { reason: string; stepsCompleted: number; finalStatus: "paused" | "failed" }>
  | Ev<"queue:step-started", { stepId: string; stepType: string; stepTitle: string }>
  | Ev<"queue:step-completed", { stepId: string; stepType: string; stepTitle: string }>
  | Ev<"queue:step-failed", { stepId: string; stepType: string; stepTitle: string; reason: string }>
  | Ev<"trace:tool-started", { toolUseId: string; toolName: string; toolInput: string }>
  | Ev<"trace:tool-completed", { toolUseId: string; toolOutput: string; isError: boolean }>
  | Ev<"trace:subagent-started", { toolUseId: string; agentType: string; description: string; prompt: string; model: string }>
  | Ev<"trace:subagent-completed", { toolUseId: string; result: string; isError: boolean }>;

