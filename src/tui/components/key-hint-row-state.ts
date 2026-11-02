import type { SessionLifecycleState } from "../../orchestration/session/types.js"
import type { AgentState } from "../hooks/shell-state.js"

export interface KeyHintSpec {
  key: string
  label: string
  separatorStyle?: "border"
}

const MUTED_HINT_SEPARATOR = " · "
const TAB_SWITCH_HINT_SEPARATOR = " ── "

function usesBorderSeparator(hint: KeyHintSpec): boolean {
  return hint.separatorStyle === "border"
}

export function keyHintSeparatorBefore(hints: readonly KeyHintSpec[], index: number): string | null {
  if (index <= 0 || index >= hints.length) return null
  const previous = hints[index - 1]
  const current = hints[index]
  if (!previous || !current) return null
  return usesBorderSeparator(previous) || usesBorderSeparator(current) ? TAB_SWITCH_HINT_SEPARATOR : MUTED_HINT_SEPARATOR
}

export function keyHintPlainText(hints: readonly KeyHintSpec[]): string {
  let text = ""
  for (const [index, hint] of hints.entries()) {
    text += keyHintSeparatorBefore(hints, index) ?? ""
    text += `${hint.key} ${hint.label}`
  }
  return text
}


interface PrimaryKeyHintState {
  hasPendingQuestion: boolean
  agentState: AgentState
  sessionState: SessionLifecycleState | null
}

export function primaryKeyHints(state: PrimaryKeyHintState): readonly KeyHintSpec[] {
  if (state.hasPendingQuestion) {
    return [{ key: "esc", label: "cancel" }]
  }
  if (state.agentState === "active") return []
  if (state.sessionState === "inactive") {
    return [{ key: "esc", label: "dismiss" }]
  }
  return []
}

export function shouldShowGlobalHints(state: Pick<PrimaryKeyHintState, "hasPendingQuestion">): boolean {
  return !state.hasPendingQuestion
}

export function sessionCountLabel(count: number): string {
  return count > 0 ? `${count} session${count === 1 ? "" : "s"}` : "sessions"
}
