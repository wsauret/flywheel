/** @jsxImportSource @opentui/solid */
import { StyledText, fg as stFg, type TextChunk } from "@opentui/core"
import { useBlockDisclosure } from "@tui/context/block-disclosure.js"
import { useTheme } from "@tui/context/theme"
import { useHeaderToggle } from "@tui/hooks/use-body-toggle.js"
import { bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { createMemo, Index, Show, type JSX } from "solid-js"
import { formatStartTime } from "../../protocol/client/format.js"
import { Divider } from "./system-block.js"
import type { PresentedTerminalRow, TerminalTurnFold } from "./visible-output-blocks.js"

interface TurnFoldBlockProps {
  readonly block: TerminalTurnFold
  /** Renders a row that the fold holds, as the transcript renders the same row on its own. */
  readonly row: (row: PresentedTerminalRow) => JSX.Element
}

/** A finished turn's one muted line (PI-INTERACTION-053), then the rows it holds. A click on the line opens or closes
 *  the fold; the person's choice lives in the transcript's disclosure state under the fold's id. */
export function TurnFoldBlock(props: TurnFoldBlockProps) {
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
      <Index each={props.block.rows}>
        {(row, index) => (
          <>
            <Show when={props.block.boundaryBefore[index]}><Divider /></Show>
            {props.row(row())}
          </>
        )}
      </Index>
    </box>
  )
}
