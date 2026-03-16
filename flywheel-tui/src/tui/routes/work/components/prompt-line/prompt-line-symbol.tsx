/** @jsxImportSource @opentui/solid */
/**
 * Prompt Line Symbol
 *
 * Renders the prompt symbol (❯, ||, ·) with appropriate color.
 */

import { useTheme } from "@tui/shared/context/theme"
import type { PromptLineState } from "./types"

export interface PromptLineSymbolProps {
  state: PromptLineState
}

export function getPromptSymbol(state: PromptLineState): string {
  if (state.mode === "disabled") return "·"
  if (state.mode === "active" && state.reason === "paused") return "||"
  if (state.mode === "active" && state.reason === "approval") return "?"
  return "❯"
}

export function PromptLineSymbol(props: PromptLineSymbolProps) {
  const themeCtx = useTheme()

  const symbol = () => getPromptSymbol(props.state)

  const color = () => {
    if (props.state.mode === "disabled") return themeCtx.theme.textMuted
    if (props.state.mode === "active" && props.state.reason === "paused")
      return themeCtx.theme.warning
    if (props.state.mode === "active" && props.state.reason === "approval")
      return themeCtx.theme.warning
    return themeCtx.theme.primary
  }

  return <text fg={color()}>{symbol()} </text>
}
