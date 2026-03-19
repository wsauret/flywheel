import type { BoxRenderable } from "@opentui/core"

export interface PromptProps {
  onSubmit: (input: string) => void
  hint?: string
  placeholder?: string
  disabled?: boolean
  onEscape?: () => void
}

export interface PromptOverlayState {
  visible: boolean
  anchorRef: BoxRenderable | null
}
