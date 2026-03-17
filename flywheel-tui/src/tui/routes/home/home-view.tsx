/** @jsxImportSource @opentui/solid */
/**
 * Launcher View Component (formerly HomeView)
 *
 * Main launcher screen with logo, help rows, and command prompt.
 * Accepts workflow commands and delegates to the shell.
 *
 * Shown in "launcher" and "completed" view modes. In "completed" mode,
 * the same interface is used — the shell routes back here via ViewMode.
 */

import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useToast } from "@tui/shared/context/toast"
import { useSession } from "@tui/shared/context/session"
import { Toast } from "@tui/shared/ui/toast"
import { SessionSidebar } from "../../components/session-sidebar"
import { WelcomeSection } from "./components/welcome-section"
import { CommandInput } from "./components/command-input"
import { parseHomeCommand } from "./hooks/use-home-commands"

export interface LauncherViewProps {
  onCommand: (command: string, args: Record<string, string>) => void
  onEscape: () => void
}

/** @deprecated Use LauncherViewProps */
export type HomeViewProps = LauncherViewProps

export function LauncherView(props: LauncherViewProps) {
  const toast = useToast()
  const sessionCtx = useSession()
  const dimensions = useTerminalDimensions()

  const handleSubmit = (input: string) => {
    const trimmed = input.trim()
    if (!trimmed) return

    const result = parseHomeCommand(trimmed)

    if (result === null) {
      // If it doesn't start with / and looks like a file path, treat as /work <path>
      if (!trimmed.startsWith("/") && (trimmed.includes(".") || trimmed.includes("/"))) {
        props.onCommand("work", { planPath: trimmed })
        return
      }
      const message = trimmed.startsWith("/")
        ? `Unknown command: ${trimmed}. Try /work, /plan, /review, /ship`
        : `Commands start with /. Try /work ${trimmed}`
      toast.show({ message, variant: "error" })
      return
    }

    props.onCommand(result.workflow, result.args)
  }

  return (
    <box flexGrow={1} flexDirection="row">
      <Toast />
      {/* Left sidebar — shown when sessions exist and terminal is wide enough */}
      <Show when={sessionCtx.sessions().length > 0}>
        <SessionSidebar
          sessions={sessionCtx.sessions()}
          terminalWidth={dimensions()?.width}
        />
      </Show>

      {/* Center content — welcome + prompt */}
      <box
        flexGrow={1}
        flexDirection="column"
        justifyContent="center"
        alignItems="center"
        gap={0}
      >
        <WelcomeSection />

        {/* Prompt — centered with the rest */}
        <box marginTop={1}>
          <CommandInput onSubmit={handleSubmit} onEscape={props.onEscape} />
        </box>
      </box>
    </box>
  )
}

/** @deprecated Use LauncherView */
export const HomeView = LauncherView
