/**
 * Unified Prompt Logic — Pure functions for prompt mode resolution
 *
 * Determines which prompt behavior to use based on AppState and
 * whether an approval gate is pending.
 */

import type { AppState } from "./shell-modes"

/**
 * Prompt modes:
 * - "command": slash commands + autocomplete (idle/completed)
 * - "active": approval-aware, user can type to steer (working + approval pending)
 * - "passive": read-only, phase is executing (working, no approval)
 * - "disabled": prompt not usable (importing)
 */
export type PromptMode = "command" | "active" | "passive" | "disabled"

/**
 * Resolve the prompt mode from app state and approval status.
 */
export function resolvePromptMode(
  appState: AppState,
  approvalPending: boolean,
): PromptMode {
  switch (appState) {
    case "idle":
    case "completed":
      return "command"
    case "working":
      return approvalPending ? "active" : "passive"
    case "importing":
      return "disabled"
  }
}
