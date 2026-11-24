/** @jsxImportSource @opentui/solid */

import { StyledText, bold as stBold, fg as stFg, type TextChunk, type TextRenderable } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/tui-theme"
import { chunksLength } from "@tui/terminal/text-attributes.js"
import { createEffect, createMemo, For, type JSX } from "solid-js"
import { snippetParts } from "../../../protocol/client/search-snippet.js"
import { formatCompactTimeAgo, pickerRowLastActive, pickerRowLines, buildDiffStatChunks } from "./picker-helpers.js"
import type { PickerCorruptRow, PickerFoundRow, PickerSessionRow, SelectablePickerRow } from "./picker-types.js"

const HORIZONTAL_PADDING = "  "
const TITLE_ELLIPSIS = "…"

interface BuildSessionRowChunksInput {
  row: SelectablePickerRow
  theme: TuiTheme
  rowWidth: number
  selected: boolean
  foregroundId?: string
  isWorking: boolean
  blinkOn: boolean
  now: number
  timeAgoWidth: number
  confirmDeleteSessionId?: string
}

interface SessionPickerRowProps extends BuildSessionRowChunksInput {
  rowIndex: number
  onRowClick: (rowIndex: number) => void
}

/** The styled lines of one row: one for a session, and for a chat found by
 *  its messages also the matching words and where it stands. */
function buildSessionRowLines(input: BuildSessionRowChunksInput): TextChunk[][] {
  const width = Math.max(0, input.rowWidth)
  if (width === 0) return []
  const fit = (chunks: readonly TextChunk[]) => fitChunks(padChunks(chunks, input.theme, width), width)
  if (input.row.kind === "found") return [fit(sessionRowChunks(input, input.row)), ...foundDetailLines(input, input.row).map(fit)]
  const fitted = fit(input.row.kind === "corrupt" ? corruptRowChunks(input, input.row) : sessionRowChunks(input, input.row))
  return [isConfirming(input) ? fitted.map(chunk => ({ ...chunk, fg: input.theme.background })) : fitted]
}

function isConfirming(input: BuildSessionRowChunksInput): boolean {
  const id = input.row.kind === "corrupt" ? input.row.sessionId : input.row.session.id
  return input.confirmDeleteSessionId === id
}

function rowPrefix(input: BuildSessionRowChunksInput): TextChunk {
  return input.selected
    ? stFg(input.theme.primary)("> ")
    : stFg(input.theme.textMuted)(HORIZONTAL_PADDING)
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
  const leftChunks: TextChunk[] = [rowPrefix(input)]

  if (session.id === input.foregroundId) leftChunks.push(stFg(theme.success)("(current) "))
  if (input.isWorking) leftChunks.push(stBold(stFg(input.blinkOn ? theme.success : theme.textMuted)("● ")))
  else if (session.lifecycleState === "active") leftChunks.push(stFg(theme.success)("● "))
  else leftChunks.push(stFg(theme.textMuted)("○ "))

  const rightChunks = sessionRightChunks(input, row)
  const titleWidth = Math.max(0, input.rowWidth - chunksLength(leftChunks) - chunksLength(rightChunks))
  const titleColor = input.selected ? theme.selectedListItemText : theme.text
  return [...leftChunks, stFg(titleColor)(ellipsizeToWidth(title, titleWidth)), ...rightChunks]
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

/** Indents a found row's details under its title, past the cursor and the status dot. */
const DETAIL_INDENT = "    "

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
  const leftChunks: TextChunk[] = [rowPrefix(input), stFg(theme.error)("! ")]
  const rightChunks: TextChunk[] = [stFg(theme.textMuted)("  "), stFg(theme.error)("unreadable")]
  const titleWidth = Math.max(0, input.rowWidth - chunksLength(leftChunks) - chunksLength(rightChunks))
  const titleColor = input.selected ? theme.selectedListItemText : theme.text
  return [...leftChunks, stFg(titleColor)(ellipsizeToWidth(title, titleWidth)), ...rightChunks]
}

function ellipsizeToWidth(text: string, width: number): string {
  if (width <= 0) return ""
  if (text.length <= width) return text.padEnd(width)
  if (width === 1) return TITLE_ELLIPSIS
  return `${text.slice(0, width - 1)}${TITLE_ELLIPSIS}`
}

function padChunks(chunks: readonly TextChunk[], theme: TuiTheme, width: number): TextChunk[] {
  const missing = width - chunksLength(chunks)
  return missing > 0 ? [...chunks, stFg(theme.text)(" ".repeat(missing))] : [...chunks]
}

function fitChunks(chunks: readonly TextChunk[], width: number): TextChunk[] {
  let remaining = width
  const fitted: TextChunk[] = []
  for (const chunk of chunks) {
    if (remaining <= 0) break
    if (chunk.text.length <= remaining) {
      fitted.push(chunk)
      remaining -= chunk.text.length
    } else {
      fitted.push({ ...chunk, text: chunk.text.slice(0, remaining) })
      remaining = 0
    }
  }
  return fitted
}
