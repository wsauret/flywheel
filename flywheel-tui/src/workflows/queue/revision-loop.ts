// ---------------------------------------------------------------------------
// Revision Loop — Evaluator + Worker Retry Logic
// ---------------------------------------------------------------------------
//
// Extracts the evaluate→revise→re-evaluate loop from the step executor.
// Given a worker output and evaluation criteria, runs the evaluator and
// (if configured) retries the worker up to maxRevisions times with
// evaluator feedback appended to the prompt.
// ---------------------------------------------------------------------------

import type { Step } from "./types";
import type {
  EvalResult,
  EvaluatorFn,
  WorkerFn,
  WorkerOutput,
  HandoffReaderFn,
} from "./executor-types.js";
import type { FlywheelEmitter } from "../../protocol/event-bus";
import { raceAbort } from "./abort-utils.js";
import { Log } from "../shared/log";

const log = Log.create({ service: "step-executor" });

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
// Revision loop dependencies
// ---------------------------------------------------------------------------

export interface RevisionLoopDeps {
  evaluator: EvaluatorFn;
  worker: WorkerFn;
  handoffReader: HandoffReaderFn;
  emitter: FlywheelEmitter;
  workflowId: string;
  maxRevisions: number;
  abortSignal: AbortSignal;
  onWorkerDispatched?: (() => void) | null;
}

// ---------------------------------------------------------------------------
// Revision loop result
// ---------------------------------------------------------------------------

export interface RevisionLoopResult {
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

// ---------------------------------------------------------------------------
// executeWithRevisions
// ---------------------------------------------------------------------------

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
  evaluationCriteria: unknown | null,
  stepIndex: number,
  deps: RevisionLoopDeps,
): Promise<RevisionLoopResult> {
  const {
    evaluator,
    worker,
    handoffReader,
    emitter,
    workflowId,
    maxRevisions,
    abortSignal,
    onWorkerDispatched,
  } = deps;

  let prompt = currentPrompt;
  let output = workerOutput;
  let handoff = handoffData;

  emitter.evaluatorInvoked(workflowId, stepIndex);

  let evalResult = await evaluator(step, output.output, evaluationCriteria, handoff);

  if (evalResult.transportError) {
    log.warn("evaluator transport failed, continuing with graceful degradation", {
      stepId: step.id,
      reason: evalResult.reason,
    });
    emitter.evaluatorFailed(workflowId, evalResult.reason ?? "transport error");
    return {
      workerOutput: output,
      handoffData: handoff,
      lastEvalResult: evalResult,
      passed: true,
      failReason: null,
    };
  }

  emitter.evaluatorCompleted(workflowId, {
    passed: evalResult.passed,
    reasoning: evalResult.reason ?? "",
    suggestions: evalResult.suggestions,
    confidence: 0,
    feedback: evalResult.feedback ?? "",
    files_to_review: [],
    issues: [],
  });

  let revisionAttempt = 0;
  while (!evalResult.passed && !evalResult.skipped && revisionAttempt < maxRevisions) {
    revisionAttempt++;

    log.info("starting revision attempt", {
      stepId: step.id,
      revisionAttempt,
      maxRevisions,
      reason: evalResult.reason,
    });

    emitter.evaluatorRevisionRequested(workflowId, stepIndex, revisionAttempt, maxRevisions, evalResult.reason ?? "revision needed");

    prompt = buildRevisionPrompt(prompt, evalResult);

    onWorkerDispatched?.();
    output = await raceAbort(worker(step, prompt), abortSignal);

    try {
      handoff = await handoffReader(output.handoffPath);
    } catch {
      handoff = null;
    }

    emitter.evaluatorInvoked(workflowId, stepIndex);
    evalResult = await evaluator(step, output.output, evaluationCriteria, handoff);

    if (evalResult.transportError) {
      log.warn("evaluator transport failed during revision, skipping further evaluation", {
        stepId: step.id,
        revisionAttempt,
      });
      emitter.evaluatorFailed(workflowId, evalResult.reason ?? "transport error during revision");
      return {
        workerOutput: output,
        handoffData: handoff,
        lastEvalResult: evalResult,
        passed: true,
        failReason: null,
      };
    }

    emitter.evaluatorCompleted(workflowId, {
      passed: evalResult.passed,
      reasoning: evalResult.reason ?? "",
      suggestions: evalResult.suggestions,
      confidence: 0,
      feedback: evalResult.feedback ?? "",
      files_to_review: [],
      issues: [],
    });
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
