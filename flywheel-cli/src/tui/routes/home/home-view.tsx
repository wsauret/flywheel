/** @jsxImportSource @opentui/solid */
/**
 * Home View Component
 *
 * Main home screen with logo, help rows, and command prompt.
 * Accepts workflow commands and delegates to the shell.
 */

import { useToast } from "@tui/shared/context/toast"
import { Toast } from "@tui/shared/ui/toast"
import { WelcomeSection } from "./components/welcome-section"
import { CommandInput } from "./components/command-input"
import { parseHomeCommand } from "./hooks/use-home-commands"

export interface HomeViewProps {
  onCommand: (command: string, args: Record<string, string>) => void
  onEscape: () => void
}

export function HomeView(props: HomeViewProps) {
  const toast = useToast()

  const handleSubmit = (input: string) => {
    const trimmed = input.trim()
    if (!trimmed) return

    const result = parseHomeCommand(trimmed)

    if (result === null) {
      const message = trimmed.startsWith("/")
        ? `Unknown command: ${trimmed}. Try /work, /plan, /review, /ship`
        : `Commands start with /. Try /work ${trimmed}`
      toast.show({ message, variant: "error" })
      return
    }

    props.onCommand(result.workflow, result.args)
  }

  return (
    <box
      flexGrow={1}
      flexDirection="column"
      justifyContent="center"
      alignItems="center"
      gap={0}
    >
      <Toast />
      <WelcomeSection />

      {/* Prompt — centered with the rest */}
      <box marginTop={1}>
        <CommandInput onSubmit={handleSubmit} onEscape={props.onEscape} />
      </box>
    </box>
  )
}
