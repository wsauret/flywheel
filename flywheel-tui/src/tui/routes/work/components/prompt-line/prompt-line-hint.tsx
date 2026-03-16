/** @jsxImportSource @opentui/solid */
/**
 * Prompt Line Hint
 *
 * Contextual hints on the right side of the prompt line.
 */

import { Show } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"
import type { PromptLineState } from "./types"

export interface PromptLineHintProps {
  state: PromptLineState
  isInteractive: boolean
}

export function getHintText(state: PromptLineState, isInteractive: boolean): string | null {
  if (!isInteractive) return null

  if (state.mode === "active" && state.reason === "approval") {
    return "[Enter] Continue  [Type] Steer"
  }

  if (state.mode === "active" && state.reason === "paused") {
    return "[Enter] Resume"
  }

  return "[Enter] Send"
}

export function PromptLineHint(props: PromptLineHintProps) {
  const themeCtx = useTheme()

  const hint = () => getHintText(props.state, props.isInteractive)

  return (
    <Show when={hint()}>
      <text fg={themeCtx.theme.textMuted}> {hint()}</text>
    </Show>
  )
}
