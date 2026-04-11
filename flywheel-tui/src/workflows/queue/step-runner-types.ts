import type { Queue } from "./types";
import type { EmitFn } from "../../infra/event-bus";
import type {
  EvalResult,
  DispatcherFn,
  EvaluatorFn,
  WorkerFn,
  WorkerOutput,
  HandoffReaderFn,
  GateQuestionService,
  StepContextAccumulator,
  PostTurnVerificationHook,
} from "./executor-types.js";
import type { OnStepCompletedHook } from "./shared/hooks";
import type { Guardrails } from "./guardrails";
import type { MutationRequest } from "./step-dispatcher";

export interface StepRunnerDeps {
  queue: Queue;
  workflowId: string;
  emit: EmitFn;
  dispatcher: DispatcherFn;
  worker: WorkerFn;
  evaluator: EvaluatorFn | null;
  /** When true, evaluator is skipped if post-turn verification passes.
   *  When post-turn fails, evaluator runs regardless of this flag. */
  skipEvaluation: boolean;
  handoffReader: HandoffReaderFn;
  accumulator: StepContextAccumulator;
  maxRevisions: number;
  abortSignal: AbortSignal;

  // Optional hooks / services
  questionService?: GateQuestionService | null;
  onStepCompleted?: OnStepCompletedHook | null;
  guardrails?: Guardrails | null;
  sessionObjective?: string;
  persistAccumulatorState?: ((state: unknown) => void) | null;
  onSubprocessDispatched?: (() => void) | null;
  postTurnVerification?: PostTurnVerificationHook | null;

  // Mutable state shared with the executor loop
  previousHandoff: Record<string, unknown> | null;
  previousAssessment: EvalResult | null;

  // Callbacks for persistence and transitions
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
  hitlResponse: string | null;
  dispatcherResult: {
    prompt: string;
    evaluationCriteria: unknown | null;
    mutationRequests?: MutationRequest[];
  } | null;
  postTurnPassed: boolean;
}
