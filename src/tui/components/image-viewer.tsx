/** @jsxImportSource @opentui/solid */

import type { UserMessageImage } from "@infra/output-blocks"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal } from "solid-js"
import { useTheme } from "@tui/context/theme.js"
import { AttachmentImage } from "./attachment-image.js"
import { Button } from "./button.js"
import { ModalFrame, MODAL_FRAME_HORIZONTAL_INSET } from "./modal-frame.js"
import type { ViewerContext } from "./modal-stack.js"

/** Opens retained image bytes in the existing viewer layer; closing never changes the message. */
export function openImageViewer(viewer: ViewerContext, image: UserMessageImage, label: string): void {
  const [zoom, setZoom] = createSignal(1)
  let scroll: ScrollBoxRenderable | undefined
  const reset = () => { setZoom(1); scroll?.scrollTo({ x: 0, y: 0 }) }
  const increase = () => setZoom((value) => Math.min(16, value * 2))
  const decrease = () => setZoom((value) => Math.max(0.25, value / 2))
  const handle = viewer.push(() => {
    const dimensions = useTerminalDimensions()
    const { theme } = useTheme()
    const width = () => Math.max(MODAL_FRAME_HORIZONTAL_INSET + 1, dimensions().width - 4)
    const height = () => Math.max(1, dimensions().height - 10)
    const imageWidth = () => Math.max(1, width() - MODAL_FRAME_HORIZONTAL_INSET - 1)
    return <ModalFrame title={label} width={width()} onClose={() => handle.close()}>
      <scrollbox ref={(node: ScrollBoxRenderable) => { scroll = node }}
        width={imageWidth()} height={height()} scrollX scrollY>
        <AttachmentImage image={image} width={imageWidth()} height={height()} zoom={zoom()} />
      </scrollbox>
      <box flexDirection="row" gap={1}>
        <Button label="-" onPress={decrease} disabled={zoom() <= 0.25} />
        <Button label="Fit" onPress={reset} />
        <Button label="+" onPress={increase} disabled={zoom() >= 16} />
        <Button label="Close" onPress={() => handle.close()} />
      </box>
      <text fg={theme.textMuted}>Arrows scroll · +/- zoom · 0 fits · Esc closes</text>
    </ModalFrame>
  }, {
    onKey: (event) => {
      switch (event.name) {
        case "escape": handle.close(); break
        case "+": case "=": increase(); break
        case "-": decrease(); break
        case "0": reset(); break
        case "up": scroll?.scrollBy({ x: 0, y: -3 }); break
        case "down": scroll?.scrollBy({ x: 0, y: 3 }); break
        case "left": scroll?.scrollBy({ x: -5, y: 0 }); break
        case "right": scroll?.scrollBy({ x: 5, y: 0 }); break
        default: return
      }
      event.preventDefault?.()
    },
  })
}
