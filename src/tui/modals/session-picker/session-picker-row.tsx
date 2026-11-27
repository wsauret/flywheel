/** @jsxImportSource @opentui/solid */

import { StyledText, bold as stBold, fg as stFg, type TextChunk, type TextRenderable } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/tui-theme"
import { chunksWidth, displayWidth, fitChunks, truncateToWidth } from "@tui/terminal/text.js"
import { createEffect, createMemo, For, type JSX } from "solid-js"
import { snippetParts } from "../../../protocol/client/chat/search/search-snippet.js"
import { formatCompactTimeAgo, pickerRowLastActive, pickerRowLines, buildDiffStatChunks, stopDetail } from "./picker-helpers.js"
import { MARK_GLYPHS, markColor, type ChatMark } from "../../components/notices/chat-marks.js"
import type { PickerCorruptRow, PickerFoundRow, PickerSessionRow, SelectablePickerRow } from "./picker-types.js"

const TITLE_ELLIPSIS = "…"
/** Indents a row's details under its title, past the cursor and the status dot. */
const DETAIL_INDENT = "    "

interface BuildSessionRowChunksInput {
  row: SelectablePickerRow
  theme: TuiTheme
  rowWidth: number
  selected: boolean
  foregroundId?: string
  isWorking: boolean
  /** What the chat holds for the person. The row carries the mark that its
   *  tab carries (PI-INTERACTION-184). */
  mark?: ChatMark
  blinkOn: boolean
  now: number
  timeAgoWidth: number
  confirmDeleteSessionId?: string
}

interface SessionPickerRowProps extends BuildSessionRowChunksInput {
  rowIndex: number
  onRowClick: (rowIndex: number) => void
}

/** The styled lines of one row: one for a session, for a chat found by its
 *  messages also the matching words and where it stands, and for a chat that
 *  stopped unread also what it stopped with. */
function buildSessionRowLines(input: BuildSessionRowChunksInput): TextChunk[][] {
  const width = Math.max(0, input.rowWidth)
  if (width === 0) return []
  const fit = (chunks: readonly TextChunk[]) => fitChunks(padChunks(chunks, input.theme, width), width)
  if (input.row.kind === "found") return [fit(sessionRowChunks(input, input.row)), ...foundDetailLines(input, input.row).map(fit)]
  const first = fit(input.row.kind === "corrupt" ? corruptRowChunks(input, input.row) : sessionRowChunks(input, input.row))
  const stopped = input.row.kind === "session" ? input.row.stopped : undefined
  const detail = stopped ? stopDetail(stopped) : undefined
  const lines = !stopped || detail === undefined ? [first] : [first, fit([
    stFg(input.theme.textMuted)(DETAIL_INDENT),
    stFg(stopped.ending.kind === "completed" ? input.theme.textMuted : input.theme.error)(detail),
  ])]
  // A row that waits on its delete confirmation is painted in the error
  // colour, so every line of it takes the background colour to stay legible.
  return isConfirming(input) ? lines.map((line) => line.map((chunk) => ({ ...chunk, fg: input.theme.background }))) : lines
}

function isConfirming(input: BuildSessionRowChunksInput): boolean {
  const id = input.row.kind === "corrupt" ? input.row.sessionId : input.row.session.id
  return input.confirmDeleteSessionId === id
}

/** The cursor and, in the column after it, the unread mark. The mark keeps
 *  one column on every row, next to the status dot, so it lines up down the
 *  list and the working dot stays: the row still says that its agent works
 *  (PI-INTERACTION-188). */
function rowPrefix(input: BuildSessionRowChunksInput): TextChunk[] {
  const cursor = (text: string) => input.selected ? stFg(input.theme.primary)(text) : stFg(input.theme.textMuted)(text)
  if (input.mark !== "unread") return [cursor(input.selected ? "> " : "  ")]
  return [cursor(input.selected ? ">" : " "), stFg(markColor(input.theme, "unread"))(MARK_GLYPHS.unread)]
}

export function SessionPickerRow(props: SessionPickerRowProps): JSX.Element {
  const lines = createMemo(() => buildSessionRowLines(props))
  const backgroundColor = createMemo(() => {
    if (isConfirming(props)) return props.theme.error
    return props.selected ? props.theme.backgroundElement : undefined
  })

  // The row always takes the lines its kind states, so the list can place
  // rows by line before they render.
  return (
    <box selectable={false} width={props.rowWidth} height={pickerRowLines(props.row)} flexDirection="column" backgroundColor={backgroundColor()} onMouseDown={() => props.onRowClick(props.rowIndex)}>
      <For each={Array.from({ length: pickerRowLines(props.row) }, (_, line) => line)}>
        {(line) => <text ref={(el: TextRenderable) => { createEffect(() => { el.content = new StyledText(lines()[line] ?? []) }) }} overflow="hidden" wrapMode="none" />}
      </For>
    </box>
  )
}

