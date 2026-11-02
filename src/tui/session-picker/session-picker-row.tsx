/** @jsxImportSource @opentui/solid */

import { StyledText, bold as stBold, fg as stFg, type TextChunk, type TextRenderable } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/resolve"
import { chunksLength } from "@tui/utils/text-attributes.js"
import { createEffect, createMemo, type JSX } from "solid-js"
import { formatCompactTimeAgo, buildDiffStatChunks } from "./picker-helpers.js"
import type { PickerCorruptRow, PickerSessionRow, SelectablePickerRow } from "./picker-types.js"

const HORIZONTAL_PADDING = "  "
const TITLE_ELLIPSIS = "…"

export interface BuildSessionRowChunksInput {
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

export function buildSessionRowChunks(input: BuildSessionRowChunksInput): TextChunk[] {
  const width = Math.max(0, input.rowWidth)
  if (width === 0) return []
  const chunks = input.row.kind === "corrupt"
      ? corruptRowChunks(input, input.row)
      : sessionRowChunks(input, input.row)
  const fitted = fitChunks(padChunks(chunks, input.theme, width), width)
  return isConfirming(input) ? fitted.map(chunk => ({ ...chunk, fg: input.theme.background })) : fitted
}

function isConfirming(input: BuildSessionRowChunksInput): boolean {
  const id = input.row.kind === "session" ? input.row.session.id : input.row.sessionId
  return input.confirmDeleteSessionId === id
}

function rowPrefix(input: BuildSessionRowChunksInput): TextChunk {
  return input.selected
    ? stFg(input.theme.primary)("> ")
    : stFg(input.theme.textMuted)(HORIZONTAL_PADDING)
}

export function SessionPickerRow(props: SessionPickerRowProps): JSX.Element {
  const content = createMemo(() => new StyledText(buildSessionRowChunks(props)))
  const backgroundColor = createMemo(() => {
    if (isConfirming(props)) return props.theme.error
    return props.selected ? props.theme.backgroundElement : undefined
  })

  return (
    <box selectable={false} width={props.rowWidth} backgroundColor={backgroundColor()} onMouseDown={() => props.onRowClick(props.rowIndex)}>
      <text ref={(el: TextRenderable) => { createEffect(() => { el.content = content() }) }} overflow="hidden" wrapMode="none" />
    </box>
  )
}

function sessionRowChunks(input: BuildSessionRowChunksInput, row: PickerSessionRow): TextChunk[] {
  const { theme } = input
  const session = row.session
  const title = isConfirming(input) ? "Press d again to confirm" : session.title || session.shortTitle || session.id
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

function sessionRightChunks(input: BuildSessionRowChunksInput, row: PickerSessionRow): TextChunk[] {
  const { theme } = input
  const timeLabel = formatCompactTimeAgo(input.now, new Date(row.session.lastUpdated).getTime()).padStart(input.timeAgoWidth)
  const diffChunks = row.session.totalsLoading ? [] : buildDiffStatChunks(row.session.diffStats, {
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

function corruptRowChunks(input: BuildSessionRowChunksInput, row: PickerCorruptRow): TextChunk[] {
  const { theme } = input
  const title = isConfirming(input) ? "Press d again to confirm" : row.sessionId
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
