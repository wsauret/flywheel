// ---------------------------------------------------------------------------
// Step Executor — Type Definitions
// ---------------------------------------------------------------------------
//
// All DI interfaces, option types, and result types used by the step
// executor and its sub-modules (gate-handler, revision-loop).
// ---------------------------------------------------------------------------

import type { Step, Queue } from "./types";
import type { OnStepCompletedHook } from "./shared/hooks";
import type { EmitFn } from "../../infra/event-bus";

// ---------------------------------------------------------------------------
// Gate step — QuestionService interface (minimal, for DI)
// ---------------------------------------------------------------------------

/**
 * Minimal QuestionService interface for gate steps.
 */
export interface GateQuestionService {
  ask(questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    custom?: boolean;
  }>): Promise<Array<string[]>>;
}

// ---------------------------------------------------------------------------
// Types — Dependency Injection interfaces
// ---------------------------------------------------------------------------

/** Result from worker execution */
export interface WorkerOutput {
  output: string;
  handoffPath: string;
  durationMs: number;
  sessionId?: string;
}

/** Result from evaluator */
export interface EvalResult {
  passed: boolean;
  skipped: boolean;
  transportError: boolean;
  reason: string | null;
  feedback: string | null;
  suggestions: string[];
  cyclesUsed: number;
}

/** Dispatcher: assembles prompt for a step */
export type DispatcherFn = (
  step: Step,
  context: Record<string, unknown>,
) => Promise<{
  prompt: string;
  evaluationCriteria: unknown | null;
  mutationRequests?: import("./step-dispatcher").MutationRequest[];
}>;

/**
 * Evaluator: assesses step output quality.
 * Receives the step, worker output, evaluation criteria, and handoff data.
 * The handoff data enables trust-but-verify: re-running commands, checking files, etc.
 */
export type EvaluatorFn = (
  step: Step,
  workerOutput: string,
  evaluationCriteria?: unknown | null,
  handoffData?: Record<string, unknown> | null,
) => Promise<EvalResult>;

/** Worker: executes a step with a prompt */
export type WorkerFn = (
  step: Step,
  prompt: string,
  signal?: AbortSignal,
) => Promise<WorkerOutput>;

/** Handoff reader: reads handoff data from path */
export type HandoffReaderFn = (
  path: string,
) => Promise<Record<string, unknown> | null>;

/** Persist function: saves queue state to disk */
export type PersistFn = (queue: Queue) => Promise<void>;

/** Step context accumulator: accumulates handoff data across steps */
export interface StepContextAccumulator {
  accumulate(data: unknown): void;
  getContext(): Record<string, unknown>;
  /** Optional: serialize state for persistence. */
  serialize?(): unknown;
}

// ---------------------------------------------------------------------------
// StepExecutorOptions — all dependencies injected (core + hooks)
// ---------------------------------------------------------------------------

/** Required core options for step execution. */
export interface StepExecutorCoreOptions {
  /** The queue to execute */
  queue: Queue;
  /** Unique workflow identifier */
  workflowId: string;
  /** Session ID for file path construction */
  sessionId: string;
  /** Event emitter for lifecycle events */
  emit: EmitFn;
  /** Dispatcher for prompt assembly */
  dispatcher: DispatcherFn;
  /** Worker for step execution */
  worker: WorkerFn;
  /** Evaluator for quality checks (null = no evaluation) */
  evaluator: EvaluatorFn | null;
  /** Handoff reader for reading worker output */
  handoffReader: HandoffReaderFn;
  /** Queue persistence function */
  persist: PersistFn;
  /** Step context accumulator */
  accumulator: StepContextAccumulator;
  /** Maximum revision attempts per step (0 = no revisions) */
  maxRevisions: number;
  /**
   * Evaluation preference. When true, the evaluator is skipped for steps where
   * post-turn verification passes. When post-turn verification FAILS, the
   * evaluator runs regardless of this setting — it acts as a safety net.
   *
   * Set from `config.skip_evaluation`. The evaluator fn itself should still
   * be provided (non-null) when a transport is available — this flag controls
   * when it's invoked, not whether it exists.
   */
  skipEvaluation: boolean;
}

