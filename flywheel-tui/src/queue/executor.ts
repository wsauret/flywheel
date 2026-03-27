// ---------------------------------------------------------------------------
// Step Executor — Queue-Based Execution Engine
// ---------------------------------------------------------------------------
//
// Processes queue steps sequentially. Uses DI for all dependencies
// (dispatcher, worker, evaluator,
// persistence, budget, accumulator) to enable testability.
//
// For each pending step:
//   (1) check budget via budgetChecker.isExhausted()
//   (2) transition step to running
//   (3) invoke dispatcher for prompt assembly
//   (4) spawn worker via worker function
//   (5) read handoff
//   (6) invoke evaluator for quality check (if configured)
//   (7) handle revision loop (up to max_revisions)
//   (8) accumulate context via accumulator
//   (9) transition step to completed/failed
//   (10) emit step events
//   (11) persist queue
//   (12) advance cursor
//
// Handles:
//   - Worker crash (step→failed, no throw)
//   - Evaluator transport failure (skip eval, continue)
//   - Budget exhaustion (stop before next step)
//   - Abort signal (finish current step, stop)
//
// Terminology:
//   Step   — single unit of work
//   Queue  — mutable, ordered list of steps
// ---------------------------------------------------------------------------

import type { Step, Queue } from "./types";
import type { FlywheelEmitter } from "../events/event-bus";
import {
  transitionStep,
  advanceCursor,
  isFinished,
  type Provenance,
} from "./queue";
import { Log } from "../utils/log";

// ---------------------------------------------------------------------------
// Gate step — QuestionService interface (minimal, for DI)
// ---------------------------------------------------------------------------

/**
 * Minimal QuestionService interface for gate steps.
 * Mirrors the `ask` method from `src/controller/question-service.ts`.
 * The full QuestionService type is not imported to avoid coupling the
 * queue engine to the controller layer.
 */
export interface GateQuestionService {
  ask(questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    custom?: boolean;
  }>): Promise<Array<string[]>>;
}

const log = Log.create({ service: "step-executor" });

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
  /** Structured verification results from trust-but-verify evaluator (when available) */
  verificationResults?: import("../evaluator/trust-verify").VerificationResults;
}

/** Dispatcher: assembles prompt for a step */
export type DispatcherFn = (
  step: Step,
  context: Record<string, unknown>,
) => Promise<{ prompt: string; evaluationCriteria: unknown | null }>;

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
) => Promise<WorkerOutput>;

/** Handoff reader: reads handoff data from path */
export type HandoffReaderFn = (
  path: string,
) => Promise<Record<string, unknown> | null>;

/** Budget checker: checks if budget is exhausted */
export interface BudgetChecker {
  isExhausted(): boolean;
}

/** Persist function: saves queue state to disk */
export type PersistFn = (queue: Queue) => Promise<void>;

/** Step context accumulator: accumulates handoff data across steps */
export interface StepContextAccumulator {
  accumulate(data: unknown): void;
  getContext(): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// StepExecutorOptions — all dependencies injected
// ---------------------------------------------------------------------------

export interface StepExecutorOptions {
  /** The queue to execute */
  queue: Queue;
  /** Unique workflow identifier */
  workflowId: string;
  /** Event emitter for lifecycle events */
  emitter: FlywheelEmitter;
  /** Dispatcher for prompt assembly */
  dispatcher: DispatcherFn;
  /** Worker for step execution */
  worker: WorkerFn;
  /** Evaluator for quality checks (null = no evaluation) */
  evaluator: EvaluatorFn | null;
  /** Handoff reader for reading worker output */
  handoffReader: HandoffReaderFn;
  /** Budget checker */
  budgetChecker: BudgetChecker;
  /** Queue persistence function */
  persist: PersistFn;
  /** Step context accumulator */
  accumulator: StepContextAccumulator;
  /** Maximum revision attempts per step (0 = no revisions) */
  maxRevisions: number;
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
   * context and session objective from the guardrails.
   */
  guardrails?: import("./guardrails").Guardrails | null;
}

// ---------------------------------------------------------------------------
// OnStepCompleted hook type
// ---------------------------------------------------------------------------

export interface OnStepCompletedResult {
  /** When true for a failed step, the executor continues instead of stopping. */
  continueExecution: boolean;
}

/**
 * Hook called after a step transitions to completed or failed.
 * Receives the step, its final status, the queue (for mutation),
 * and the handoff data (if available).
 */
export type OnStepCompletedHook = (
  step: Step,
  status: "completed" | "failed",
  queue: Queue,
  handoffData: Record<string, unknown> | null,
) => Promise<OnStepCompletedResult>;

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
  /**
   * Abort execution immediately — terminate the current worker process,
   * mark the running step as failed, and return cleanly.
   *
   * Unlike `requestShutdown()` which waits for the current step to finish,
   * `abort()` interrupts mid-step execution.
   */
  abort(): void;
}

