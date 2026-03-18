/** @jsxImportSource @opentui/solid */
/**
 * Unified Prompt Component
 *
 * Merges the home CommandInput (slash commands + autocomplete) and
 * the work PromptLine (approval/passive/disabled) into a single
 * component that delegates to the shared Prompt.
 *
 * Mode is resolved via resolvePromptMode(appState, approvalPending):
 *   - "command": Prompt with autocomplete (idle/completed)
 *   - "active": Prompt with approval-aware placeholder (working + approval)
 *   - "passive": Disabled Prompt with "Phase executing..." placeholder
 *   - "disabled": Prompt fully disabled (importing)
 */

import { Prompt } from "@tui/shared/components/prompt/index"
import { resolvePromptMode, type PromptMode } from "./unified-prompt-logic"
import type { AppState } from "./shell-modes"

export interface UnifiedPromptProps {
  appState: AppState
  approvalPending: boolean
  onCommand: (workflow: string, args: Record<string, string>) => void
  onPromptSubmit: (text: string) => void
  onEscape: () => void
  /** Available column width for the prompt (optional, for responsive sizing). */
  availableWidth?: number
}

const PLACEHOLDERS: Record<PromptMode, string> = {
  command: "Type a / command...",
  active: "Enter to continue, or type to steer...",
  passive: "Phase executing...",
  disabled: "Import in progress...",
}

export function UnifiedPrompt(props: UnifiedPromptProps) {
  const mode = () => resolvePromptMode(props.appState, props.approvalPending)

  const handleSubmit = (input: string) => {
    const currentMode = mode()

    if (currentMode === "command") {
      // In command mode, just forward the raw input — the shell handles parsing
      props.onPromptSubmit(input)
      return
    }

    if (currentMode === "active") {
      // In active mode, forward for approval handling
      props.onPromptSubmit(input)
      return
    }

    // passive/disabled: ignore
  }

  const handleEscape = () => {
    // Escape propagation is handled by the Prompt component itself:
    // - If autocomplete is open, Prompt closes it (does not bubble)
    // - If input has text, Prompt clears it (does not bubble)
    // - If input is empty and autocomplete is closed, Prompt calls onEscape
    // So we only get called when the Escape should reach the shell.
    props.onEscape()
  }

  return (
    <Prompt
      onSubmit={handleSubmit}
      onEscape={handleEscape}
      disabled={mode() === "passive" || mode() === "disabled"}
      placeholder={PLACEHOLDERS[mode()]}
    />
  )
}
