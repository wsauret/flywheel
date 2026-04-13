// Step Executor — Queue-Based Execution Engine
//
// Thin orchestrator that processes queue steps sequentially. Delegates to:
//   - executor-types.ts  — all DI interfaces and result types
//   - step-runner.ts     — single-step execution pipeline
//   - revision-loop.ts   — evaluator + worker revision cycles

import type { Step } from "./types.js";
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
} from "./queue.js";
import { executeStep } from "./step-runner.js";
import { Log } from "../../infra/log.js";
import { errorMessage } from "../../infra/error-message.js";


const log = Log.create({ service: "step-executor" });

function makeProvenance(reason: string): Provenance {
  return { actor: "executor", reason };
}

export function createStepExecutor(options: StepExecutorOptions): StepExecutor {
  const { queue, workflowId, emit, persist } = options;

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

  async function run(): Promise<StepExecutorResult> {
    let stepsCompleted = queue.steps.filter((s) => s.status === "completed").length;

    emit("queue:initialized", { workflowId, stepIds: queue.steps.map((s) => s.id) });

    if (queue.steps.length === 0 || isFinished(queue)) {
      emit("queue:completed", { workflowId, stepsCompleted });
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
        emit("queue:failed", { workflowId, reason, stepsCompleted });
        return {
          completed: false,
          stepsCompleted,
          stepsTotal: queue.steps.length,
          reason,
        };
      }

      const result = await executeStep(step, {
        ...options,
        abortSignal: abortController.signal,
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
        emit("queue:failed", { workflowId, reason: failedReason, stepsCompleted });
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
    emit("queue:completed", { workflowId, stepsCompleted });
    return { completed: true, stepsCompleted, stepsTotal: queue.steps.length };
  }

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