// ---------------------------------------------------------------------------
// Provenance helper
// ---------------------------------------------------------------------------

const EXECUTOR_PROVENANCE: Provenance = {
  actor: "executor",
  reason: "step lifecycle transition",
};

function makeProvenance(reason: string): Provenance {
  return { actor: "executor", reason };
}

// ---------------------------------------------------------------------------
// Abort helper — races a promise against an AbortSignal
// ---------------------------------------------------------------------------

/**
 * Races a promise against an AbortSignal. If the signal is already aborted
 * or fires before the promise settles, rejects with an AbortError.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Revision prompt builder
// ---------------------------------------------------------------------------

function buildRevisionPrompt(
  originalPrompt: string,
  evalResult: EvalResult,
): string {
  const sections: string[] = [originalPrompt, "", "## Revision Required", ""];

  if (evalResult.reason) {
    sections.push("### Evaluator Reasoning");
    sections.push(evalResult.reason);
    sections.push("");
  }

  if (evalResult.feedback) {
    sections.push("### Feedback");
    sections.push(evalResult.feedback);
    sections.push("");
  }

  if (evalResult.suggestions.length > 0) {
    sections.push("### Suggestions");
    for (const suggestion of evalResult.suggestions) {
      sections.push(`- ${suggestion}`);
    }
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

// ---------------------------------------------------------------------------
// createStepExecutor — factory function
// ---------------------------------------------------------------------------

export function createStepExecutor(options: StepExecutorOptions): StepExecutor {
  const {
    queue,
    workflowId,
    emitter,
    dispatcher,
    worker,
    evaluator,
    handoffReader,
    budgetChecker,
    persist,
    accumulator,
    maxRevisions,
    questionService,
    onStepCompleted,
    guardrails,
  } = options;

  let shutdownRequested = false;
  /** AbortController for mid-step abort. When abort() is called, the
   *  current step's promise is rejected via this controller's signal. */
  let abortController = new AbortController();
  /** Last handoff data from the most recently completed step (for chaining) */
  let previousHandoff: Record<string, unknown> | null = null;
  /** Last evaluator assessment from the most recently completed step */
  let previousAssessment: EvalResult | null = null;

  /**
   * Persist queue state (best-effort — log on failure, don't throw).
   */
  async function persistQueue(): Promise<void> {
    try {
      await persist(queue);
    } catch (err) {
      log.warn("failed to persist queue state", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Transition a step and persist. Returns false if transition failed.
   */
  async function safeTransition(
    stepId: string,
    newStatus: "running" | "completed" | "failed" | "skipped",
    reason: string,
  ): Promise<boolean> {
    const result = transitionStep(queue, stepId, newStatus, makeProvenance(reason));
    if (!result.success) {
      log.warn("step transition failed", {
        stepId,
        newStatus,
        error: "error" in result ? result.error : "unknown",
      });
      return false;
    }
    await persistQueue();
    return true;
  }

  // -------------------------------------------------------------------------
  // Gate step constants
  // -------------------------------------------------------------------------

  const GATE_CONTINUE = "Continue";
  const GATE_STOP = "Stop";
  const GATE_PAUSE = "Pause";

  /**
   * Handle a gate step: pause execution and present a question to the user
   * via QuestionService (continue/stop/pause).
   *
   * Returns:
   *   "continue" — mark step completed, advance cursor
   *   "stop"     — mark step failed, stop queue
   *   "pause"    — mark step completed, request shutdown
   *
   * When no QuestionService is provided, auto-resolves as "continue".
   */
  async function handleGateStep(step: Step): Promise<"continue" | "stop" | "pause"> {
    if (!questionService) {
      log.info("gate step auto-resolved (no question service)", { stepId: step.id });
      return "continue";
    }

    try {
      const answers = await questionService.ask([{
        question: step.title || "Approval gate",
        header: "Gate",
        options: [
          { label: GATE_CONTINUE, description: "Continue to next step" },
          { label: GATE_STOP, description: "Stop execution" },
          { label: GATE_PAUSE, description: "Pause execution (can resume later)" },
        ],
      }]);

      // answers is an array of QuestionAnswer[] — each element is string[]
      const answer = answers?.[0]?.[0] ?? GATE_CONTINUE;

      if (answer === GATE_STOP) return "stop";
      if (answer === GATE_PAUSE) return "pause";
      return "continue";
    } catch (err) {
      // QuestionRejectedError (user dismissed) → treat as stop
      log.info("gate step dismissed by user", { stepId: step.id });
      return "stop";
    }
  }

  /**
   * Execute a single step: dispatcher → worker → handoff → evaluator → accumulate.
   * Returns:
   *   "completed" — step executed successfully
   *   "failed"    — step failed and execution should stop
   *   "handled"   — step failed but onStepCompleted hook handled it; continue
   */
  async function executeStep(step: Step): Promise<"completed" | "failed" | "handled"> {
    // (2) Transition step to running
    emitter.queueStepStarted(workflowId, step.id, step.type, step.title);
    const transitioned = await safeTransition(step.id, "running", "starting step execution");
    if (!transitioned) {
      emitter.queueStepFailed(workflowId, step.id, step.type, step.title, "Failed to transition to running");
      return "failed";
    }

    try {
      // (2b) Handle HITL — present prompt to user before worker invocation
      // When hitl.enabled is true and a questionService is available,
      // pause execution to present the HITL prompt and wait for input.
      // When hitl.enabled is false (or no questionService), proceed autonomously.
      let hitlResponse: string | null = null;
      if (step.hitl) {
        if (step.hitl.enabled && questionService) {
          try {
            const answers = await questionService.ask([{
              question: step.hitl.prompt,
              header: step.title,
              options: [
                { label: "Continue", description: "Proceed with this step" },
              ],
              custom: true,
            }]);
            hitlResponse = answers?.[0]?.[0] ?? null;
            log.info("HITL response received", { stepId: step.id, hasResponse: hitlResponse !== null });
          } catch (err) {
            log.info("HITL dismissed by user, proceeding autonomously", { stepId: step.id });
            // User dismissed — proceed autonomously (don't fail the step)
          }
        } else {
          const reason = step.hitl.enabled ? "no question service available" : "hitl disabled on step";
          log.info("HITL skipped, proceeding autonomously", { stepId: step.id, reason });
        }
      }

      // (3) Invoke dispatcher for prompt assembly
      const dispatcherContext: Record<string, unknown> = {
        ...accumulator.getContext(),
        ...(previousHandoff ? { previousHandoff } : {}),
        ...(previousAssessment ? { previousAssessment } : {}),
        ...(hitlResponse !== null ? { hitlResponse } : {}),
        ...(guardrails ? {
          mutation_budget: guardrails.getMutationBudget(step.id, queue.steps.length),
          session_objective: guardrails.getSessionObjective(),
        } : {}),
      };
      const dispatcherResult = await dispatcher(step, dispatcherContext);
      let currentPrompt = dispatcherResult.prompt;

      // (4) Spawn worker — race against abort signal
      let workerOutput = await raceAbort(worker(step, currentPrompt), abortController.signal);

      // (5) Read handoff (best-effort)
      let handoffData: Record<string, unknown> | null = null;
      try {
        handoffData = await handoffReader(workerOutput.handoffPath);
      } catch (err) {
        log.warn("handoff read failed", {
          stepId: step.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Capture evaluationCriteria from dispatcher for evaluator
      const evaluationCriteria = dispatcherResult.evaluationCriteria;

      // Track last evaluator result for the next step's dispatcher context
      let lastEvalResult: EvalResult | null = null;

      // (6) Invoke evaluator for quality check (if configured)
      if (evaluator) {
        let evalResult = await evaluator(step, workerOutput.output, evaluationCriteria, handoffData);
        lastEvalResult = evalResult;

        // Handle transport error: skip evaluation, continue
        if (evalResult.transportError) {
          log.warn("evaluator transport failed, continuing with graceful degradation", {
            stepId: step.id,
            reason: evalResult.reason,
          });
          // Skip evaluation entirely — treat as pass
        } else {
          // (7) Handle revision loop (up to max_revisions)
          let revisionAttempt = 0;
          while (!evalResult.passed && !evalResult.skipped && revisionAttempt < maxRevisions) {
            revisionAttempt++;

            log.info("starting revision attempt", {
              stepId: step.id,
              revisionAttempt,
              maxRevisions,
              reason: evalResult.reason,
            });

            // Build revision prompt with evaluator feedback
            currentPrompt = buildRevisionPrompt(currentPrompt, evalResult);

            // Re-execute worker with revision prompt — race against abort signal
            workerOutput = await raceAbort(worker(step, currentPrompt), abortController.signal);

            // Read revised handoff
            try {
              handoffData = await handoffReader(workerOutput.handoffPath);
            } catch {
              handoffData = null;
            }

            // Re-evaluate (pass evaluationCriteria and handoff through revision loop)
            evalResult = await evaluator(step, workerOutput.output, evaluationCriteria, handoffData);
            lastEvalResult = evalResult;

            // Transport error during revision: break out and continue
            if (evalResult.transportError) {
              log.warn("evaluator transport failed during revision, skipping further evaluation", {
                stepId: step.id,
                revisionAttempt,
              });
              break;
            }
          }

          // After revision loop: check if evaluation passed
          if (!evalResult.passed && !evalResult.skipped && !evalResult.transportError) {
            const failReason = maxRevisions > 0
              ? `Evaluation failed after ${revisionAttempt} revision(s): ${evalResult.reason}`
              : `Evaluation failed: ${evalResult.reason}`;

            await safeTransition(step.id, "failed", failReason);
            emitter.queueStepFailed(workflowId, step.id, step.type, step.title, failReason);

            // Call onStepCompleted hook for evaluation failure
            if (onStepCompleted) {
              const hookResult = await onStepCompleted(step, "failed", queue, handoffData);
              if (hookResult.continueExecution) {
                return "handled";
              }
            }

            return "failed";
          }
        }
      }

      // (8) Accumulate context and chain handoff
      // Store the final evaluator assessment for the next step's dispatcher
      previousAssessment = lastEvalResult;

      if (handoffData) {
        previousHandoff = handoffData;
        accumulator.accumulate({
          stepId: step.id,
          stepType: step.type,
          stepTitle: step.title,
          handoff: handoffData,
        });
      } else {
        previousHandoff = null;
      }

      // (9) Transition step to completed
      await safeTransition(step.id, "completed", "step execution completed successfully");
      emitter.queueStepCompleted(workflowId, step.id, step.type, step.title);

      // Call onStepCompleted hook
      if (onStepCompleted) {
        await onStepCompleted(step, "completed", queue, handoffData);
      }

      return "completed";
    } catch (error) {
      // Worker crash or other error: mark step failed, don't throw
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("step execution failed", { stepId: step.id, reason });

      await safeTransition(step.id, "failed", reason);
      emitter.queueStepFailed(workflowId, step.id, step.type, step.title, reason);

      // Call onStepCompleted hook (with failed status)
      if (onStepCompleted) {
        const hookResult = await onStepCompleted(step, "failed", queue, null);
        if (hookResult.continueExecution) {
          return "handled";
        }
      }

      return "failed";
    }
  }

  // ---------------------------------------------------------------------------
  // run() — main execution loop
  // ---------------------------------------------------------------------------

  async function run(): Promise<StepExecutorResult> {
    let stepsCompleted = queue.steps.filter((s) => s.status === "completed").length;

    // Emit queue:initialized
    emitter.queueInitialized(workflowId, queue.steps.map((s) => s.id));

    // Handle empty queue
    if (queue.steps.length === 0 || isFinished(queue)) {
      emitter.queueCompleted(workflowId, stepsCompleted);
      return { completed: true, stepsCompleted, stepsTotal: queue.steps.length };
    }

    // Set queue status to running
    queue.status = "running";

    // Advance cursor to first pending step (skip completed/failed/skipped)
    advanceCursor(queue);

    // Main loop: process steps sequentially
    while (queue.cursor < queue.steps.length) {
      const step = queue.steps[queue.cursor];

      // Skip non-pending steps
      if (step.status !== "pending") {
        queue.cursor++;
        continue;
      }

      // Check shutdown request before starting next step
      if (shutdownRequested) {
        const reason = "Shutdown requested";
        queue.status = "paused";
        await persistQueue();
        emitter.queueFailed(workflowId, reason, stepsCompleted);
        return {
          completed: false,
          stepsCompleted,
          stepsTotal: queue.steps.length,
          reason,
        };
      }

      // (1) Check budget before starting step
      if (budgetChecker.isExhausted()) {
        const reason = "budget_exhausted";
        queue.status = "paused";
        await persistQueue();
        emitter.queueFailed(workflowId, reason, stepsCompleted);
        return {
          completed: false,
          stepsCompleted,
          stepsTotal: queue.steps.length,
          reason,
        };
      }

      // Gate steps: pause execution and present user with continue/stop/pause
      if (step.type === "gate") {
        // Transition to running (so UI shows it as active)
        emitter.queueStepStarted(workflowId, step.id, step.type, step.title);
        await safeTransition(step.id, "running", "gate step awaiting user decision");

        const decision = await handleGateStep(step);

        if (decision === "continue") {
          await safeTransition(step.id, "completed", "user approved gate");
          emitter.queueStepCompleted(workflowId, step.id, step.type, step.title);
          stepsCompleted++;
          advanceCursor(queue);
          continue;
        }

        if (decision === "pause") {
          await safeTransition(step.id, "completed", "user paused at gate");
          emitter.queueStepCompleted(workflowId, step.id, step.type, step.title);
          stepsCompleted++;
          advanceCursor(queue);
          // Request shutdown so the executor stops after this step
          shutdownRequested = true;
          continue;
        }

        // decision === "stop"
        await safeTransition(step.id, "failed", "user stopped at gate");
        emitter.queueStepFailed(workflowId, step.id, step.type, step.title, "User stopped at gate");
        queue.status = "failed";
        await persistQueue();
        emitter.queueFailed(workflowId, "User stopped at gate", stepsCompleted);
        return {
          completed: false,
          stepsCompleted,
          stepsTotal: queue.steps.length,
          reason: "User stopped at gate",
        };
      }

      // Execute the step (non-gate)
      const stepResult = await executeStep(step);

      if (stepResult === "completed") {
        stepsCompleted++;
        // (12) Advance cursor
        advanceCursor(queue);
      } else if (stepResult === "handled") {
        // Step failed but was handled by onStepCompleted hook
        // (e.g., sprint retry insertion). Advance cursor to next pending step.
        advanceCursor(queue);
      } else {
        // Step failed — stop execution
        queue.status = "failed";
        await persistQueue();
        const failedReason = `Step "${step.title}" failed`;
        emitter.queueFailed(workflowId, failedReason, stepsCompleted);
        return {
          completed: false,
          stepsCompleted,
          stepsTotal: queue.steps.length,
          reason: failedReason,
        };
      }
    }

    // All steps completed
    queue.status = "completed";
    await persistQueue();
    emitter.queueCompleted(workflowId, stepsCompleted);
    return { completed: true, stepsCompleted, stepsTotal: queue.steps.length };
  }

  // ---------------------------------------------------------------------------
  // requestShutdown()
  // ---------------------------------------------------------------------------

  function requestShutdown(): void {
    shutdownRequested = true;
    log.info("shutdown requested", { workflowId });
  }

  // ---------------------------------------------------------------------------
  // abort() — immediate interruption of current step
  // ---------------------------------------------------------------------------

  function abort(): void {
    shutdownRequested = true;
    abortController.abort();
    log.info("abort requested — terminating current worker", { workflowId });
  }

  return { run, requestShutdown, abort };
}
