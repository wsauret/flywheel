/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { BOLD } from "@tui/utils/text-attributes"
import { createSignal, For, Show } from "solid-js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import { createTuiErrorReports } from "../modules.js"
import { Button } from "./button.js"
import type { Clipboard } from "../utils/clipboard.js"

interface ErrorComponentProps {
  error: Error
  onExit: () => void
  /** The TUI's clipboard, so the crash screen copies through the same owned
   *  commands the running shell does. */
  clipboard: Clipboard
  appService: Pick<RuntimeClient, "dispatch">
  appVersion: string
  sessionId?: string
}

export function ErrorComponent(props: ErrorComponentProps) {
  const { theme } = useTheme()
  const term = useTerminalDimensions()
  const [copied, setCopied] = createSignal(false)
  const reports = createTuiErrorReports({
    get client() { return props.appService },
    get error() { return props.error },
    get version() { return props.appVersion },
    get sessionId() { return props.sessionId },
  })

  const copyError = async () => {
    const errorText = reports.length > 0
      ? reports.map((report) => report.copyText()).join("\n\n")
      : `Flywheel Error:\n\n${props.error.stack || props.error.message}`
    await props.clipboard.copy(errorText)
    setCopied(true)
  }

  const handleExit = () => {
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[2J\x1b[H\x1b[?25h')
    }
    props.onExit()
  }

  return (
    <box flexDirection="column" gap={1} padding={2}>
      <box flexDirection="row" gap={2} alignItems="center">
        <text fg={theme.error} attributes={BOLD} flexShrink={0}>Fatal Error</text>
        <Button label={copied() ? "Copied!" : "Copy Report"} onPress={() => void copyError()} />
      </box>
      <For each={reports}>{(report) => <Show when={report.status()}>{(status) => <text fg={report.failed() ? theme.error : theme.textMuted}>{status()}</text>}</Show>}</For>
      <box flexDirection="row" gap={2}>
        <text fg={theme.textMuted} flexShrink={0}>Use Exit Now to close this crashed TUI</text>
        <Button label="Exit Now" onPress={handleExit} />
      </box>
      <box height={1} />
      <scrollbox height={Math.floor(term().height * 0.7)}>
        <text fg={theme.textMuted}>{props.error.stack || props.error.message}</text>
      </scrollbox>
    </box>
  )
}