function sessionRowChunks(input: BuildSessionRowChunksInput, row: PickerSessionRow | PickerFoundRow): TextChunk[] {
  const { theme } = input
  const { session } = row
  const title = isConfirming(input) ? "Press ctrl+d again to confirm" : session.title || session.shortTitle || session.id
  const leftChunks: TextChunk[] = rowPrefix(input)

  if (session.id === input.foregroundId) leftChunks.push(stFg(theme.success)("(current) "))
  if (input.mark !== undefined && input.mark !== "unread") leftChunks.push(stFg(markColor(theme, input.mark))(`${MARK_GLYPHS[input.mark]} `))
  else if (input.isWorking) leftChunks.push(stBold(stFg(input.blinkOn ? theme.success : theme.textMuted)("● ")))
  else if (session.lifecycleState === "active") leftChunks.push(stFg(theme.success)("● "))
  else leftChunks.push(stFg(theme.textMuted)("○ "))

  const rightChunks = sessionRightChunks(input, row)
  const titleWidth = Math.max(0, input.rowWidth - chunksWidth(leftChunks) - chunksWidth(rightChunks))
  const titleColor = input.selected ? theme.selectedListItemText : theme.text
  return [...leftChunks, stFg(titleColor)(titleToWidth(title, titleWidth)), ...rightChunks]
}

function sessionRightChunks(input: BuildSessionRowChunksInput, row: PickerSessionRow | PickerFoundRow): TextChunk[] {
  const { theme } = input
  const { session } = row
  const timeLabel = formatCompactTimeAgo(input.now, pickerRowLastActive(row)).padStart(input.timeAgoWidth)
  const diffChunks = session.totalsLoading ? [] : buildDiffStatChunks(session.diffStats, {
    success: theme.success,
    warning: theme.warning,
    error: theme.error,
    muted: theme.textMuted,
  })

  return [
    stFg(theme.textMuted)("  "),
    ...diffChunks,
    stFg(theme.textMuted)("  "),
    stFg(theme.textMuted)(timeLabel),
  ]
}


/** The matching words, with the matches marked, and then where the chat stands. */
function foundDetailLines(input: BuildSessionRowChunksInput, row: PickerFoundRow): TextChunk[][] {
  const { theme } = input
  const snippet = snippetParts(row.found.snippet.replace(/\s+/g, " ")).map((part) => part.match ? stBold(stFg(theme.accent)(part.text)) : stFg(theme.textMuted)(part.text))
  const lines = [[stFg(theme.textMuted)(DETAIL_INDENT), ...snippet]]
  if (row.found.excerpt) lines.push([stFg(theme.textMuted)(DETAIL_INDENT), stFg(theme.textMuted)(row.found.excerpt.text)])
  return lines
}

function corruptRowChunks(input: BuildSessionRowChunksInput, row: PickerCorruptRow): TextChunk[] {
  const { theme } = input
  const title = isConfirming(input) ? "Press ctrl+d again to confirm" : row.sessionId
  const leftChunks: TextChunk[] = [...rowPrefix(input), stFg(theme.error)("! ")]
  const rightChunks: TextChunk[] = [stFg(theme.textMuted)("  "), stFg(theme.error)("unreadable")]
  const titleWidth = Math.max(0, input.rowWidth - chunksWidth(leftChunks) - chunksWidth(rightChunks))
  const titleColor = input.selected ? theme.selectedListItemText : theme.text
  return [...leftChunks, stFg(titleColor)(titleToWidth(title, titleWidth)), ...rightChunks]
}

/** The title in exactly `width` columns: cut with an ellipsis when it is
 *  wider, padded when it is narrower, so the columns after it line up. */
function titleToWidth(title: string, width: number): string {
  const cut = truncateToWidth(title, width, TITLE_ELLIPSIS)
  return cut + " ".repeat(Math.max(0, width - displayWidth(cut)))
}

function padChunks(chunks: readonly TextChunk[], theme: TuiTheme, width: number): TextChunk[] {
  const missing = width - chunksWidth(chunks)
  return missing > 0 ? [...chunks, stFg(theme.text)(" ".repeat(missing))] : [...chunks]
}
