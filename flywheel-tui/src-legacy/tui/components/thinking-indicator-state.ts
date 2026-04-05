import type { AppState } from "../shell/shell-modes"
import type { ModelActivity } from "../adapters/structured-output-builder"

export interface ThinkingIndicatorState {
  appState: AppState
  approvalPending: boolean
  hasPendingQuestion: boolean
  isInterrupted: boolean
  modelActivity?: ModelActivity
}

export function shouldShowThinkingIndicator(state: ThinkingIndicatorState): boolean {
  if (state.appState !== "working" && state.appState !== "chatting") return false
  if (state.approvalPending) return false
  if (state.hasPendingQuestion) return false
  if (state.isInterrupted) return false

  // When model activity is tracked, only show when actually thinking or idle
  // (idle = waiting for API response, which looks like thinking to the user).
  // Hide when generating text (text is already streaming on screen) or
  // executing tools (tool blocks are visible).
  if (state.modelActivity === "generating") return false
  if (state.modelActivity === "tool_executing") return false

  return true
}
