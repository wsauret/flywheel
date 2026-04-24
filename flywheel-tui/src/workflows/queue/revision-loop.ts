// Revision Loop — Evaluator + Worker Retry Logic
//
// Extracts the evaluate→revise→re-evaluate loop from the step executor.
// Given a worker output and evaluation criteria, runs the evaluator and
// (if configured) retries the worker up to maxRevisions times with
// evaluator feedback appended to the prompt.

import type { Step } from "./types.js";
import type { EvalResult } from "./step-dispatcher-types.js";
import type {
  EvaluatorFn,
  WorkerFn,
  WorkerOutput,
  HandoffReaderFn,
} from "./executor-types.js";
import type { EmitFn } from "../../infra/event-bus.js";
import type { EvaluationCriteria } from "../../infra/workflow-types.js";
import { raceAbort } from "./abort-utils.js";
import { Log } from "../../infra/log.js";
import { errorMessage } from "../../infra/error-message.js";

const log = Log.create({ service: "step-executor" });

/** Build the revision delta — feedback-only, for use on a resumed worker conversation. */
function buildRevisionDelta(evalResult: EvalResult): string {
  const parts = ["## Revision Required"]
  if (evalResult.reason) parts.push(`### Evaluator Reasoning\n${evalResult.reason}`)
  if (evalResult.feedback) parts.push(`### Feedback\n${evalResult.feedback}`)
  if (evalResult.suggestions.length) {
    parts.push(`### Suggestions\n${evalResult.suggestions.map(s => `- ${s}`).join("\n")}`)
  }
  return parts.join("\n\n")
}

/** Full revision prompt — original prompt + delta. Used when the worker engine can't resume. */
function buildRevisionPrompt(originalPrompt: string, evalResult: EvalResult): string {
  return `${originalPrompt}\n\n${buildRevisionDelta(evalResult)}`
}

interface RevisionLoopDeps {
  evaluator: EvaluatorFn;
  worker: WorkerFn;
  handoffReader: HandoffReaderFn;
  emit: EmitFn;
  workflowId: string;
  maxRevisions: number;
  abortSignal: AbortSignal;
  onWorkerInvoked?: (() => void) | null;
}

interface RevisionLoopResult {
  /** Final worker output after all revisions */
  workerOutput: WorkerOutput;
  /** Final handoff data */
  handoffData: Record<string, unknown> | null;
  /** Last evaluator result (null if evaluator was not invoked) */
  lastEvalResult: EvalResult;
  /** Whether the step passed evaluation (or was skipped/transport-errored) */
  passed: boolean;
  /** Failure reason if not passed */
  failReason: string | null;
}

/**
 * Run the evaluator on the worker output, then retry with feedback up to
 * maxRevisions times if evaluation fails. Returns the final result with
 * pass/fail status.
 *
 * The caller is responsible for the initial worker dispatch; this function
 * handles evaluation and any subsequent revision cycles.
 */
export async function executeWithRevisions(
  step: Step,
  currentPrompt: string,
  workerOutput: WorkerOutput,
  handoffData: Record<string, unknown> | null,
  evaluationCriteria: EvaluationCriteria | null,
  stepIndex: number,
  deps: RevisionLoopDeps,
): Promise<RevisionLoopResult> {
  const {
    evaluator,
    worker,
    handoffReader,
    emit,
    workflowId,
    maxRevisions,
    abortSignal,
    onWorkerInvoked,
  } = deps;

  const emitEvalCompleted = (result: EvalResult) => {
    emit("evaluator:completed", { workflowId, result: {
      passed: result.passed,
      reasoning: result.reason ?? "",
    } });
  };

  let prompt = currentPrompt;
  let output = workerOutput;
  let handoff = handoffData;

  emit("evaluator:invoked", { workflowId, stepIndex });

  let evalResult = await evaluator(step, output.output, evaluationCriteria, handoff, currentPrompt, abortSignal);

  if (evalResult.transportError) {
    log.warn("evaluator transport failed, continuing with graceful degradation", {
      stepId: step.id,
      reason: evalResult.reason,
    });
    emit("evaluator:failed", { workflowId, reason: evalResult.reason ?? "transport error" });
    return {
      workerOutput: output,
      handoffData: handoff,
      lastEvalResult: evalResult,
      passed: true,
      failReason: null,
    };
  }

  emitEvalCompleted(evalResult);

  let revisionAttempt = 0;
  while (!evalResult.passed && !evalResult.skipped && revisionAttempt < maxRevisions) {
    revisionAttempt++;

    log.info("starting revision attempt", {
      stepId: step.id,
      revisionAttempt,
      maxRevisions,
      reason: evalResult.reason,
    });

    emit("evaluator:revision-requested", { workflowId, stepIndex, revisionAttempt, maxRevisions, reason: evalResult.reason ?? "revision needed" });

    // Prefer resume (feedback-only delta on the existing conversation); fall back
    // to re-sending the full prompt if the previous invocation didn't expose a
    // session ID.
    const prevSessionId = output.sessionId;
    const revisionMessage = prevSessionId
      ? buildRevisionDelta(evalResult)
      : buildRevisionPrompt(prompt, evalResult);

    if (!prevSessionId) prompt = buildRevisionPrompt(prompt, evalResult);

    onWorkerInvoked?.();
    output = await raceAbort(worker(step, revisionMessage, abortSignal, prevSessionId), abortSignal);

    try {
      handoff = await handoffReader(output.handoffPath);
    } catch (err) {
      log.warn("handoff read failed during revision", { stepId: step.id, error: errorMessage(err) });
      handoff = null;
    }

    emit("evaluator:invoked", { workflowId, stepIndex });
    evalResult = await evaluator(step, output.output, evaluationCriteria, handoff, currentPrompt, abortSignal);

    if (evalResult.transportError) {
      log.warn("evaluator transport failed during revision, skipping further evaluation", {
        stepId: step.id,
        revisionAttempt,
      });
      emit("evaluator:failed", { workflowId, reason: evalResult.reason ?? "transport error during revision" });
      return {
        workerOutput: output,
        handoffData: handoff,
        lastEvalResult: evalResult,
        passed: true,
        failReason: null,
      };
    }

    emitEvalCompleted(evalResult);
  }

  if (!evalResult.passed && !evalResult.skipped && !evalResult.transportError) {
    const failReason = maxRevisions > 0
      ? `Evaluation failed after ${revisionAttempt} revision(s): ${evalResult.reason}`
      : `Evaluation failed: ${evalResult.reason}`;

    return {
      workerOutput: output,
      handoffData: handoff,
      lastEvalResult: evalResult,
      passed: false,
      failReason,
    };
  }

  return {
    workerOutput: output,
    handoffData: handoff,
    lastEvalResult: evalResult,
    passed: true,
    failReason: null,
  };
}
