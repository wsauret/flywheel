/** @jsxImportSource @opentui/solid */
/**
 * Prompt Component — Always-On Input
 *
 * Pinned at the bottom of FlywheelShell.
 * Accepts text input and delegates to the shell via onSubmit.
 *
 * States:
 *   idle:      "Paste a plan path to start, or /help"
 *   working:   "Type to steer... [Esc] interrupt"
 *   completed: "Enter to run again, or paste new path"
 */

import { createSignal } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"

export interface PromptProps {
  placeholder: string
  onSubmit: (input: string) => void
  onEscape?: () => void
}

export function Prompt(props: PromptProps) {
  const themeCtx = useTheme()
  const [value, setValue] = createSignal("")

  const handleSubmit = (text: string) => {
    const trimmed = text.trim()
    setValue("")
    if (trimmed) {
      props.onSubmit(trimmed)
    }
  }

  const handleKeyDown = (evt: { name?: string; ctrl?: boolean; preventDefault?: () => void }) => {
    // Esc: if prompt is empty → delegate to onEscape; if has text → clear
    if (evt.name === "escape") {
      if (value().trim() === "") {
        props.onEscape?.()
      } else {
        setValue("")
      }
      return
    }
  }

  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {/* Separator */}
      <box height={1}>
        <text fg={themeCtx.theme.borderSubtle}>
          {"─".repeat(60)}
        </text>
      </box>

      {/* Input row */}
      <box flexDirection="row" height={1}>
        <text fg={themeCtx.theme.primary}>{"❯ "}</text>
        <input
          value={value()}
          placeholder={props.placeholder}
          placeholderColor={themeCtx.theme.textMuted}
          onInput={setValue}
          onSubmit={handleSubmit}
          onKeyDown={handleKeyDown}
          focused={true}
          flexGrow={1}
          backgroundColor={themeCtx.theme.background}
          focusedBackgroundColor={themeCtx.theme.background}
          textColor={themeCtx.theme.text}
          focusedTextColor={themeCtx.theme.text}
          cursorColor={themeCtx.theme.primary}
        />
      </box>
    </box>
  )
}
