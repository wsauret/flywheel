/**
 * Prompt Line Types
 *
 * Adapted from CodeMachine for Flywheel's phase-centric model.
 * No chaining — Flywheel uses approval gates instead.
 *
 * States:
 * - disabled: Workflow not running or completed (grayed out)
 * - passive: Phase executing, user can see but not type
 * - active: Approval gate pending — user can type to steer or Enter to continue
 */

export type PromptLineState =
  | { mode: "disabled" }
  | { mode: "passive" }
  | { mode: "active"; reason?: "approval" | "paused" }

export interface PromptLineProps {
  state: PromptLineState
  isFocused: boolean
  onSubmit: (prompt: string) => void
  onFocusExit: () => void
}
