/** @jsxImportSource @opentui/solid */

import { RGBA, StyledText, bg as stBg, fg as stFg } from "@opentui/core"
import type { TextRenderable } from "@opentui/core"
import { createEffect, createMemo, For } from "solid-js"
import { qrCodeRows } from "../../infra/qr-code.js"

/** A QR code as terminal text, two module rows per text row through the
 *  half-block glyphs, with a one-module quiet zone.
 *
 *  The colours are deliberately not the theme's. A camera decodes a QR code by
 *  contrast, and a theme is free to put a dim foreground on a dark ground; the
 *  code is the one place the TUI paints true black on true white. */

const WHITE = RGBA.fromInts(255, 255, 255)
const BLACK = RGBA.fromInts(0, 0, 0)

export function QrCode(props: { readonly text: string }) {
  const rows = createMemo(() => qrCodeRows(props.text))
  return (
    <box flexDirection="column" flexShrink={0}>
      <For each={rows()}>{(row) => (
        <text ref={(element: TextRenderable) => { createEffect(() => { element.content = new StyledText([stBg(WHITE)(stFg(BLACK)(row))]) }) }} wrapMode="none" />
      )}</For>
    </box>
  )
}
