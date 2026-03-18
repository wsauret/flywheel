/**
 * Format Utilities
 *
 * Shared formatting functions for TUI display strings.
 */

export interface PipelineStageInfo {
  stage: number;
  total: number;
  stageName: string;
}

/**
 * Format a pipeline stage indicator string.
 *
 * @example formatPipelineStage({ stage: 1, total: 3, stageName: "plan" }) → "Plan (1/3)"
 */
export function formatPipelineStage(info: PipelineStageInfo | null | undefined): string {
  if (!info || !info.stage || !info.total) return "";
  const name = info.stageName.charAt(0).toUpperCase() + info.stageName.slice(1);
  return `${name} (${info.stage}/${info.total})`;
}
