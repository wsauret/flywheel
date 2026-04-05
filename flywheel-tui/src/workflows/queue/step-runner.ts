// ---------------------------------------------------------------------------
// Step Runner — single-step execution: dispatch → worker → eval → accumulate
// ---------------------------------------------------------------------------

import type { Step, Queue } from "./types";
import type { FlywheelEmitter } from "../../protocol/event-bus";
import type {
  EvalResult,
  DispatcherFn,
  EvaluatorFn,
  WorkerFn,
  WorkerOutput,
  HandoffReaderFn,
  GateQuestionService,
  StepContextAccumulator,
} from "./executor-types.js";
import type { OnStepCompletedHook } from "./shared/hooks";
import type { Guardrails } from "./guardrails";
import { type Provenance } from "./queue";
import { executeWithRevisions } from "./revision-loop.js";
import { raceAbort } from "./abort-utils.js";
import { Log } from "../shared/log";
import { errorMessage } from "../shared/error-message";

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
  onSessionName?: ((name: string) => void) | null;
  onWorkerDispatched?: (() => void) | null;

  // Mutable state shared with the executor loop
  previousHandoff: Record<string, unknown> | null;
  previousAssessment: EvalResult | null;
  sessionNameEmitted: boolean;

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
  /** Updated sessionNameEmitted flag */
  sessionNameEmitted: boolean;
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
    onSessionName,
    onWorkerDispatched,
    safeTransition,
    persistQueue,
  } = deps;

  let { previousHandoff, previousAssessment, sessionNameEmitted } = deps;

  emitter.queueStepStarted(workflowId, step.id, step.type, step.title);
  const transitioned = await safeTransition(step.id, "running", "starting step execution");
  if (!transitioned) {
    emitter.queueStepFailed(workflowId, step.id, step.type, step.title, "Failed to transition to running");
    return { outcome: "failed", previousHandoff, previousAssessment, sessionNameEmitted };
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

    // Invoke dispatcher for prompt assembly
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
    const dispatcherResult = await dispatcher(step, dispatcherContext);
    const currentPrompt = dispatcherResult.prompt;

    // Emit session name on the first dispatcher call that returns one
    if (!sessionNameEmitted && dispatcherResult.sessionName && onSessionName) {
      sessionNameEmitted = true;
      onSessionName(dispatcherResult.sessionName);
    }

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
    onWorkerDispatched?.();
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

    const evaluationCriteria = dispatcherResult.evaluationCriteria;
    let lastEvalResult: EvalResult | null = null;

    // Evaluator + revision loop (delegated to revision-loop module)
    if (evaluator) {
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
          onWorkerDispatched,
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
            return { outcome: "handled", previousHandoff, previousAssessment, sessionNameEmitted };
          }
        }

        return { outcome: "failed", previousHandoff, previousAssessment, sessionNameEmitted };
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

    return { outcome: "completed", previousHandoff, previousAssessment, sessionNameEmitted };
  } catch (error) {
    // Abort/interrupt: revert the step to pending so it can be retried on resume
    if (error instanceof DOMException && error.name === "AbortError") {
      log.info("step interrupted by abort, reverting to pending", { stepId: step.id });
      await safeTransition(step.id, "pending", "interrupted by abort — will retry on resume");
      return { outcome: "failed", previousHandoff, previousAssessment, sessionNameEmitted };
    }

    // Worker crash or other error: mark step failed, don't throw
    const reason = errorMessage(error);
    log.warn("step execution failed", { stepId: step.id, reason });

    await safeTransition(step.id, "failed", reason);
    emitter.queueStepFailed(workflowId, step.id, step.type, step.title, reason);

    if (onStepCompleted) {
      const hookResult = await onStepCompleted(step, "failed", queue, null);
      if (hookResult.continueExecution) {
        return { outcome: "handled", previousHandoff, previousAssessment, sessionNameEmitted };
      }
    }

    return { outcome: "failed", previousHandoff, previousAssessment, sessionNameEmitted };
  }
}
