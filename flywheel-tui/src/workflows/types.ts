/**
 * Shared types for workflow output extractors.
 */

import type { WorkerResult } from "../schemas/worker";

/**
 * Legacy hook type retained for backward compatibility.
 * Called after a step completes with the step index, worker result,
 * and accumulated extra data from prior hooks.
 */
export type OnStepCompleteHook = (
  stepIndex: number,
  result: WorkerResult,
  accumulatedExtra: Record<string, unknown>,
) => Promise<Record<string, unknown>>;
