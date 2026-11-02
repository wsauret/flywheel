/** @jsxImportSource @opentui/solid */

import type { BoxRenderable, RGBA } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { onCleanup, Show } from "solid-js"
import type { ContextGaugeCopy } from "../../protocol/client/context-compaction.js"
import { useTheme } from "../context/theme.js"
import { useModal } from "./modal.js"
import type { ModalHandle } from "./modal-stack.js"
import { ModalFrame } from "./modal-frame.js"
import { Button } from "./button.js"
import { ChromeControl } from "./chrome-control.js"

/** Header context reading. Opening details never dispatches compaction. */
export function ContextControl(props: {
  label: string
  color: RGBA
  copy: ContextGaugeCopy | null
  compacting: boolean
  onCompact: () => Promise<boolean>
  overlayLeft?: number
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const modal = useModal()
  let anchor: BoxRenderable | undefined
  let handle: ModalHandle | undefined
  const width = () => Math.min(56, dimensions().width - 2)
  const compact = () => {
    if (props.compacting) return
    handle?.close()
    void props.onCompact()
  }
  const open = () => {
    const target = anchor
    if (!props.copy || !target) return
    handle = modal.replace(() => (
      <ModalFrame title="Context" width={width()} onClose={() => handle?.close()}>
        <Show when={props.copy}>{(copy) => <>
          <text fg={theme.text}>{copy().reading}</text>
          <text fg={theme.textMuted}>{copy().detail}</text>
        </>}</Show>
        <Show when={!props.compacting} fallback={<text fg={theme.textMuted}>Compacting…</text>}>
          <Button label="Compact now" hotkey="enter" onPress={compact} />
        </Show>
      </ModalFrame>
    ), {
      anchor: () => ({ left: Math.max(0, Math.min(target.x, dimensions().width - width() - 1)), top: target.y + 1 }),
      onKey: (event) => {
        if (event.name === "escape") handle?.close()
        else if (event.name === "return") compact()
        event.preventDefault?.()
      },
    })
  }
  onCleanup(() => handle?.close())
  return (
    <ChromeControl ref={(element: BoxRenderable) => { anchor = element }} enabled={Boolean(props.copy)} hoverColor={theme.backgroundRaised} onPress={open}
      position={props.overlayLeft === undefined ? "relative" : "absolute"} left={props.overlayLeft}>
      <text selectable={false} fg={props.color} wrapMode="none">{props.label}</text>
    </ChromeControl>
  )
}