/** Optional hooks and extensions for step execution. */
export interface StepExecutorHooks {
  /**
   * QuestionService for gate steps. When a step of type `gate` is encountered,
   * the executor uses this service to present continue/stop/pause options
   * instead of invoking dispatcher→worker.
   *
   * When null/undefined, gate steps are auto-resolved as "Continue".
   */
  questionService?: GateQuestionService | null;

  /**
   * Hook called after a step completes or fails. Allows external logic
   * (e.g., sprint handler) to inspect results and mutate the queue
   * (insert retry pairs, escalation steps, etc.).
   *
   * Return `{ continueExecution: true }` from a failed step to override
   * the default "stop on failure" behavior — the executor will advance
   * the cursor and continue processing instead of stopping.
   *
   * Called with the step, its final status, and the queue for mutation.
   */
  onStepCompleted?: OnStepCompletedHook | null;

  /**
   * Guardrails instance for mutation budget tracking and enforcement.
   * When provided, the executor passes mutation_budget to the dispatcher
   * context.
   */
  guardrails?: import("./guardrails").Guardrails | null;

  /**
   * Session objective — the original feature description.
   * Always passed to the dispatcher context per ADR-003 Decision 4.
   * Also used by guardrails for objective anchoring if guardrails are active.
   */
  sessionObjective?: string;

  /**
   * Persist accumulated context state alongside queue state.
   * Called after each step completion per ADR-003 Decision 8.
   * When null, accumulator state is not persisted (test-only).
   */
  persistAccumulatorState?: ((state: unknown) => void) | null;

  /**
   * Called each time a subprocess is dispatched (before the subprocess runs).
   * Wire to BudgetTracker.incrementInvocations() to track invocation counts.
   */
  onSubprocessDispatched?: (() => void) | null;

  /**
   * Post-turn verification hook. Runs after worker output + handoff read,
   * before the evaluator. Returns verification result or null to skip.
   *
   * The hook implementation is composed by the orchestrator with access to
   * InjectionQueue and projectCwd — the step-runner doesn't know about
   * native checks, stdin injection, or self-review mechanics.
   */
  postTurnVerification?: PostTurnVerificationHook | null;
}

/** Full options = core + hooks. */
export type StepExecutorOptions = StepExecutorCoreOptions & StepExecutorHooks;

// ---------------------------------------------------------------------------
// PostTurnVerificationHook — named type alias for the hook function
// ---------------------------------------------------------------------------

export type PostTurnVerificationHook = (ctx: {
  step: Step;
  workerOutput: WorkerOutput;
  handoffData: Record<string, unknown> | null;
}) => Promise<PostTurnVerificationResult | null>;

// ---------------------------------------------------------------------------
// PostTurnVerificationResult — returned by the post-turn verification hook
// ---------------------------------------------------------------------------

/** Minimal check result — avoids importing NativeCheckResult from orchestration layer. */
export interface VerificationCheckResult {
  command: string;
  passed: boolean;
  exitCode: number;
  stderr: string;
  durationMs: number;
  skipped?: boolean;
  discrepancy?: boolean;
}

export interface PostTurnVerificationResult {
  passed: boolean;
  nativeChecksPassed: boolean;
  fixAttemptsUsed: number;
  checks: VerificationCheckResult[];
}

// ---------------------------------------------------------------------------
// StepExecutorResult — what run() returns
// ---------------------------------------------------------------------------

export interface StepExecutorResult {
  /** Whether all steps completed successfully */
  completed: boolean;
  /** Number of steps that completed */
  stepsCompleted: number;
  /** Total number of steps in the queue */
  stepsTotal: number;
  /** Reason for stopping if not all steps completed */
  reason?: string;
}

// ---------------------------------------------------------------------------
// StepExecutor interface — returned by factory
// ---------------------------------------------------------------------------

export interface StepExecutor {
  /** Run the queue to completion (or until stopped) */
  run(): Promise<StepExecutorResult>;
  /** Request graceful shutdown — finish current step, then stop */
  requestShutdown(): void;
  /** Cancel a pending shutdown request so execution continues after current step. */
  cancelShutdown(): void;
  /**
   * Abort execution immediately — terminate the current worker process,
   * mark the running step as failed, and return cleanly.
   *
   * Unlike `requestShutdown()` which waits for the current step to finish,
   * `abort()` interrupts mid-step execution.
   */
  abort(): void;
}
