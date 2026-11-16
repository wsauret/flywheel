/** @jsxImportSource @opentui/solid */
import { StyledText, fg as stFg, type TextChunk } from "@opentui/core"
import { useBlockDisclosure } from "@tui/context/block-disclosure.js"
import { useTheme } from "@tui/context/theme"
import { useHeaderToggle } from "@tui/hooks/use-body-toggle.js"
import { bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { createMemo, Index, Show, type JSX } from "solid-js"
import { formatStartTime } from "../../protocol/client/format.js"
import { Divider } from "./system-block.js"
import type { PresentedTerminalRow, TerminalCallStretch } from "./visible-output-blocks.js"

interface CallStretchBlockProps {
  readonly block: TerminalCallStretch
  /** Renders a row of the stretch, as the transcript renders the same row on its own. */
  readonly row: (row: PresentedTerminalRow) => JSX.Element
}

/** A stretch of calls under its one muted heading (PI-LEAD-017), with its rows indented beneath while it is open. A
 *  click on the heading opens or closes it; the person's choice lives in the transcript's disclosure state under the
 *  stretch's id. */
export function CallStretchBlock(props: CallStretchBlockProps) {
  const { theme } = useTheme()
  const disclosure = useBlockDisclosure()
  const toggle = useHeaderToggle(() => true, () => { disclosure.setDisclosure(props.block.id, !props.block.open) })
  const line = createMemo(() => {
    const chunks: TextChunk[] = [stFg(theme.textMuted)(`${props.block.open ? "▾" : "▸"} ${formatStartTime(props.block.timestamp)} · ${props.block.label}`)]
    if (props.block.failed > 0) chunks.push(stFg(theme.textMuted)(" · "), stFg(theme.error)(`${props.block.failed} failed`))
    return new StyledText(chunks)
  })
  return (
    <box flexDirection="column">
      <box selectable={false} {...toggle.handlers} backgroundColor={toggle.background()}>
        <text ref={bindStyledTextContent(line)} wrapMode="none" overflow="hidden" />
      </box>
      <Show when={props.block.open}>
        <box flexDirection="column" paddingLeft={2}>
          <Index each={props.block.rows}>
            {(row, index) => (
              <>
                <Show when={props.block.boundaryBefore[index]}><Divider /></Show>
                {props.row(row())}
              </>
            )}
          </Index>
        </box>
      </Show>
    </box>
  )
}
