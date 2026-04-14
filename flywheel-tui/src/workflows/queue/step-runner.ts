// Step Runner — single-step execution: dispatch → worker → eval → accumulate

import type { Step } from "./types.js";
import type { EvalResult } from "./executor-types.js";
import type { StepRunnerDeps, StepRunnerResult, StepPipelineContext } from "./step-runner-types.js";
import { type Provenance } from "./queue.js";
import { executeWithRevisions } from "./revision-loop.js";
import { raceAbort } from "./abort-utils.js";
import { buildStepMetadataPrompt } from "./shared/step-prompt.js";
import { Log } from "../../infra/log.js";
import { errorMessage } from "../../infra/error-message.js";

const log = Log.create({ service: "step-executor" });

/** Stage 1: Build prompt via dispatcher or step metadata. */
async function dispatchStep(
  step: Step,
  deps: StepRunnerDeps,
  ctx: StepPipelineContext,
): Promise<StepPipelineContext> {
  if (step.skipDispatcher) {
    // Direct prompt from step metadata + accumulated context (no dispatcher LLM call)
    let prompt = buildStepMetadataPrompt(step);
    if (ctx.previousHandoff) {
      const summary = ctx.previousHandoff.summary;
      if (typeof summary === "string") {
        prompt += `\n\n## Previous iteration output\n${summary}`;
      }
    }
    ctx.dispatcherResult = { prompt, evaluationCriteria: null };
    log.info("dispatcher skipped (step.skipDispatcher)", { stepId: step.id });
  } else {
    // Full dispatcher invocation
    ctx.dispatcherResult = await deps.dispatcher(step, {
      previousHandoff: ctx.previousHandoff,
      previousAssessment: ctx.previousAssessment,
    });
  }

  return ctx;
}

/** Stage 3: Apply dispatcher mutation requests if guardrails are active. */
async function applyMutations(
  step: Step,
  deps: StepRunnerDeps,
  ctx: StepPipelineContext,
): Promise<StepPipelineContext> {
  if (!ctx.dispatcherResult?.mutationRequests?.length || !deps.guardrails) return ctx;

  log.info("applying dispatcher mutations", { stepId: step.id, count: ctx.dispatcherResult.mutationRequests.length });
  const provenance: Provenance = {
    actor: "dispatcher",
    reason: `mutations requested after dispatching step ${step.id}`,
  };
  const results = deps.guardrails.applyMutations(
    deps.queue,
    step.id,
    ctx.dispatcherResult.mutationRequests,
    provenance,
  );
  for (const r of results) {
    if (!r.applied) {
      log.warn("dispatcher mutation rejected", { stepId: step.id, reason: r.reason });
    }
  }
  await deps.persistQueue();

  return ctx;
}

/** Stage 4: Spawn worker subprocess. */
async function spawnWorker(
  step: Step,
  deps: StepRunnerDeps,
  ctx: StepPipelineContext,
): Promise<StepPipelineContext> {
  deps.onSubprocessDispatched?.();
  ctx.workerOutput = await raceAbort(
    deps.worker(step, ctx.dispatcherResult!.prompt, deps.abortSignal),
    deps.abortSignal,
  );
  return ctx;
}

/** Stage 5: Read handoff data from worker output. */
async function readHandoff(
  step: Step,
  deps: StepRunnerDeps,
  ctx: StepPipelineContext,
): Promise<StepPipelineContext> {
  try {
    ctx.handoffData = await deps.handoffReader(ctx.workerOutput!.handoffPath);
  } catch (err) {
    log.warn("handoff read failed", {
      stepId: step.id,
      error: errorMessage(err),
    });
  }
  return ctx;
}

/** Stage 6: Run post-turn verification (informational, never blocks). */
async function verifyPostTurn(
  step: Step,
  deps: StepRunnerDeps,
  ctx: StepPipelineContext,
): Promise<StepPipelineContext> {
  if (!deps.postTurnVerification) return ctx;

  const verifyResult = await deps.postTurnVerification({
    step,
    workerOutput: ctx.workerOutput!,
    handoffData: ctx.handoffData,
  });
  if (verifyResult) {
    ctx.postTurnPassed = verifyResult.passed;
  }

  return ctx;
}

