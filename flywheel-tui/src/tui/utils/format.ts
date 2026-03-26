/**
 * Format Utilities
 *
 * Shared formatting functions for TUI display strings.
 */

// ---------------------------------------------------------------------------
// Queue step progress info (replaces StageProgressInfo)
// ---------------------------------------------------------------------------

export interface QueueStepProgressInfo {
  /** 1-based index of the current step. */
  currentStep: number;
  /** Total number of steps in the queue. */
  totalSteps: number;
  /** Name/type of the current step (e.g. "plan", "work", "review"). */
  stepName: string;
}

/**
 * Format a queue step progress indicator string: "Step N/M".
 *
 * @example formatQueueStepProgress({ currentStep: 1, totalSteps: 3, stepName: "plan" }) → "Step 1/3"
 */
export function formatQueueStepProgress(info: QueueStepProgressInfo | null | undefined): string {
  if (!info || !info.currentStep || !info.totalSteps) return "";
  return `Step ${info.currentStep}/${info.totalSteps}`;
}

/**
 * Format the current step name, capitalized.
 *
 * @example formatQueueStepName({ currentStep: 1, totalSteps: 3, stepName: "plan" }) → "Plan"
 */
export function formatQueueStepName(info: QueueStepProgressInfo | null | undefined): string {
  if (!info || !info.stepName) return "";
  return info.stepName.charAt(0).toUpperCase() + info.stepName.slice(1);
}

// ---------------------------------------------------------------------------
// Legacy stage progress info (kept for backward compatibility in tests)
// ---------------------------------------------------------------------------

export interface StageProgressInfo {
  stage: number;
  total: number;
  stageName: string;
}

/**
 * Format a stage progress indicator string.
 *
 * @example formatStageProgress({ stage: 1, total: 3, stageName: "plan" }) → "Plan (1/3)"
 */
export function formatStageProgress(info: StageProgressInfo | null | undefined): string {
  if (!info || !info.stage || !info.total) return "";
  const name = info.stageName.charAt(0).toUpperCase() + info.stageName.slice(1);
  return `${name} (${info.stage}/${info.total})`;
}

// ---------------------------------------------------------------------------
// Sprint iteration info
// ---------------------------------------------------------------------------

export interface SprintIterationInfo {
  iteration: number;
  maxIterations: number;
}

/**
 * Format a sprint iteration indicator string.
 *
 * @example formatSprintIteration({ iteration: 2, maxIterations: 5 }) → "Sprint 2/5"
 */
export function formatSprintIteration(info: SprintIterationInfo | null | undefined): string {
  if (!info || !info.iteration || !info.maxIterations) return "";
  return `Sprint ${info.iteration}/${info.maxIterations}`;
}
