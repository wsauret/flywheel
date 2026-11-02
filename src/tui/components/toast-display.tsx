/** @jsxImportSource @opentui/solid */
// Single consumer (shell.tsx), but kept separate to avoid pushing shell.tsx past 400 lines.

import { BoxRenderable, StyledText, bold as stBold, fg as stFg, type RGBA, type TextChunk, type TextRenderable } from "@opentui/core"
import { Portal, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { OpaqueBox } from "@tui/components/opaque-box"
import { useToast } from "@tui/context/toast"
import { createEffect, createMemo, Show } from "solid-js"
import { computeToastLayout } from "./toast-layout.js"

interface ToastVariantPrefixes {
  info: string
  warning: string
  error: string
  success: string
}

const VARIANT_PREFIX: ToastVariantPrefixes = {
  info: "i",
  warning: "!",
  error: "x",
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

  const toastLayout = () => {
    const msg = toast.current
    return computeToastLayout(dimensions().width, msg?.message.length ?? 0)
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

  // zIndex sorts siblings within one parent, and the modal layer (zIndex
  // 3000) is a sibling of the entire shell subtree. A toast rendered inside
  // the shell can never paint above an open modal. The Portal mounts at the
  // renderer root, where 4000 out-stacks the modal layer.
  return (
    <Show when={toast.current}>
      <Portal
        ref={(el) => {
          // Portal wraps its children in a plain flex box: in the root's
          // column flow that wrapper lands below the full-height app box
          // (off-screen), and the toast's absolute coords resolve against
          // it. Hoist the wrapper out of the flow - the same bare absolute
          // wrapper the modal layer uses (modal.tsx) - so the inner box
          // positions against the viewport.
          if (el instanceof BoxRenderable) {
            el.position = "absolute"
            el.zIndex = 4000
          }
        }}
      >
        <OpaqueBox
          position="absolute"
          left={toastLayout().left}
          top={props.headerHeight + 1}
          width={toastLayout().width}
          zIndex={4000}
          border={["top", "bottom", "left", "right"]}
          borderColor={variantColor()}
          paddingLeft={1}
          paddingRight={1}
        >
          <text
            ref={(el: TextRenderable) => {
              createEffect(() => { el.content = toastContent() })
            }}
            width={toastLayout().textWidth}
            overflow="visible"
            wrapMode="word"
          />
        </OpaqueBox>
      </Portal>
    </Show>
  )
}
