/**
 * WorkflowPanel Logic — Pure functions for workflow panel display
 *
 * Separated from JSX to enable unit testing without OpenTUI rendering.
 * Handles: progress computation, status labels, step icons, step type labels.
 */

import type { QueueStepState, QueueStepStatus } from "../routes/work/state/types"

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

// ---------------------------------------------------------------------------
// getStepTypeLabel — human-readable step type label
// ---------------------------------------------------------------------------

/** Capitalize a step type for display. */
export function getStepTypeLabel(type: string): string {
  if (type.length === 0) return type
  return type.charAt(0).toUpperCase() + type.slice(1)
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
