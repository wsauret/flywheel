import type { NeedsYou } from "../../../../src/protocol/client/session/needs-you.js"
import type { StoppedChat } from "../../../../src/protocol/session/unread-protocol-types.js"
import type { SessionSummary } from "../../client/session/view-state.js"

/** One drawn row of the session list. */
export interface SessionRow {
  readonly session: SessionSummary
  readonly group: "Needs you" | "Working" | "Recent"
  /** What a row signals: a question that blocks the session on the person,
   *  or a stop the person has not read, which file it under Needs you, or an
   *  error it reports, which leaves it in its place by work and recency. */
  readonly need: "question" | "stopped" | "error" | undefined
  /** The stop of a row filed under Needs you as stopped. */
  readonly stopped: StoppedChat | undefined
  /** The chat holds messages the person has not read while its agent works
   *  (PI-INTERACTION-188). The row keeps its place. */
  readonly unread: boolean
  /** The heading drawn above the first row of a non-empty group. */
  readonly heading: string | undefined
}

/** Lists chats by attention, work, then recency. Needs you holds the chats
 *  in the order `needsYou` gives: questions, then stopped unread chats,
 *  newest first in each kind. Working and Recent are newest first.
 *
 *  Rows keep their identity across passes. The list keys its rows by session
 *  and hands each one its row through a signal, so a row object minted afresh
 *  on every pass made all of them re-render for a change to one. A row whose
 *  session, place, heading, and marks are what they were is the previous
 *  pass's object, and only the rows that changed re-render. */
export function layoutSessionRows(sessions: readonly SessionSummary[], needsYou: NeedsYou, grouped: boolean, previous: readonly SessionRow[]): SessionRow[] {
  const held = new Map(previous.map((row) => [row.session.id, row]))
  const shown = new Map(sessions.map((session) => [session.id, session]))
  const newestFirst = (left: SessionSummary, right: SessionSummary) => right.lastUpdated.localeCompare(left.lastUpdated)
  const needing = needsYou.rows.flatMap((row) => {
    const session = shown.get(row.sessionId)
    return session === undefined ? [] : [{ session, stopped: row.kind === "stopped" ? row.stopped : undefined }]
  })
  const filed = new Set(needing.map((entry) => entry.session.id))
  const rest = sessions.filter((session) => !filed.has(session.id)).toSorted(newestFirst)
  const groups = {
    "Needs you": needing,
    Working: rest.filter((session) => session.working).map((session) => ({ session, stopped: undefined })),
    Recent: rest.filter((session) => !session.working).map((session) => ({ session, stopped: undefined })),
  }
  const rows: SessionRow[] = []
  for (const group of ["Needs you", "Working", "Recent"] as const) {
    for (const [index, { session, stopped }] of groups[group].entries()) {
      const heading = grouped && index === 0 ? group : undefined
      const unread = needsYou.unread.has(session.id)
      const prior = held.get(session.id)
      const same = prior?.session === session && prior.heading === heading && prior.group === group && sameStop(prior.stopped, stopped) && prior.unread === unread
      rows.push(same ? prior : { session, heading, group, need: needOf(session, stopped), stopped, unread })
    }
  }
  return rows
}

function needOf(session: SessionSummary, stopped: StoppedChat | undefined): SessionRow["need"] {
  if (session.awaitingAnswer) return "question"
  if (stopped !== undefined) return "stopped"
  if (session.notices?.some((notice) => notice.severity === "error")) return "error"
  return undefined
}

/** Each patch carries the whole set as new objects, so a stop is the same
 *  when what the row draws of it is. */
function sameStop(left: StoppedChat | undefined, right: StoppedChat | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.stopKey === right.stopKey && left.stoppedAt === right.stoppedAt && left.firstLine === right.firstLine && left.ending.kind === right.ending.kind
}
