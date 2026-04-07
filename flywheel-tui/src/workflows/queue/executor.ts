// ---------------------------------------------------------------------------
// Step Executor — Queue-Based Execution Engine
// ---------------------------------------------------------------------------
//
// Thin orchestrator that processes queue steps sequentially. Delegates to:
//   - executor-types.ts  — all DI interfaces and result types
//   - gate-handler.ts    — gate step user prompts
//   - step-runner.ts     — single-step execution pipeline
//   - revision-loop.ts   — evaluator + worker revision cycles
// ---------------------------------------------------------------------------

import type { Step } from "./types";
import type {
  StepExecutorOptions,
  StepExecutorResult,
  StepExecutor,
  EvalResult,
} from "./executor-types.js";
import {
  transitionStep,
  advanceCursor,
  isFinished,
  type Provenance,
} from "./queue";
import { handleGateStep } from "./gate-handler.js";
import { executeStep } from "./step-runner.js";
import { Log } from "../../infra/log";
import { errorMessage } from "../../infra/error-message";

// Re-export public types so external consumers don't need to change imports
export type {
  StepExecutor,
  StepExecutorResult,
  StepExecutorOptions,
  GateQuestionService,
  WorkerOutput,
  EvalResult,
  DispatcherFn,
  EvaluatorFn,
  WorkerFn,
  HandoffReaderFn,
  BudgetChecker,
  PersistFn,
  StepContextAccumulator,
} from "./executor-types.js";

const log = Log.create({ service: "step-executor" });

// ---------------------------------------------------------------------------
// Provenance helper
// ---------------------------------------------------------------------------

function makeProvenance(reason: string): Provenance {
  return { actor: "executor", reason };
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
    sessionObjective,
    persistAccumulatorState,
    onSubprocessDispatched,
  } = options;

  let shutdownRequested = false;
  const abortController = new AbortController();
  let previousHandoff: Record<string, unknown> | null = null;
  let previousAssessment: EvalResult | null = null;

  async function persistQueue(): Promise<void> {
    try {
      await persist(queue);
    } catch (err) {
      log.warn("failed to persist queue state", {
        error: errorMessage(err),
      });
    }
  }

  async function safeTransition(
    stepId: string,
    newStatus: "running" | "completed" | "failed" | "skipped" | "pending",
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

  // -----------------------------------------------------------------------
  // run() — main execution loop
  // -----------------------------------------------------------------------

  async function run(): Promise<StepExecutorResult> {
    let stepsCompleted = queue.steps.filter((s) => s.status === "completed").length;

    emitter.queueInitialized(workflowId, queue.steps.map((s) => s.id));

    if (queue.steps.length === 0 || isFinished(queue)) {
      emitter.queueCompleted(workflowId, stepsCompleted);
      return { completed: true, stepsCompleted, stepsTotal: queue.steps.length };
    }

    queue.status = "running";
    advanceCursor(queue);

    while (queue.cursor < queue.steps.length) {
      const step = queue.steps[queue.cursor] as Step;

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

      // Check budget before starting step
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

      // Gate steps: present user with continue/stop/pause
      if (step.type === "gate") {
        emitter.queueStepStarted(workflowId, step.id, step.type, step.title);
        await safeTransition(step.id, "running", "gate step awaiting user decision");

        const decision = await handleGateStep(step, questionService);

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

      // Execute the step (non-gate) — delegated to step-runner
      const result = await executeStep(step, {
        queue,
        workflowId,
        emitter,
        dispatcher,
        worker,
        evaluator,
        handoffReader,
        accumulator,
        maxRevisions,
        abortSignal: abortController.signal,
        questionService,
        onStepCompleted,
        guardrails,
        sessionObjective,
        persistAccumulatorState,
        onSubprocessDispatched,
        previousHandoff,
        previousAssessment,
        safeTransition,
        persistQueue,
      });

      // Sync mutable state back from step runner
      previousHandoff = result.previousHandoff;
      previousAssessment = result.previousAssessment;

      if (result.outcome === "completed") {
        stepsCompleted++;
        advanceCursor(queue);
      } else if (result.outcome === "handled") {
        advanceCursor(queue);
      } else {
        const wasAborted = abortController.signal.aborted;
        queue.status = wasAborted ? "paused" : "failed";
        await persistQueue();
        const failedReason = wasAborted
          ? "Interrupted — will resume from this step"
          : `Step "${step.title}" failed`;
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

  // -----------------------------------------------------------------------
  // Shutdown / Abort
  // -----------------------------------------------------------------------

  function requestShutdown(): void {
    shutdownRequested = true;
    log.info("shutdown requested", { workflowId });
  }

  function cancelShutdown(): void {
    shutdownRequested = false;
    log.info("shutdown cancelled", { workflowId });
  }

  function abort(): void {
    shutdownRequested = true;
    abortController.abort();
    log.info("abort requested — terminating current worker", { workflowId });
  }

  return { run, requestShutdown, cancelShutdown, abort };
}
