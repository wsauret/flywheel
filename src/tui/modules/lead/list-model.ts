import { SHORT_TITLE_MAX_CHARS } from "../../../protocol/app-service-types.js"
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

const SEPARATOR = "  "
/** The name column (the tab title, then the longer title) is 24 columns wide on a narrow terminal and grows with a
 *  wider one while the status keeps 40 columns, up to a whole tab title and 30 columns of the longer title. The
 *  status takes the rest. Longer text is cut with an ellipsis. */
const NAME_MIN_COLUMNS = 24
const NAME_MAX_COLUMNS = SHORT_TITLE_MAX_CHARS + SEPARATOR.length + 30
const STATUS_KEPT_COLUMNS = 40
/** The columns of a row besides its name and its status: the mark, two separators, and an age such as "59m". */
const ROW_FRAME_COLUMNS = 2 + 2 * SEPARATOR.length + 3
/** A longer title cut to fewer characters than this tells nothing, so it leaves instead. */
const MIN_LONG_TITLE_CHARS = 4
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

/** How a row names its chat: the title that its tab shows, and its longer title, which is empty when it adds nothing
 *  to the tab title. */
export interface LeadRowName {
  readonly title: string
  readonly longTitle: string
}

/** One row's text in parts that render in their own colours: the mark, the tab title, the longer title padded to the
 *  list's title column, the status, and the age. The titles and the status are the chat's own, only cut, and the parts
 *  never exceed `width`, so a row never wraps. The longer title is cut first, so the tab title stays in view. */
export interface LeadRowLayout {
  readonly mark: string
  readonly title: string
  readonly longTitle: string
  readonly status: string
  readonly age: string
}

const nameText = (name: LeadRowName): string => name.longTitle ? `${name.title}${SEPARATOR}${name.longTitle}` : name.title

/** The title column of the rows that show on a list `width` columns wide: as wide as their widest name, and at most
 *  the name column that the width gives. One column for every row, so the statuses line up. */
export function leadTitleColumn(names: readonly LeadRowName[], width: number): number {
  const most = Math.min(NAME_MAX_COLUMNS, Math.max(NAME_MIN_COLUMNS, width - ROW_FRAME_COLUMNS - STATUS_KEPT_COLUMNS))
  return Math.min(most, Math.max(0, ...names.map((name) => displayWidth(nameText(name)))))
}

/** Text cut to `columns` with an ellipsis that follows the last word, not a space. */
function cut(text: string, columns: number): string {
  return truncateToWidth(text, columns, "…").replace(/\s+…$/, "…")
}

export function layoutLeadRow(row: LeadRowName & { readonly state: LeadRowState; readonly status: string; readonly age: string }, input: { readonly width: number; readonly titleColumn: number }): LeadRowLayout {
  const mark = `${LEAD_STATE_LOOK[row.state].mark} `
  const room = Math.max(0, input.width - mark.length - 2 * SEPARATOR.length - row.age.length)
  const titleColumn = Math.min(input.titleColumn, room)
  const title = cut(row.title, titleColumn)
  const longRoom = titleColumn - displayWidth(title) - SEPARATOR.length
  const longCut = row.longTitle && longRoom > 0 ? cut(row.longTitle, longRoom) : ""
  const longTitle = longCut && (longCut === row.longTitle || displayWidth(longCut) - 1 >= MIN_LONG_TITLE_CHARS) ? `${SEPARATOR}${longCut}` : ""
  const status = cut(row.status, room - titleColumn)
  const padding = " ".repeat(titleColumn - displayWidth(title) - displayWidth(longTitle))
  return { mark, title, longTitle: `${longTitle}${padding}${SEPARATOR}`, status: status ? `${status}${SEPARATOR}` : "", age: row.age }
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
