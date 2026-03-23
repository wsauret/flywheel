/**
 * Session Header Logic — Pure functions for session header display
 *
 * Separated from JSX to enable unit testing without OpenTUI rendering.
 * Includes lifecycle → workflow status mapping for historical sessions.
 */

import type { SessionLifecycleState } from "../../session/state-machine"
import type { WorkflowStatus } from "../routes/work/state/types"
import type { SessionSummary } from "../../session/manager"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionHeaderInfo {
  sessionName: string
  planName?: string
  repo?: string
  branch?: string
  currentPhase?: string
  phaseStatus?: "pending" | "running" | "completed" | "failed" | "skipped"
  workflowStatus?: WorkflowStatus
  lastActivity?: string
}

// ---------------------------------------------------------------------------
// lifecycleToWorkflowStatus
// ---------------------------------------------------------------------------

/**
 * Map a session lifecycle state to the WorkflowStatus used by the TUI header.
 *
 * This is used for historical (non-running) sessions where the WorkflowStatus
 * is derived from the persisted lifecycle state, NOT from a live store.
 */
export function lifecycleToWorkflowStatus(state: SessionLifecycleState): WorkflowStatus {
  switch (state) {
    case "work:active":
    case "work:review":
      return "running"
    case "work:paused":
    case "budget_exhausted":
      return "interrupted"
    case "completed":
    case "archived":
    case "trashed":
      return "completed"
    // Plan stages and "new"
    default:
      return "idle"
  }
}

// ---------------------------------------------------------------------------
// deriveHeaderInfo
// ---------------------------------------------------------------------------

/**
 * Derive SessionHeaderInfo from a SessionSummary.
 *
 * Used when viewing a historical (non-running) session — the header info
 * is derived from persisted metadata rather than from the live store.
 *
 * IMPORTANT: Does NOT set startTime — that is managed separately by the
 * store/shell to avoid incorrect timestamps on historical sessions.
 */
export function deriveHeaderInfo(summary: SessionSummary): SessionHeaderInfo {
  return {
    sessionName: summary.name || summary.label,
    planName: summary.planPath ?? summary.label,
    workflowStatus: lifecycleToWorkflowStatus(summary.lifecycleState),
    branch: summary.branch,
    repo: summary.repo,
  }
}

// ---------------------------------------------------------------------------
// formatSessionStatus
// ---------------------------------------------------------------------------

/** Format the right-side status string for the session header. */
export function formatSessionStatus(info: SessionHeaderInfo): string {
  const parts: string[] = []

  if (info.currentPhase) {
    const icon = info.phaseStatus === "running" ? "\u25d3"
      : info.phaseStatus === "completed" ? "\u25cf"
      : info.phaseStatus === "failed" ? "\u2717"
      : "\u25cb"
    parts.push(`${icon} ${info.currentPhase}`)
  }

  if (info.branch) {
    parts.push(`\u2387 ${info.branch}`)
  }

  return parts.join("  ")
}
