// ---------------------------------------------------------------------------
// Queue System — Hook Types & Composite
// ---------------------------------------------------------------------------
//
// Shared types and utilities for onStepCompleted hooks used by the
// step executor. Extracted here so that plan-integration, sprint,
// debug-loop, review-fix-injection, and review-p3-triage
// can all import from a single location without
// pulling in the full executor module.
//
// Placement: src/queue/hooks.ts
// ---------------------------------------------------------------------------

import type { Step, Queue } from "./types";

// ---------------------------------------------------------------------------
// OnStepCompleted hook type
// ---------------------------------------------------------------------------

export interface OnStepCompletedResult {
  /** When true for a failed step, the executor continues instead of stopping. */
  continueExecution: boolean;
}

/**
 * Hook called after a step transitions to completed or failed.
 * Receives the step, its final status, the queue (for mutation),
 * and the handoff data (if available).
 */
export type OnStepCompletedHook = (
  step: Step,
  status: "completed" | "failed",
  queue: Queue,
  handoffData: Record<string, unknown> | null,
) => Promise<OnStepCompletedResult>;

// ---------------------------------------------------------------------------
// createCompositeHook — chains multiple onStepCompleted hooks
// ---------------------------------------------------------------------------

/**
 * Creates a composite hook that chains multiple `onStepCompleted` hooks.
 * Hooks are called in order. If any hook returns `{ continueExecution: true }`,
 * the composite returns `{ continueExecution: true }`.
 *
 * This allows combining plan-integration, sprint, and other hooks into
 * a single hook for the step executor.
 *
 * @param hooks Array of hooks to chain (null/undefined entries are skipped)
 * @returns A single OnStepCompletedHook that chains all provided hooks
 */
export function createCompositeHook(
  hooks: Array<OnStepCompletedHook | null | undefined>,
): OnStepCompletedHook {
  const activeHooks = hooks.filter(
    (h): h is OnStepCompletedHook => h != null,
  );

  return async (
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> => {
    let shouldContinue = false;

    for (const hook of activeHooks) {
      const result = await hook(step, status, queue, handoffData);
      if (result.continueExecution) {
        shouldContinue = true;
      }
    }

    return { continueExecution: shouldContinue };
  };
}
