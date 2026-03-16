/**
 * Status Icons and Colors for Phase Display
 * Ported from: src/ui/utils/statusIcons.ts
 */

import type { RGBA } from "@opentui/core"
import type { PhaseStatus } from "../state/types"
import type { Theme } from "@tui/shared/context/theme"

/**
 * Get status icon for phase
 */
export function getStatusIcon(status: PhaseStatus): string {
  switch (status) {
    case "pending":
      return "○" // Empty circle
    case "running":
      return "◐" // Fallback (animated by Spinner component)
    case "completed":
      return "●" // Green filled circle
    case "failed":
      return "✗" // Red X for failed
    case "skipped":
      return "⊘" // Skipped (distinct from completed)
    case "manual-review":
      return "◉" // Awaiting user review
    default:
      return "?"
  }
}

/**
 * Get color for status
 */
export function getStatusColor(status: PhaseStatus, theme: Theme): RGBA {
  switch (status) {
    case "completed":
      return theme.success // green
    case "running":
      return theme.primary // blue
    case "failed":
      return theme.error // red
    case "skipped":
      return theme.textMuted // gray/muted
    case "manual-review":
      return theme.warning // yellow for manual review
    default:
      return theme.text // white for pending
  }
}
