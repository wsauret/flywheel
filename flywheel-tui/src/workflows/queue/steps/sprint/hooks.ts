// ---------------------------------------------------------------------------
// Sprint Hook — Core Loop
// ---------------------------------------------------------------------------
//
// Retry loop for sprint mode. On failure: retry up to max_iterations,
// detect stuck (identical consecutive failures), then stop.
//
// Factory: createSprintHook(config) → OnStepCompletedHook
// ---------------------------------------------------------------------------

import type { Step, Queue } from "../../types.js";
import { insertAfter, type Provenance } from "../../queue.js";
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

// ---------------------------------------------------------------------------
// Provenance helper
// ---------------------------------------------------------------------------

function makeProvenance(reason: string): Provenance {
  return { actor: "sprint-hook", reason };
}

// ---------------------------------------------------------------------------
// Feedback normalization — strip noise that makes identical failures look
// different (timestamps, line numbers, test durations).
// ---------------------------------------------------------------------------

const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[.\d]*/g;
const LINE_NUMBER_RE = /:\d+:\d+/g;
const DURATION_RE = /\d+(\.\d+)?\s*(milliseconds|seconds|sec|ms|s)\b/gi;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function normalizeFeedback(raw: string): string {
  return raw
    .replace(TIMESTAMP_RE, "")
    .replace(LINE_NUMBER_RE, "")
    .replace(DURATION_RE, "")
    .replace(ANSI_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// isStuck — detect identical consecutive failures
// ---------------------------------------------------------------------------

export function isStuck(history: SprintIterationRecord[]): boolean {
  if (history.length < 2) return false;

  const prev = history[history.length - 2];
  const curr = history[history.length - 1];

  // Both must be non-completed iterations (failed or crashed)
  if (prev.nativeCheckPassed || curr.nativeCheckPassed) return false;

  // Use cached normalized feedback when available, fall back to normalizing on the fly
  const prevNorm = prev._normalizedFeedback ?? (prev.evalFeedback ? normalizeFeedback(prev.evalFeedback) : null);
  const currNorm = curr._normalizedFeedback ?? (curr.evalFeedback ? normalizeFeedback(curr.evalFeedback) : null);
  if (!prevNorm || !currNorm) return false;

  return prevNorm === currNorm;
}

// ---------------------------------------------------------------------------
// recordIteration — extract summary + eval feedback from handoffData
// ---------------------------------------------------------------------------

export function recordIteration(
  handoffData: Record<string, unknown> | null,
  status: "completed" | "failed",
  iterationNumber: number,
): SprintIterationRecord {
  const summary =
    (handoffData?.summary as string | undefined) ?? `Iteration ${iterationNumber}`;

  // Extract eval feedback from handoffData if present.
  // The hook works WITHOUT evaluator feedback (handoffData is raw worker handoff).
  // The verification field can be a string OR an object with test_output_summary.
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
  // Ensure we only pass strings to normalizeFeedback
  const evalFeedback = typeof rawFeedback === "string" ? rawFeedback : undefined;

  return {
    iteration: iterationNumber,
    workerSummary: summary,
    evalFeedback,
    nativeCheckPassed: status === "completed",
    workerCrashed: status === "failed" && handoffData === null,
    _normalizedFeedback: evalFeedback ? normalizeFeedback(evalFeedback) : undefined,
  };
}

// ---------------------------------------------------------------------------
// buildRetryStep — create a new work step for the next sprint iteration
// ---------------------------------------------------------------------------

export function buildRetryStep(
  originalStep: Step,
  history: SprintIterationRecord[],
  iterationNumber: number,
  maxIterations: number,
): Step {
  const lastRecord = history[history.length - 1];
  const priorSummary = lastRecord
    ? lastRecord.evalFeedback ?? lastRecord.workerSummary
    : "unknown";

  // Brief description only — full history stays in closure
  const description = `Sprint retry ${iterationNumber}/${maxIterations} — prior: ${priorSummary}`;

  return makeStep("work", `Sprint work (iteration ${iterationNumber})`, {
    description,
    dispatcherHint: SPRINT_HINT,
    skipDispatcher: true,
    evaluationCriteria: originalStep.evaluationCriteria,
    toolScoping: originalStep.toolScoping,
  });
}

// ---------------------------------------------------------------------------
// createSprintHook — factory returning OnStepCompletedHook
// ---------------------------------------------------------------------------

export function createSprintHook(config: SprintConfig): {
  hook: OnStepCompletedHook;
  getState: () => Readonly<SprintLoopState>;
} {
  // Internal closure state
  const state: SprintLoopState = {
    status: "running",
    iterationCount: 0,
    history: [],
  };

  // -------------------------------------------------------------------------
  // getState — snapshot of current sprint state
  // -------------------------------------------------------------------------

  function getState(): Readonly<SprintLoopState> {
    return {
      status: state.status,
      iterationCount: state.iterationCount,
      history: [...state.history],
      reason: state.reason,
    };
  }

  // -------------------------------------------------------------------------
  // onStepCompleted — the hook
  // -------------------------------------------------------------------------

  const hook: OnStepCompletedHook = async (
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> => {
    // Guard: only process sprint-hinted steps
    if (step.dispatcherHint !== SPRINT_HINT) {
      return { continueExecution: false };
    }

    // Guard: if already completed or exhausted, no-op
    if (state.status !== "running") {
      return { continueExecution: false };
    }

    // Record iteration
    state.iterationCount++;
    const record = recordIteration(handoffData, status, state.iterationCount);
    state.history.push(record);

    // -----------------------------------------------------------------------
    // Completed — sprint succeeded
    // -----------------------------------------------------------------------
    if (status === "completed") {
      state.status = "completed";
      return { continueExecution: false };
    }

    // -----------------------------------------------------------------------
    // Failed — check stuck detection (identical consecutive failures)
    // -----------------------------------------------------------------------
    if (config.detect_stuck && isStuck(state.history)) {
      state.status = "exhausted";
      state.reason = "Stuck: identical consecutive failures";
      return { continueExecution: false };
    }

    // -----------------------------------------------------------------------
    // Failed — check max iterations
    // -----------------------------------------------------------------------
    if (state.iterationCount >= config.max_iterations) {
      state.status = "exhausted";
      state.reason = "Max iterations reached";
      return { continueExecution: false };
    }

    // -----------------------------------------------------------------------
    // Failed — insert retry step, then return continue
    // (insertAfter MUST happen before return)
    // -----------------------------------------------------------------------
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
      makeProvenance(
        `Sprint retry: inserting work step for iteration ${state.iterationCount + 1}`,
      ),
    );

    return { continueExecution: true };
  };

  return { hook, getState };
}
