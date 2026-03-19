import type { BoxRenderable } from "@opentui/core"

export interface PromptProps {
  onSubmit: (input: string) => void
  hint?: string
  placeholder?: string
  disabled?: boolean
  /** Override input focus state. When false, input is blurred even if not disabled. */
  focused?: boolean
  onEscape?: () => void
}

export interface PromptOverlayState {
  visible: boolean
  anchorRef: BoxRenderable | null
}
