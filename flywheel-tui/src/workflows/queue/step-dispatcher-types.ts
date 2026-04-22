import type { Step } from "./types.js";
import type { EvaluationCriteria, WorkerConfig } from "../../infra/workflow-types.js";
import type { AccumulatedContext } from "./context-accumulator.js";

// Defined here to break the circular dependency:
// executor-types -> guardrails -> step-dispatcher-types -> executor-types
export interface EvalResult {
  passed: boolean;
  skipped: boolean;
  transportError: boolean;
  reason: string | null;
  feedback: string | null;
  suggestions: string[];
  cyclesUsed: number;
}

export type MutationRequest =
  | { type: "insert_after"; targetStepId: string; steps: Step[]; reason: string }
  | { type: "skip"; targetStepId: string; reason: string }
  | { type: "remove"; targetStepId: string; reason: string };

/** Budget information exposed to the dispatcher. */
export interface MutationBudget {
  /** Configured max queue length. */
  readonly maxQueueLength: number;
  /** Current number of steps in the queue. */
  readonly currentQueueLength: number;
  /** Remaining capacity (maxQueueLength - currentQueueLength). */
  readonly remainingQueueCapacity: number;
  /** Mutations already applied for this step. */
  readonly mutationsUsedThisStep: number;
  /** Mutations remaining for this step. */
  readonly mutationsRemainingThisStep: number;
  /** Total steps inserted during this session (excluding template). */
  readonly totalSessionInserts: number;
  /** Remaining session insert capacity. */
  readonly sessionInsertsRemaining: number;
}

export interface StepDispatchContext {
  accumulatedContext: AccumulatedContext;
  previousHandoff: Record<string, unknown> | null;
  previousAssessment: EvalResult | null;
  mutationBudget?: MutationBudget | null;
}

export interface StepDispatcherDecision {
  taskContent: string;
  evaluationCriteria: EvaluationCriteria | null;
  workerConfig: WorkerConfig | null;
  contextToInline: string[];
  contextFiles: string[];
  mutationRequests: MutationRequest[];
}
