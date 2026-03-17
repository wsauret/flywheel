/**
 * Session Header Logic — Pure functions for session header display
 *
 * Separated from JSX to enable unit testing without OpenTUI rendering.
 */

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
  workflowStatus?: "idle" | "running" | "completed" | "failed" | "interrupted" | "stopping"
  lastActivity?: string
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
