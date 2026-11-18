/** @jsxImportSource @opentui/solid */

import type { MouseEvent } from "@opentui/core"
import { useRowWidth } from "@tui/context/row-width.js"
import { useTheme } from "@tui/context/theme"
import type { FindBar as FindBarModel } from "../hooks/create-find-bar.js"
import { useHoverHighlight } from "../hooks/use-hover-highlight.js"
import { BOLD } from "../utils/text-attributes.js"
import { Button } from "./button.js"
import { ControlledTextField } from "./controlled-text-field.js"
import { OpaqueBox } from "./opaque-box.js"

const FIELD_WIDTH = 24
const MIN_FIELD_WIDTH = 4
/** The widest status: "bad pattern", wider than "1000/1000+". */
const STATUS_WIDTH = 11
/** The columns of the bar besides its field: border and padding 4, four gaps,
 *  two toggles of 2, the status, and three buttons of 3. */
const BAR_CHROME = 4 + 4 + 4 + STATUS_WIDTH + 9
/** The bar's offset from the right edge of the transcript, plus one column so
 *  it never touches the left edge. */
const BAR_INSET = 3
/** The columns of the transcript box outside a transcript row: its left
 *  padding and the scroll bar. */
const ROW_FRAME = 2

/** The find bar over the top right of the transcript: the Find field, the
 *  regular expression and match case toggles, the match counter, and next,
 *  previous, and close. Every key it takes reaches it through the model. In
 *  a narrow transcript the field gives up its width first and then the bar
 *  its right offset, so the bar keeps inside a transcript of 36 columns or
 *  more and keeps one width while the status changes. */
export function FindBar(props: { readonly bar: FindBarModel }) {
  const { theme } = useTheme()
  const rowWidth = useRowWidth().width
  const fieldWidth = () => rowWidth() === 0 ? FIELD_WIDTH : Math.max(MIN_FIELD_WIDTH, Math.min(FIELD_WIDTH, rowWidth() - BAR_INSET - BAR_CHROME))
  const right = () => rowWidth() === 0 ? 2 : Math.max(0, Math.min(2, rowWidth() + ROW_FRAME - BAR_CHROME - fieldWidth()))
  const canMove = () => props.bar.matchCount() > 0
  return <OpaqueBox position="absolute" top={0} right={right()} zIndex={10} border borderStyle="rounded" borderColor={props.bar.focused() ? theme.primary : theme.border}
    interiorColor={theme.backgroundElement} flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} selectable={false}
    // A press on a control has acted by now; one that closed the bar leaves the keys with the prompt.
    onMouseDown={(event: MouseEvent) => { event.stopPropagation(); if (props.bar.isOpen()) props.bar.focus() }}>
    <ControlledTextField presentation={props.bar.presentation()} focused={props.bar.focused()} placeholder="Find" width={fieldWidth()}
      textColor={theme.text} placeholderColor={theme.textMuted} selectionForeground={theme.selectionForeground} selectionBackground={theme.selectionBackground} />
    <Toggle label=".*" on={props.bar.regex()} onPress={props.bar.toggleRegex} />
    <Toggle label="Aa" on={props.bar.matchCase()} onPress={props.bar.toggleMatchCase} />
    <text selectable={false} fg={props.bar.status() === "bad pattern" ? theme.warning : theme.textMuted} wrapMode="none">{props.bar.status().padStart(STATUS_WIDTH)}</text>
    <box flexDirection="row">
      <Button label="↓" onPress={props.bar.next} disabled={!canMove()} />
      <Button label="↑" onPress={props.bar.previous} disabled={!canMove()} />
      <Button label="✕" onPress={props.bar.close} />
    </box>
  </OpaqueBox>
}

function Toggle(props: { readonly label: string; readonly on: boolean; readonly onPress: () => void }) {
  const { theme } = useTheme()
  const hover = useHoverHighlight()
  return <box {...hover.handlers} onMouseDown={() => props.onPress()} backgroundColor={props.on ? theme.primary : undefined}>
    <text selectable={false} fg={props.on ? theme.background : hover.hovered() ? theme.text : theme.textMuted} attributes={props.on ? BOLD : undefined}>{props.label}</text>
  </box>
}
