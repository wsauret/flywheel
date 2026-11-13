import type { LeadRowState } from "../../../protocol/modules/lead.js"
import { displayWidth, shareWidth, truncateToWidth } from "../../utils/text.js"

/** The theme colour of a state's mark, by theme key. */
type LeadStateTone = "warning" | "error" | "primary" | "success"

/** How a row names its chat's state: a mark, a word, and the mark's colour. */
export const LEAD_STATE_LOOK = {
  question: { mark: "?", word: "question", tone: "warning" },
  failed: { mark: "✗", word: "failed", tone: "error" },
  cut: { mark: "■", word: "cut", tone: "warning" },
  working: { mark: "●", word: "working", tone: "primary" },
  result: { mark: "✓", word: "result", tone: "success" },
} as const satisfies { readonly [state in LeadRowState]: { readonly mark: string; readonly word: string; readonly tone: LeadStateTone } }

const WORD_WIDTH = Math.max(...Object.values(LEAD_STATE_LOOK).map((look) => look.word.length))
const SEPARATOR = "  "
/** The most chat rows the list shows, so it never pushes the transcript off the screen. */
const MAX_VISIBLE_ROWS = 6

/** The age of a row in whole units, so a row's text changes once a minute at most. */
export function leadAge(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000)
  if (minutes < 1) return "now"
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** One row's text in parts whose widths sum to `width`: the parts render in
 *  their own colours, and the age sits at the right edge. The title and the
 *  update share the room that is left, and each is cut with an ellipsis, so
 *  a row never wraps. The text is the chat's own, only cut. */
export interface LeadRowLayout {
  readonly prefix: string
  readonly title: string
  readonly separator: string
  readonly update: string
  readonly gap: string
  readonly age: string
}

export function layoutLeadRow(row: { readonly state: LeadRowState; readonly title: string; readonly update: string | null; readonly age: string }, width: number): LeadRowLayout {
  const look = LEAD_STATE_LOOK[row.state]
  const prefix = `${look.mark} ${look.word.padEnd(WORD_WIDTH)}${SEPARATOR}`
  const separator = row.update ? SEPARATOR : ""
  const room = Math.max(0, width - displayWidth(prefix) - separator.length - row.age.length - 1)
  const texts = row.update ? [row.title, row.update] : [row.title]
  const widths = shareWidth(texts.map(displayWidth), room)
  const [title = "", update = ""] = texts.map((text, index) => truncateToWidth(text, widths[index] ?? 0, "…"))
  const used = displayWidth(prefix) + displayWidth(title) + separator.length + displayWidth(update) + row.age.length
  return { prefix, title, separator, update, gap: " ".repeat(Math.max(1, width - used)), age: row.age }
}

/** The first chat row shown, how many show, and how many the more line counts. */
interface LeadListWindow {
  readonly start: number
  readonly count: number
  readonly more: number
}

/** The chat rows the list shows: at most 6, and with the more line and the
 *  hint line at most a third of the terminal's rows, but always one. The
 *  window moves only as far as the selection needs. */
export function leadListWindow(input: { readonly total: number; readonly selected: number | undefined; readonly start: number; readonly terminalRows: number }): LeadListWindow {
  const lines = Math.floor(input.terminalRows / 3)
  const count = input.total <= Math.min(MAX_VISIBLE_ROWS, lines - 1) ? input.total : Math.max(1, Math.min(MAX_VISIBLE_ROWS, lines - 2))
  let start = Math.min(input.start, Math.max(0, input.total - count))
  if (input.selected !== undefined) {
    if (input.selected < start) start = input.selected
    else if (input.selected >= start + count) start = input.selected - count + 1
  }
  return { start, count, more: input.total - count }
}

/** The selected chat after the rows change: the same chat while it has a
 *  row, else the chat whose row takes its place. */
export function followSelection(previous: readonly string[], next: readonly string[], selected: string | undefined): string | undefined {
  if (selected === undefined || next.includes(selected)) return selected
  const index = previous.indexOf(selected)
  return next[Math.min(Math.max(0, index), next.length - 1)]
}
