/** @jsxImportSource @opentui/solid */
// Single consumer (shell.tsx), but kept separate to avoid pushing shell.tsx past 400 lines.

import { StyledText, fg as stFg, bold as stBold, type TextChunk, type TextRenderable } from "@opentui/core"
import { Show, createMemo, createEffect } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
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
    const maxWidth = Math.floor(dimensions().width * 0.6)
    return Math.min(msg.message.length + 6, maxWidth)
  }

  const toastContent = createMemo(() => {
    const msg = toast.current
    if (!msg) return new StyledText([])

    const chunks: TextChunk[] = [
      stBold(stFg(variantColor())(VARIANT_PREFIX[msg.variant])),
      stFg(theme.text)(" "),
      stFg(theme.text)(msg.message),
    ]
    return new StyledText(chunks)
  })

  return (
    <Show when={toast.current}>
      <box
        position="absolute"
        left={Math.max(0, dimensions().width - toastWidth() - 2)}
        top={props.headerHeight + 1}
        zIndex={3000}
        backgroundColor={theme.backgroundPanel}
        border={["top", "bottom", "left", "right"]}
        borderColor={variantColor()}
        paddingLeft={1}
        paddingRight={1}
      >
        <text
          ref={(el: TextRenderable) => {
            createEffect(() => { el.content = toastContent() })
          }}
          overflow="hidden"
          wrapMode="none"
        />
      </box>
    </Show>
  )
}
