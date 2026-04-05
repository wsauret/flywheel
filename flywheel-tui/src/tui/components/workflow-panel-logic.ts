/**
 * WorkflowPanel Logic — Pure functions for workflow panel display
 *
 * Separated from JSX to enable unit testing without OpenTUI rendering.
 * Handles: progress computation, status labels, step icons, step type labels.
 */

import type { QueueStepState, QueueStepStatus } from "../types"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PanelProgress {
  completed: number
  total: number
  running: number
  failed: number
}

const STEP_TITLE_MAX_WITH_DURATION = 14
const STEP_TITLE_MAX_WITHOUT_DURATION = 22

// ---------------------------------------------------------------------------
// computeQueueProgress — queue step progress
// ---------------------------------------------------------------------------

/** Compute progress summary from queue step states. */
export function computeQueueProgress(steps: readonly QueueStepState[]): PanelProgress {
  let completed = 0
  let running = 0
  let failed = 0
  for (const s of steps) {
    if (s.status === "completed") completed++
    else if (s.status === "running") running++
    else if (s.status === "failed") failed++
  }
  return { completed, total: steps.length, running, failed }
}

// ---------------------------------------------------------------------------
// getStepStatusIcon — icon per step status
// ---------------------------------------------------------------------------

/** Get the display icon for a queue step status. */
export function getStepStatusIcon(status: QueueStepStatus): string {
  switch (status) {
    case "pending":   return "○"
    case "running":   return "◐"  // Fallback; Spinner component is used for running
    case "completed": return "✓"
    case "failed":    return "✗"
    case "skipped":   return "⊘"
    default:          return "?"
  }
}

export function getDisplayedStepStatus(status: QueueStepStatus, isInterrupted: boolean): QueueStepStatus | "paused" {
  if (isInterrupted && status === "running") return "paused"
  return status
}

export function getDisplayedWorkflowStatus(status: WorkflowStatus, isInterrupted: boolean): WorkflowStatus | "paused" {
  if (isInterrupted && status === "running") return "interrupted"
  return status
}

// ---------------------------------------------------------------------------
// getStepTypeLabel — human-readable step type label
// ---------------------------------------------------------------------------

/** Capitalize a step type for display. */
export function getStepTypeLabel(type: string): string {
  if (type.length === 0) return type
  return type.charAt(0).toUpperCase() + type.slice(1)
}

/**
 * Get the max visible title width for a queue step row.
 * Keeps enough room for the right-aligned duration column.
 */
export function getStepTitleMaxWidth(hasDuration: boolean): number {
  return hasDuration ? STEP_TITLE_MAX_WITH_DURATION : STEP_TITLE_MAX_WITHOUT_DURATION
}

import type { WorkflowStatus } from "../types"
