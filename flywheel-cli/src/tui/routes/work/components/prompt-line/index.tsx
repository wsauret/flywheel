/** @jsxImportSource @opentui/solid */
/**
 * Prompt Line Component
 *
 * Always-present command input at the bottom of the output window.
 * Adapted from CodeMachine for Flywheel's phase-centric model.
 *
 * States:
 * - disabled: Workflow not running / completed (grayed out)
 * - passive: Phase executing, user can see but not type
 * - active: Approval gate pending — user can type to steer or Enter to continue
 */

import { createSignal, Show } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"

import type { PromptLineProps, PromptLineState } from "./types"
import { PromptLineHint } from "./prompt-line-hint"
import { PromptLineSymbol } from "./prompt-line-symbol"
import { useTypingEffect } from "./use-typing-effect"

// Re-export types
export type { PromptLineProps, PromptLineState }

const PLACEHOLDER = "Enter to continue or type prompt..."

export function PromptLine(props: PromptLineProps) {
  const themeCtx = useTheme()
  const [input, setInput] = createSignal("")

  const isInteractive = () => props.state.mode === "active"

  // Typing effect for placeholder animation
  const typingText = useTypingEffect({
    text: PLACEHOLDER,
    isActive: () => props.isFocused && isInteractive() && input() === "",
  })

  const getPlaceholder = () => {
    if (props.state.mode === "disabled") return "Workflow idle"
    if (props.state.mode === "passive") return "Phase executing..."
    if (props.state.mode === "active") {
      if (props.state.reason === "approval") return "Type to steer or Enter to continue"
      if (props.state.reason === "paused") return "Type to steer or Enter to resume"
      return "Type to steer..."
    }
    return ""
  }

  const handleSubmit = () => {
    const value = input().trim()
    setInput("")
    props.onSubmit(value)
  }

  const handleKeyDown = (evt: { name?: string; ctrl?: boolean; preventDefault?: () => void }) => {
    if (evt.name === "return") {
      handleSubmit()
      return
    }

    // Left arrow at start — exit focus back to timeline
    if (evt.name === "left" && input() === "") {
      evt.preventDefault?.()
      props.onFocusExit()
      return
    }
  }

  const showInput = () => props.isFocused

  return (
    <box flexDirection="column" flexShrink={0} paddingLeft={1} paddingRight={1}>
      {/* Separator line */}
      <box height={1}>
        <text fg={themeCtx.theme.borderSubtle}>
          {"─".repeat(60)}
        </text>
      </box>

      {/* Prompt line */}
      <box flexDirection="row" height={1} justifyContent="space-between">
        <box flexDirection="row" flexGrow={1}>
          {/* Prompt symbol */}
          <PromptLineSymbol state={props.state} />

          {/* Placeholder text (when not focused) */}
          <Show when={!showInput()}>
            <text fg={themeCtx.theme.textMuted}>{getPlaceholder()}</text>
          </Show>

          {/* Input (always shown when focused to maintain stable focus) */}
          <Show when={showInput()}>
            <input
              value={input()}
              placeholder={isInteractive() ? typingText() : getPlaceholder()}
              placeholderColor={themeCtx.theme.textMuted}
              onInput={isInteractive() ? setInput : () => {}}
              onKeyDown={isInteractive() ? handleKeyDown : () => {}}
              focused={true}
              flexGrow={1}
              backgroundColor={themeCtx.theme.background}
              focusedBackgroundColor={themeCtx.theme.background}
              textColor={themeCtx.theme.text}
              focusedTextColor={themeCtx.theme.text}
              cursorColor={isInteractive() ? themeCtx.theme.primary : themeCtx.theme.textMuted}
            />
          </Show>
        </box>

        {/* Hint */}
        <PromptLineHint state={props.state} isInteractive={isInteractive()} />
      </box>
    </box>
  )
}
