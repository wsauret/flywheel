/** @jsxImportSource @opentui/solid */
/**
 * Unified Prompt Component
 *
 * Merges the home CommandInput (slash commands + autocomplete) and
 * the work PromptLine (approval/passive/disabled) into a single
 * component that delegates to the shared Prompt.
 *
 * The Prompt returns { Input, Overlay }:
 *   - Input: the text input box (rendered in the prompt area)
 *   - Overlay: the autocomplete dropdown (rendered at root level by the shell)
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
import type { JSX } from "solid-js"

export interface UnifiedPromptProps {
  appState: AppState
  approvalPending: boolean
  /** Whether the sidebar currently has keyboard focus (blurs prompt input). */
  sidebarFocused?: boolean
  onCommand: (workflow: string, args: Record<string, string>) => void
  onPromptSubmit: (text: string) => void
  onEscape: () => void
  /** Available column width for the prompt (optional, for responsive sizing). */
  availableWidth?: number
  /** Number of running sessions (background or focused). When > 0 in idle, shows count in placeholder. */
  runningCount?: number
}

export interface UnifiedPromptResult {
  Input: () => JSX.Element
  Overlay: () => JSX.Element
}

const PLACEHOLDERS: Record<PromptMode, string> = {
  command: "Type a / command...",
  active: "Type to steer the worker...",
  passive: "Phase executing...",
  disabled: "Import in progress...",
}

export function useUnifiedPrompt(props: UnifiedPromptProps): UnifiedPromptResult {
  const mode = () => resolvePromptMode(props.appState, props.approvalPending)

  const handleSubmit = (input: string) => {
    const currentMode = mode()

    if (currentMode === "command") {
      props.onPromptSubmit(input)
      return
    }

    if (currentMode === "active") {
      props.onPromptSubmit(input)
      return
    }

    // passive/disabled: ignore
  }

  const handleEscape = () => {
    props.onEscape()
  }

  const isDisabled = () => mode() === "passive" || mode() === "disabled"

  const prompt = Prompt({
    onSubmit: handleSubmit,
    onEscape: handleEscape,
    get disabled() { return isDisabled() },
    get focused() { return !isDisabled() && !props.sidebarFocused },
    get placeholder() {
      const base = PLACEHOLDERS[mode()]
      if (mode() === "command" && (props.runningCount ?? 0) > 0) {
        return `${base} (${props.runningCount} running)`
      }
      return base
    },
  })

  return {
    Input: prompt.Input,
    Overlay: prompt.Overlay,
  }
}
