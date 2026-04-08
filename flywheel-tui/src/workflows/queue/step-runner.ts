// ---------------------------------------------------------------------------
// Step Runner — single-step execution: dispatch → worker → eval → accumulate
// ---------------------------------------------------------------------------

import type { Step, Queue } from "./types";
import type { FlywheelEmitter } from "../../infra/event-bus";
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
import { type Provenance } from "./queue";
import { executeWithRevisions } from "./revision-loop.js";
import { raceAbort } from "./abort-utils.js";
import { Log } from "../../infra/log";
import { errorMessage } from "../../infra/error-message";

const log = Log.create({ service: "step-executor" });

// ---------------------------------------------------------------------------
// Dependencies injected by the executor
// ---------------------------------------------------------------------------

export interface StepRunnerDeps {
  queue: Queue;
  workflowId: string;
  emitter: FlywheelEmitter;
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

// ---------------------------------------------------------------------------
// executeStep — run a single step through the full pipeline
// ---------------------------------------------------------------------------

export async function executeStep(
  step: Step,
  deps: StepRunnerDeps,
): Promise<StepRunnerResult> {
  const {
    queue,
    workflowId,
    emitter,
    dispatcher,
    worker,
    evaluator,
    handoffReader,
    accumulator,
    maxRevisions,
    abortSignal,
    questionService,
    onStepCompleted,
    guardrails,
    sessionObjective,
    persistAccumulatorState,
    onSubprocessDispatched,
    safeTransition,
    persistQueue,
  } = deps;

  let { previousHandoff, previousAssessment } = deps;

  emitter.queueStepStarted(workflowId, step.id, step.type, step.title);
  const transitioned = await safeTransition(step.id, "running", "starting step execution");
  if (!transitioned) {
    emitter.queueStepFailed(workflowId, step.id, step.type, step.title, "Failed to transition to running");
    return { outcome: "failed", previousHandoff, previousAssessment };
  }

  try {
    // Handle HITL prompt (if configured)
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
        } catch {
          log.info("HITL dismissed by user, proceeding autonomously", { stepId: step.id });
        }
      } else {
        const reason = step.hitl.enabled ? "no question service available" : "hitl disabled on step";
        log.info("HITL skipped, proceeding autonomously", { stepId: step.id, reason });
      }
    }

    // Build prompt — either via dispatcher or directly from step metadata.
    // Sprint retry steps set skipDispatcher to keep the loop tight (worker → evaluator).
    let dispatcherResult: { prompt: string; evaluationCriteria: unknown | null; mutationRequests?: import("./step-dispatcher").MutationRequest[] };

    if (step.skipDispatcher) {
      // Direct prompt from step metadata + accumulated context (no dispatcher LLM call)
      const parts = [step.title];
      if (step.description) parts.push(step.description);
      if (step.acceptanceCriteria?.length) {
        parts.push("Acceptance criteria:", ...step.acceptanceCriteria.map(c => `- ${c}`));
      }
      if (previousHandoff) {
        const summary = (previousHandoff as Record<string, unknown>).summary;
        if (typeof summary === "string") {
          parts.push("", "## Previous iteration output", summary);
        }
      }
      dispatcherResult = { prompt: parts.join("\n"), evaluationCriteria: step.evaluationCriteria ?? null };
      log.info("dispatcher skipped (step.skipDispatcher)", { stepId: step.id });
    } else {
      // Full dispatcher invocation
      const compactQueueState = queue.steps.map((s) => ({
        id: s.id,
        type: s.type,
        title: s.title,
        status: s.status,
      }));
      const dispatcherContext: Record<string, unknown> = {
        ...accumulator.getContext(),
        queueState: compactQueueState,
        ...(sessionObjective !== undefined ? { session_objective: sessionObjective } : {}),
        ...(previousHandoff ? { previousHandoff } : {}),
        ...(previousAssessment ? { previousAssessment } : {}),
        ...(hitlResponse !== null ? { hitlResponse } : {}),
        ...(guardrails ? {
          mutation_budget: guardrails.getMutationBudget(step.id, queue.steps.length),
        } : {}),
      };
      dispatcherResult = await dispatcher(step, dispatcherContext);
    }
    const currentPrompt = dispatcherResult.prompt;

    // Apply dispatcher mutation requests if guardrails are active
    if (dispatcherResult.mutationRequests?.length && guardrails) {
      log.info("applying dispatcher mutations", { stepId: step.id, count: dispatcherResult.mutationRequests.length });
      const provenance: Provenance = {
        actor: "dispatcher",
        reason: `mutations requested after dispatching step ${step.id}`,
      };
      const results = guardrails.applyMutations(
        queue,
        step.id,
        dispatcherResult.mutationRequests,
        provenance,
      );
      for (const r of results) {
        if (!r.applied) {
          log.warn("dispatcher mutation rejected", { stepId: step.id, reason: r.reason });
        }
      }
      await persistQueue();
    }

    // Spawn worker — race against abort signal
    onSubprocessDispatched?.();
    let workerOutput: WorkerOutput = await raceAbort(worker(step, currentPrompt), abortSignal);

    // Read handoff (best-effort)
    let handoffData: Record<string, unknown> | null = null;
    try {
      handoffData = await handoffReader(workerOutput.handoffPath);
    } catch (err) {
      log.warn("handoff read failed", {
        stepId: step.id,
        error: errorMessage(err),
      });
    }

    // Post-turn verification — informational. Runs declared commands, captures
    // results, and enriches handoffData for the evaluator. Never blocks the step.
    let postTurnPassed = true;
    if (deps.postTurnVerification) {
      const verifyResult = await deps.postTurnVerification({
        step,
        workerOutput,
        handoffData,
      });
      if (verifyResult) {
        postTurnPassed = verifyResult.passed;
        if (handoffData) {
          (handoffData as Record<string, unknown>).__nativeChecksPassed = verifyResult.passed;
          if (verifyResult.checks) {
            (handoffData as Record<string, unknown>).__nativeChecks = verifyResult.checks;
          }
        }
      }
    }

    const evaluationCriteria = dispatcherResult.evaluationCriteria;
    let lastEvalResult: EvalResult | null = null;

    // Evaluator decision: skip only when configured to skip AND post-turn passed.
    // Post-turn failure forces evaluation regardless of config — safety net.
    const shouldEvaluate = evaluator && (!deps.skipEvaluation || !postTurnPassed);
    if (shouldEvaluate) {
      const stepIndex = queue.steps.findIndex((s) => s.id === step.id);
      const revisionResult = await executeWithRevisions(
        step,
        currentPrompt,
        workerOutput,
        handoffData,
        evaluationCriteria,
        stepIndex,
        {
          evaluator,
          worker,
          handoffReader,
          emitter,
          workflowId,
          maxRevisions,
          abortSignal,
          onSubprocessDispatched,
        },
      );

      workerOutput = revisionResult.workerOutput;
      handoffData = revisionResult.handoffData;
      lastEvalResult = revisionResult.lastEvalResult;

      if (!revisionResult.passed) {
        await safeTransition(step.id, "failed", revisionResult.failReason!);
        emitter.queueStepFailed(workflowId, step.id, step.type, step.title, revisionResult.failReason!);

        if (onStepCompleted) {
          const hookResult = await onStepCompleted(step, "failed", queue, handoffData);
          if (hookResult.continueExecution) {
            return { outcome: "handled", previousHandoff, previousAssessment };
          }
        }

        return { outcome: "failed", previousHandoff, previousAssessment };
      }
    }

    // Accumulate context and chain handoff
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

    // Transition step to completed
    await safeTransition(step.id, "completed", "step execution completed successfully");
    emitter.queueStepCompleted(workflowId, step.id, step.type, step.title);

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

    // Call onStepCompleted hook
    if (onStepCompleted) {
      await onStepCompleted(step, "completed", queue, handoffData);
    }

    return { outcome: "completed", previousHandoff, previousAssessment };
  } catch (error) {
    // Abort/interrupt: revert the step to pending so it can be retried on resume
    if (error instanceof DOMException && error.name === "AbortError") {
      log.info("step interrupted by abort, reverting to pending", { stepId: step.id });
      await safeTransition(step.id, "pending", "interrupted by abort — will retry on resume");
      return { outcome: "failed", previousHandoff, previousAssessment };
    }

    // Worker crash or other error: mark step failed, don't throw
    const reason = errorMessage(error);
    log.warn("step execution failed", { stepId: step.id, reason });

    await safeTransition(step.id, "failed", reason);
    emitter.queueStepFailed(workflowId, step.id, step.type, step.title, reason);

    if (onStepCompleted) {
      const hookResult = await onStepCompleted(step, "failed", queue, null);
      if (hookResult.continueExecution) {
        return { outcome: "handled", previousHandoff, previousAssessment };
      }
    }

    return { outcome: "failed", previousHandoff, previousAssessment };
  }
}