/** Stage 7: Evaluate output, run revisions if needed, accumulate context. */
async function evaluateAndAccumulate(
  step: Step,
  deps: StepRunnerDeps,
  ctx: StepPipelineContext,
): Promise<{ ctx: StepPipelineContext; failOutcome: StepRunnerResult | null }> {
  const { queue, evaluator, emit, workflowId, maxRevisions, abortSignal, onStepCompleted,
    accumulator, persistAccumulatorState, safeTransition } = deps;

  const evaluationCriteria = ctx.dispatcherResult!.evaluationCriteria;
  let lastEvalResult: EvalResult | null = null;

  // Post-turn failure overrides skipEvaluation — the evaluator acts as a safety net.
  const shouldEvaluate = evaluator && (!deps.skipEvaluation || !ctx.postTurnPassed);
  if (shouldEvaluate) {
    const stepIndex = queue.steps.findIndex((s) => s.id === step.id);
    const revisionResult = await executeWithRevisions(
      step,
      ctx.dispatcherResult!.prompt,
      ctx.workerOutput!,
      ctx.handoffData,
      evaluationCriteria,
      stepIndex,
      {
        evaluator,
        worker: deps.worker,
        handoffReader: deps.handoffReader,
        emit,
        workflowId,
        maxRevisions,
        abortSignal,
        onSubprocessDispatched: deps.onSubprocessDispatched,
      },
    );

    ctx.workerOutput = revisionResult.workerOutput;
    ctx.handoffData = revisionResult.handoffData;
    lastEvalResult = revisionResult.lastEvalResult;

    if (!revisionResult.passed) {
      await safeTransition(step.id, "failed", revisionResult.failReason!);
      emit("queue:step-failed", { workflowId, stepId: step.id, stepType: step.type, stepTitle: step.title, reason: revisionResult.failReason! });

      if (onStepCompleted) {
        const hookResult = await onStepCompleted(step, "failed", queue, ctx.handoffData);
        if (hookResult.continueExecution) {
          return { ctx, failOutcome: { outcome: "handled", previousHandoff: ctx.previousHandoff, previousAssessment: ctx.previousAssessment } };
        }
      }

      return { ctx, failOutcome: { outcome: "failed", previousHandoff: ctx.previousHandoff, previousAssessment: ctx.previousAssessment } };
    }
  }

  ctx.previousAssessment = lastEvalResult;

  if (ctx.handoffData) {
    ctx.previousHandoff = ctx.handoffData;
    accumulator.accumulate({
      stepId: step.id,
      stepType: step.type,
      stepTitle: step.title,
      handoff: ctx.handoffData,
    });
  } else {
    ctx.previousHandoff = null;
  }

  await safeTransition(step.id, "completed", "step execution completed successfully");
  emit("queue:step-completed", { workflowId, stepId: step.id, stepType: step.type, stepTitle: step.title });

  // Persist accumulator state (ADR-003 Decision 8)
  if (persistAccumulatorState && accumulator.serialize) {
    try {
      persistAccumulatorState(accumulator.serialize());
    } catch (err) {
      log.warn("failed to persist accumulator state", {
        error: errorMessage(err),
      });
    }
  }

  if (onStepCompleted) {
    await onStepCompleted(step, "completed", queue, ctx.handoffData);
  }

  return { ctx, failOutcome: null };
}

// executeStep — run a single step through the full pipeline

export async function executeStep(
  step: Step,
  deps: StepRunnerDeps,
): Promise<StepRunnerResult> {
  const { workflowId, emit, safeTransition, onStepCompleted, queue } = deps;

  let ctx: StepPipelineContext = {
    previousHandoff: deps.previousHandoff,
    previousAssessment: deps.previousAssessment,
    workerOutput: null,
    handoffData: null,
    dispatcherResult: null,
    postTurnPassed: true,
  };

  emit("queue:step-started", { workflowId, stepId: step.id, stepType: step.type, stepTitle: step.title });
  const transitioned = await safeTransition(step.id, "running", "starting step execution");
  if (!transitioned) {
    emit("queue:step-failed", { workflowId, stepId: step.id, stepType: step.type, stepTitle: step.title, reason: "Failed to transition to running" });
    return { outcome: "failed", previousHandoff: ctx.previousHandoff, previousAssessment: ctx.previousAssessment };
  }

  try {
    ctx = await dispatchStep(step, deps, ctx);
    ctx = await applyMutations(step, deps, ctx);
    ctx = await spawnWorker(step, deps, ctx);
    ctx = await readHandoff(step, deps, ctx);
    ctx = await verifyPostTurn(step, deps, ctx);

    const { ctx: finalCtx, failOutcome } = await evaluateAndAccumulate(step, deps, ctx);
    ctx = finalCtx;
    if (failOutcome) return failOutcome;

    return { outcome: "completed", previousHandoff: ctx.previousHandoff, previousAssessment: ctx.previousAssessment };
  } catch (error) {
    // Abort/interrupt: revert the step to pending so it can be retried on resume
    if (error instanceof DOMException && error.name === "AbortError") {
      log.info("step interrupted by abort, reverting to pending", { stepId: step.id });
      await safeTransition(step.id, "pending", "interrupted by abort — will retry on resume");
      return { outcome: "failed", previousHandoff: ctx.previousHandoff, previousAssessment: ctx.previousAssessment };
    }

    // Worker crash or other error: mark step failed, don't throw
    const reason = errorMessage(error);
    log.warn("step execution failed", { stepId: step.id, reason });

    await safeTransition(step.id, "failed", reason);
    emit("queue:step-failed", { workflowId, stepId: step.id, stepType: step.type, stepTitle: step.title, reason });

    if (onStepCompleted) {
      const hookResult = await onStepCompleted(step, "failed", queue, null);
      if (hookResult.continueExecution) {
        return { outcome: "handled", previousHandoff: ctx.previousHandoff, previousAssessment: ctx.previousAssessment };
      }
    }

    return { outcome: "failed", previousHandoff: ctx.previousHandoff, previousAssessment: ctx.previousAssessment };
  }
}
