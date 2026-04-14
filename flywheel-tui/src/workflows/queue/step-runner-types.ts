import type {
  EvalResult,
  WorkerOutput,
  StepExecutorOptions,
} from "./executor-types.js";
import type { MutationRequest } from "./step-dispatcher.js";
import type { EvaluationCriteria } from "../../infra/workflow-types.js";

export interface StepRunnerDeps extends Omit<StepExecutorOptions, "persist" | "sessionId"> {
  abortSignal: AbortSignal;
  previousHandoff: Record<string, unknown> | null;
  previousAssessment: EvalResult | null;
  safeTransition: (
    stepId: string,
    newStatus: "running" | "completed" | "failed" | "skipped" | "pending",
    reason: string,
  ) => Promise<boolean>;
  persistQueue: () => Promise<void>;
}

export interface StepRunnerResult {
  outcome: "completed" | "failed" | "handled";
  /** Updated previousHandoff (may change during execution) */
  previousHandoff: Record<string, unknown> | null;
  /** Updated previousAssessment (may change during execution) */
  previousAssessment: EvalResult | null;
}

export interface StepPipelineContext {
  previousHandoff: Record<string, unknown> | null;
  previousAssessment: EvalResult | null;
  workerOutput: WorkerOutput | null;
  handoffData: Record<string, unknown> | null;
  dispatcherResult: {
    prompt: string;
    evaluationCriteria: EvaluationCriteria | null;
    mutationRequests?: MutationRequest[];
  } | null;
  postTurnPassed: boolean;
}
