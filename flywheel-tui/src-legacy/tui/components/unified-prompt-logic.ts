/**
 * Unified Prompt Logic — Pure functions for prompt mode resolution
 *
 * Determines which prompt behavior to use based on AppState and
 * whether an approval gate is pending.
 */

import type { AppState } from "../shell/shell-modes"

/**
 * Prompt modes:
 * - "command": slash commands + autocomplete (idle/completed)
 * - "active": user can type to steer/inject (working/chatting)
 * - "passive": reserved for future use (currently unused)
 * - "disabled": prompt not usable (reserved for future use)
 */
export type PromptMode = "command" | "active" | "passive" | "disabled"

/**
 * Resolve the prompt mode from app state and approval status.
 *
 * When working, the prompt is always "active" so the user can inject
 * messages into the running worker (mid-execution steering).
 *
 * When chatting, the prompt is "active" so the user can send messages
 * to the interactive chat agent.
 */
export function resolvePromptMode(
  appState: AppState,
  approvalPending: boolean,
): PromptMode {
  switch (appState) {
    case "idle":
    case "completed":
      return "command"
    case "chatting":
    case "working":
      return "active"
    default:
      return "command"
  }
}
