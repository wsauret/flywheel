// ---------------------------------------------------------------------------
// Sprint Hook — Core Loop
// ---------------------------------------------------------------------------
//
// Ported from src-legacy/queue/steps/sprint-work/hooks.ts
// (createSprintQueueHandler). Adapted to the new architecture:
//   - No verify step handling (native verification replaces scripts)
//   - Hook tracks eval feedback internally in closure state
//   - SprintLoopState discriminated union (not two booleans)
//   - insertAfter() called BEFORE returning { continueExecution: true }
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
import type {
  SprintConfig,
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
// buildEscalationSteps — [plan, work, review] for escalation
// ---------------------------------------------------------------------------

function buildEscalationSteps(
  history: SprintIterationRecord[],
): Step[] {
  const lastFeedback = history[history.length - 1]?.evalFeedback ?? "Sprint exhausted iterations";
  const context = `Escalation after ${history.length} sprint iterations. Last feedback: ${lastFeedback}`;

  return [
    makeStep("plan", "Escalation: create new plan", { description: context }),
    makeStep("work", "Escalation: implement plan", { description: context }),
    makeStep("review", "Escalation: review changes", { description: context }),
  ];
}

// ---------------------------------------------------------------------------
// insertEscalationSteps — insert [plan, work, review] after a step
// ---------------------------------------------------------------------------

function insertEscalation(
  queue: Queue,
  afterStepId: string,
  history: SprintIterationRecord[],
): boolean {
  const steps = buildEscalationSteps(history);
  const result = insertAfter(
    queue,
    afterStepId,
    steps,
    makeProvenance(
      `Sprint escalation: max iterations (${history.length}) reached`,
    ),
  );
  return result.success;
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

    // Guard: if already completed or escalated, no-op
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
    // Failed — check stuck detection (before max iterations)
    // -----------------------------------------------------------------------
    if (config.escalate_on_stuck && isStuck(state.history)) {
      state.status = "escalated";
      state.reason = "Stuck: identical consecutive failures";
      if (config.escalate_to_full) {
        insertEscalation(queue, step.id, state.history);
      }
      // Always pause — escalation steps (if inserted) will execute on resume
      return { continueExecution: false };
    }

    // -----------------------------------------------------------------------
    // Failed — check max iterations
    // -----------------------------------------------------------------------
    if (state.iterationCount >= config.max_iterations) {
      state.status = "escalated";
      state.reason = "Max iterations reached";
      if (config.escalate_to_full) {
        insertEscalation(queue, step.id, state.history);
      }
      // Always pause — escalation steps (if inserted) will execute on resume
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
