import type { AppState } from "../shell/shell-modes"

export interface ThinkingIndicatorState {
  appState: AppState
  approvalPending: boolean
  hasPendingQuestion: boolean
  isInterrupted: boolean
}

export function shouldShowThinkingIndicator(state: ThinkingIndicatorState): boolean {
  if (state.appState !== "working") return false
  if (state.approvalPending) return false
  if (state.hasPendingQuestion) return false
  if (state.isInterrupted) return false
  return true
}
