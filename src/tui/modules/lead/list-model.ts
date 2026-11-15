import type { LeadRowState } from "../../../protocol/modules/lead.js"
import { displayWidth, truncateToWidth } from "../../utils/text.js"

/** The theme colour of a state's mark, by theme key. */
type LeadStateTone = "warning" | "primary" | "success" | "textMuted"

/** How a row marks its chat's state: a mark in its own colour. Every state that needs the person shares the warning
 *  tone. */
export const LEAD_STATE_LOOK = {
  question: { mark: "?", tone: "warning" },
  failed: { mark: "✗", tone: "warning" },
  cut: { mark: "■", tone: "warning" },
  working: { mark: "●", tone: "primary" },
  result: { mark: "✓", tone: "success" },
  done: { mark: "·", tone: "textMuted" },
} as const satisfies { readonly [state in LeadRowState]: { readonly mark: string; readonly tone: LeadStateTone } }

/** The widest title and status a row shows; longer text is cut with an ellipsis. */
const TITLE_COLUMNS = 24
const STATUS_COLUMNS = 48
const SEPARATOR = "  "
/** The most chat rows the list shows, so it never pushes the transcript off the screen. */
const MAX_VISIBLE_ROWS = 5

/** The age of a row in whole units, so a row's text changes once a minute at most. */
export function leadAge(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** One row's text in parts that render in their own colours: the mark, the title padded to the list's title column,
 *  the status, and the age. The title and the status are the chat's own, only cut, and the parts never exceed
 *  `width`, so a row never wraps. */
export interface LeadRowLayout {
  readonly mark: string
  readonly title: string
  readonly status: string
  readonly age: string
}

/** The title column of the rows that show: as wide as their widest title, and at most `TITLE_COLUMNS`. */
export function leadTitleColumn(titles: readonly string[]): number {
  return Math.min(TITLE_COLUMNS, Math.max(0, ...titles.map(displayWidth)))
}

/** Text cut to `columns` with an ellipsis that follows the last word, not a space. */
function cut(text: string, columns: number): string {
  return truncateToWidth(text, columns, "…").replace(/\s+…$/, "…")
}

export function layoutLeadRow(row: { readonly state: LeadRowState; readonly title: string; readonly status: string; readonly age: string }, input: { readonly width: number; readonly titleColumn: number }): LeadRowLayout {
  const mark = `${LEAD_STATE_LOOK[row.state].mark} `
  const room = Math.max(0, input.width - mark.length - 2 * SEPARATOR.length - row.age.length)
  const titleColumn = Math.min(input.titleColumn, room)
  const statusColumns = Math.min(STATUS_COLUMNS, room - titleColumn)
  const title = cut(row.title, titleColumn)
  const status = cut(row.status, statusColumns)
  return { mark, title: `${title}${" ".repeat(titleColumn - displayWidth(title))}${SEPARATOR}`, status: status ? `${status}${SEPARATOR}` : "", age: row.age }
}

/** The first chat row shown, how many show, and how many rows the lines above and below them count. */
interface LeadListWindow {
  readonly start: number
  readonly count: number
  readonly above: number
  readonly below: number
}

/** The chat rows the list shows: at most 5, and with the lines that count
 *  the rows above and below them and the hint line at most a third of the
 *  terminal's rows, but always one. The window moves only as far as the
 *  selection needs. */
export function leadListWindow(input: { readonly total: number; readonly selected: number | undefined; readonly start: number; readonly terminalRows: number }): LeadListWindow {
  const lines = Math.floor(input.terminalRows / 3)
  const count = input.total <= Math.min(MAX_VISIBLE_ROWS, lines - 1) ? input.total : Math.max(1, Math.min(MAX_VISIBLE_ROWS, lines - 3))
  let start = Math.min(input.start, Math.max(0, input.total - count))
  if (input.selected !== undefined) {
    if (input.selected < start) start = input.selected
    else if (input.selected >= start + count) start = input.selected - count + 1
  }
  return { start, count, above: start, below: input.total - start - count }
}

/** The selected chat after the rows change: the same chat while it has a
 *  row, else the chat whose row takes its place. */
export function followSelection(previous: readonly string[], next: readonly string[], selected: string | undefined): string | undefined {
  if (selected === undefined || next.includes(selected)) return selected
  const index = previous.indexOf(selected)
  return next[Math.min(Math.max(0, index), next.length - 1)]
}
