/** @jsxImportSource @opentui/solid */
// Single consumer (shell.tsx), but kept separate to avoid pushing shell.tsx past 400 lines.

import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { createTextAttributes } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import type { ToastVariant } from "@tui/shared/context/toast"
import type { RGBA } from "@opentui/core"

const VARIANT_PREFIX: Record<ToastVariant, string> = {
  info: "\u2139",
  warning: "\u26a0",
  error: "\u2717",
  success: "\u2713",
}

export function ToastDisplay(props: { headerHeight: number }) {
  const { theme } = useTheme()
  const toast = useToast()
  const dimensions = useTerminalDimensions()

  const variantColor = (): RGBA => {
    switch (toast.current?.variant) {
      case "error": return theme.error
      case "warning": return theme.warning
      case "success": return theme.success
      default: return theme.info
    }
  }

  const toastWidth = () => {
    const msg = toast.current
    if (!msg) return 0
    return msg.message.length + 6
  }

  return (
    <Show when={toast.current}>
      {(msg) => (
        <box
          position="absolute"
          left={Math.max(0, dimensions().width - toastWidth() - 2)}
          top={props.headerHeight}
          zIndex={3000}
          flexDirection="row"
          backgroundColor={theme.backgroundPanel}
          border={["left"]}
          borderColor={variantColor()}
          paddingLeft={1}
          paddingRight={1}
        >
          <text fg={variantColor()} attributes={createTextAttributes({ bold: true })}>{VARIANT_PREFIX[msg().variant]} </text>
          <text fg={theme.text}>{msg().message}</text>
        </box>
      )}
    </Show>
  )
}
