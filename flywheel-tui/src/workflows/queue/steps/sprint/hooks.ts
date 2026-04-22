import type { Step, Queue } from "../../types.js";
import { insertAfter } from "../../queue.js";
import { makeStep } from "../../templates.js";
import type {
  OnStepCompletedHook,
  OnStepCompletedResult,
} from "../../shared/hooks.js";
import type { SprintConfig } from "./config-schema.js";
import type {
  SprintIterationRecord,
  SprintLoopState,
} from "./types.js";
import { SPRINT_HINT } from "./types.js";
import { buildSprintEvaluationCriteria } from "./evaluator-criteria.js";

const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*/g;
const LINE_NUMBER_RE = /:\d+:\d+/g;
const DURATION_RE = /\d+(\.\d+)?\s*(milliseconds|seconds|sec|ms|s)\b/gi;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
// Strips volatile tokens so consecutive failures can be compared for stuck-detection.
function normalizeFeedback(raw: string): string {
  return raw
    .replace(TIMESTAMP_RE, "")
    .replace(LINE_NUMBER_RE, "")
    .replace(DURATION_RE, "")
    .replace(ANSI_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isStuck(
  history: SprintIterationRecord[],
  feedbackCache?: Map<number, string>,
): boolean {
  if (history.length < 2) return false;

  const prev = history[history.length - 2]!;
  const curr = history[history.length - 1]!;

  if (prev.nativeCheckPassed || curr.nativeCheckPassed) return false;

  const getNorm = (rec: SprintIterationRecord) =>
    feedbackCache?.get(rec.iteration) ?? (rec.evalFeedback ? normalizeFeedback(rec.evalFeedback) : null);

  const prevNorm = getNorm(prev);
  const currNorm = getNorm(curr);
  if (!prevNorm || !currNorm) return false;

  return prevNorm === currNorm;
}

function recordIteration(
  handoffData: Record<string, unknown> | null,
  status: "completed" | "failed",
  iterationNumber: number,
): SprintIterationRecord {
  const summary =
    (handoffData?.summary as string | undefined) ?? `Iteration ${iterationNumber}`;

  // verification can be a string OR an object with test_output_summary
  const verificationValue = handoffData?.verification;
  const verificationStr =
    typeof verificationValue === "string" ? verificationValue
    : typeof verificationValue === "object" && verificationValue !== null
      ? (verificationValue as Record<string, unknown>).test_output_summary as string | undefined
      : undefined;

  const rawFeedback =
    (handoffData?.eval_feedback as string | undefined) ??
    (handoffData?.feedback as string | undefined) ??
    verificationStr ??
    undefined;
  const evalFeedback = typeof rawFeedback === "string" ? rawFeedback : undefined;

  return {
    iteration: iterationNumber,
    workerSummary: summary,
    evalFeedback,
    nativeCheckPassed: status === "completed",
    workerCrashed: status === "failed" && handoffData === null,
  };
}

function buildRetryStep(
  originalStep: Step,
  history: SprintIterationRecord[],
  iterationNumber: number,
  maxIterations: number,
): Step {
  const lastRecord = history[history.length - 1];
  const priorSummary = lastRecord
    ? lastRecord.evalFeedback ?? lastRecord.workerSummary
    : "unknown";

  const description = `Sprint retry ${iterationNumber}/${maxIterations} — prior: ${priorSummary}`;

  return makeStep("work", `Sprint work (iteration ${iterationNumber})`, {
    description,
    dispatcherHint: SPRINT_HINT,
    skipDispatcher: true,
    evaluationCriteria: buildSprintEvaluationCriteria(history),
    toolScoping: originalStep.toolScoping,
    selfReviewItems: originalStep.selfReviewItems,
  });
}

export function createSprintHook(config: SprintConfig): {
  hook: OnStepCompletedHook;
} {
  let state: SprintLoopState = {
    status: "running",
    iterationCount: 0,
    history: [],
  };
  const feedbackCache = new Map<number, string>();

  const hook: OnStepCompletedHook = async (
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> => {
    if (step.dispatcherHint !== SPRINT_HINT) {
      return { continueExecution: false };
    }

    if (state.status !== "running") {
      return { continueExecution: false };
    }

    state.iterationCount++;
    const record = recordIteration(handoffData, status, state.iterationCount);
    state.history.push(record);
    if (record.evalFeedback) feedbackCache.set(record.iteration, normalizeFeedback(record.evalFeedback));

    if (status === "completed") {
      state = { ...state, status: "completed" };
      return { continueExecution: false };
    }

    if (config.detect_stuck && isStuck(state.history, feedbackCache)) {
      state = { ...state, status: "exhausted", reason: "Stuck: identical consecutive failures" };
      return { continueExecution: false };
    }

    if (state.iterationCount >= config.max_iterations) {
      state = { ...state, status: "exhausted", reason: "Max iterations reached" };
      return { continueExecution: false };
    }

    const retryStep = buildRetryStep(
      step,
      state.history,
      state.iterationCount + 1,
      config.max_iterations,
    );

    insertAfter(
      queue,
      step.id,
      [retryStep],
      { actor: "sprint-hook", reason: `Sprint retry: inserting work step for iteration ${state.iterationCount + 1}` },
    );

    return { continueExecution: true };
  };

  return { hook };
}
