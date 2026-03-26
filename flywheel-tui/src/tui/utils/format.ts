/**
 * Format Utilities
 *
 * Shared formatting functions for TUI display strings.
 */

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
