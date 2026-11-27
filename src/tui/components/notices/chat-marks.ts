import type { RGBA } from "@opentui/core"
import type { TuiTheme } from "../../context/theme/tui-theme.js"
import type { NeedsYou } from "../../../protocol/client/session/needs-you.js"

/** The glyph of each chat mark. A tab and a picker row of one chat carry the
 *  same glyph, and every mark differs from the others in plain text. */
export const MARK_GLYPHS = { question: "?", stopped: "✓", failed: "!", unread: "•" } as const satisfies { readonly [mark in ChatMark]: string }

/** The colour of each chat mark. A question takes the warning colour, an
 *  error stop the colour of error rows, a stop the info colour, and unread
 *  messages the accent, which only the mark itself carries. */
export function markColor(theme: TuiTheme, mark: ChatMark): RGBA {
  switch (mark) {
    case "question": return theme.warning
    case "stopped": return theme.info
    case "failed": return theme.error
    case "unread": return theme.accent
  }
}

/** The one mark that a chat's tab and picker row carry: it waits on a
 *  question, it stopped for the person with a final message, it stopped on
 *  an error or a refusal, or its agent still works and wrote messages that
 *  the person has not read (PI-INTERACTION-184, PI-INTERACTION-186,
 *  PI-INTERACTION-188). */
export type ChatMark = "question" | "stopped" | "failed" | "unread"

/** The mark of each chat that has one, derived from the shared selector. */
export function chatMarks(needsYou: NeedsYou): ReadonlyMap<string, ChatMark> {
  const marks = new Map<string, ChatMark>()
  for (const row of needsYou.rows) {
    marks.set(row.sessionId, row.kind === "question" ? "question" : row.stopped.ending.kind === "completed" ? "stopped" : "failed")
  }
  for (const sessionId of needsYou.unread) marks.set(sessionId, "unread")
  return marks
}
