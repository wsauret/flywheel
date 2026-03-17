/**
 * Prompt Placeholders — State-to-placeholder mapping
 *
 * Pure function that maps a SessionLifecycleState (or null for default)
 * to the appropriate placeholder text for the command prompt.
 */

import type { SessionLifecycleState } from "../../session/state-machine"

const PLACEHOLDERS: Record<string, string> = {
  "plan:draft":     "Describe what you want to build",
  "plan:imported":  "Review the plan, then press Enter to approve",
  "plan:approved":  "Plan approved — starting work...",
  "plan:needs-fix": "Refine this plan, or paste a new one",
  "work:active":    "Press Enter to continue, or type to steer",
  "work:paused":    "Session paused — press Enter to resume",
  "work:review":    "Review the output, then approve or request changes",
  "completed":      "Enter to run again, or paste new path",
  "archived":       "Session archived — start a new one with /new",
  "trashed":        "Session trashed — start a new one with /new",
}

const DEFAULT_PLACEHOLDER = "Paste a plan path to start, or /help"

/**
 * Get the appropriate prompt placeholder for the given session lifecycle state.
 *
 * Returns a sensible default for `null` (no active session) or states
 * without a specific placeholder (e.g., `"new"`).
 */
export function getPlaceholderForState(
  state: SessionLifecycleState | null,
): string {
  if (state === null) return DEFAULT_PLACEHOLDER
  return PLACEHOLDERS[state] ?? DEFAULT_PLACEHOLDER
}
