/** @jsxImportSource @opentui/solid */

import { createSignal } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { createTextAttributes } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { Clipboard } from "../utils/clipboard.js"

interface ErrorComponentProps {
  error: Error
  onExit: () => void
}

export function ErrorComponent(props: ErrorComponentProps) {
  const { theme } = useTheme()
  const term = useTerminalDimensions()
  const [copied, setCopied] = createSignal(false)

  const copyError = async () => {
    const errorText = `Flywheel Error:\n\n${props.error.stack || props.error.message}`
    await Clipboard.copy(errorText)
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
        <text fg={theme.error} attributes={createTextAttributes({ bold: true })}>Fatal Error</text>
        <box onMouseUp={copyError} backgroundColor={theme.backgroundElement} padding={1}>
          <text fg={theme.text} attributes={createTextAttributes({ bold: true })}>{copied() ? "Copied!" : "Copy Error"}</text>
        </box>
      </box>
      <box flexDirection="row" gap={2}>
        <text fg={theme.textMuted}>Press Ctrl+C to exit</text>
        <box onMouseUp={handleExit} backgroundColor={theme.backgroundElement} padding={1}>
          <text fg={theme.text}>Exit Now</text>
        </box>
      </box>
      <box height={1} />
      <scrollbox height={Math.floor(term().height * 0.7)}>
        <text fg={theme.textMuted}>{props.error.stack || props.error.message}</text>
      </scrollbox>
    </box>
  )
}
