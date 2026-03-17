/** @jsxImportSource @opentui/solid */
/**
 * Help Overlay
 *
 * Modal that displays available commands and keyboard shortcuts.
 * Dismisses on any keypress.
 */

import { useKeyboard } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { ModalBase, ModalHeader, ModalFooter } from "@tui/shared/components/modal"

export interface HelpOverlayProps {
  onClose: () => void
}

export function HelpOverlay(props: HelpOverlayProps) {
  const themeCtx = useTheme()

  useKeyboard((evt) => {
    evt.preventDefault()
    props.onClose()
  })

  return (
    <ModalBase width={54}>
      <ModalHeader title="Help" icon="?" iconColor={themeCtx.theme.primary} />

      <box flexDirection="column" paddingTop={1} paddingBottom={1}>
        <text fg={themeCtx.theme.primary} attributes={1}>Commands</text>
        <text fg={themeCtx.theme.text}>  /help       Show this help</text>
        <text fg={themeCtx.theme.text}>  /new        Return to idle screen</text>
        <text fg={themeCtx.theme.text}>  /stop       Stop running workflow</text>
        <text fg={themeCtx.theme.text}>  /exit       Exit flywheel</text>
      </box>

      <box flexDirection="column" paddingBottom={1}>
        <text fg={themeCtx.theme.primary} attributes={1}>Idle</text>
        <text fg={themeCtx.theme.text}>  Esc         Clear input / exit</text>
        <text fg={themeCtx.theme.text}>  Enter       Start workflow with plan path</text>
      </box>

      <box flexDirection="column" paddingBottom={1}>
        <text fg={themeCtx.theme.primary} attributes={1}>Working</text>
        <text fg={themeCtx.theme.text}>  Esc         Stop workflow (press twice)</text>
        <text fg={themeCtx.theme.text}>  Ctrl+S      Skip current phase</text>
        <text fg={themeCtx.theme.text}>  Ctrl+D      Toggle raw output</text>
        <text fg={themeCtx.theme.text}>  Ctrl+T      Toggle theme</text>
        <text fg={themeCtx.theme.text}>  Up/Down     Navigate phases</text>
      </box>

      <ModalFooter shortcuts="Press any key to close" />
    </ModalBase>
  )
}
