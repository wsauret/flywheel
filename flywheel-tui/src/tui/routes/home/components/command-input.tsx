/** @jsxImportSource @opentui/solid */
/**
 * Command Input Component
 *
 * Wraps the shared Prompt component for the home view.
 */

import { Prompt } from "@tui/shared/components/prompt/index"

export interface CommandInputProps {
  onSubmit: (command: string) => void
  onEscape?: () => void
  disabled?: boolean
}

export function CommandInput(props: CommandInputProps) {
  return (
    <Prompt
      onSubmit={props.onSubmit}
      onEscape={props.onEscape}
      disabled={props.disabled}
      placeholder="Type a / command..."
    />
  )
}
