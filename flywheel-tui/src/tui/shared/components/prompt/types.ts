export interface PromptProps {
  onSubmit: (input: string) => void
  hint?: string
  placeholder?: string
  disabled?: boolean
  onEscape?: () => void
}
