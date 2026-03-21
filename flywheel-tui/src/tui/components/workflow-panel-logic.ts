/**
 * WorkflowPanel Logic — Pure functions for workflow panel display
 *
 * Separated from JSX to enable unit testing without OpenTUI rendering.
 * Handles: progress computation, status labels.
 */

import type { PhaseState, StageGroup } from "../routes/work/state/types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PanelProgress {
  completed: number
  total: number
  running: number
  failed: number
}

// ---------------------------------------------------------------------------
// computeProgress
// ---------------------------------------------------------------------------

/** Compute progress summary from phase states. */
export function computeProgress(phases: readonly PhaseState[]): PanelProgress {
  let completed = 0
  let running = 0
  let failed = 0
  for (const p of phases) {
    if (p.status === "completed") completed++
    else if (p.status === "running") running++
    else if (p.status === "failed") failed++
  }
  return { completed, total: phases.length, running, failed }
}

// ---------------------------------------------------------------------------
// computeStageProgress
// ---------------------------------------------------------------------------

/** Compute progress summary across all stages (flattens stage phases). */
export function computeStageProgress(stages: readonly StageGroup[]): PanelProgress {
  let completed = 0
  let running = 0
  let failed = 0
  let total = 0
  for (const stage of stages) {
    for (const p of stage.phases) {
      total++
      if (p.status === "completed") completed++
      else if (p.status === "running") running++
      else if (p.status === "failed") failed++
    }
  }
  return { completed, total, running, failed }
}

// ---------------------------------------------------------------------------
// statusLabel
// ---------------------------------------------------------------------------

import type { WorkflowStatus } from "../routes/work/state/types"

/** Map workflow status to a human-readable label. */
export function statusLabel(status: WorkflowStatus): string {
  switch (status) {
    case "idle":        return "Idle"
    case "running":     return "Running"
    case "completed":   return "Completed"
    case "failed":      return "Failed"
    case "interrupted": return "Interrupted"
    case "stopping":    return "Stopping"
    default:            return String(status)
  }
}
