import type { SessionSummary } from "../client/view-state.js"

/** One drawn row of the session list. */
export interface SessionRow {
  readonly session: SessionSummary
  readonly group: "Needs you" | "Working" | "Recent"
  /** What a row signals: a question that blocks the session on the person,
   *  which alone files it under Needs you, or an error it reports, which
   *  leaves it in its place by work and recency. */
  readonly need: "question" | "error" | undefined
  /** The heading drawn above the first row of a non-empty group. */
  readonly heading: string | undefined
}

/** Lists chats by attention, work, then recency, newest first in each group.
 *
 *  Rows keep their identity across passes. The list keys its rows by session
 *  and hands each one its row through a signal, so a row object minted afresh
 *  on every pass made all of them re-render for a change to one. A row whose
 *  session, place, and heading are what they were is the previous pass's
 *  object, and only the rows that moved re-render. */
export function layoutSessionRows(sessions: readonly SessionSummary[], grouped: boolean, previous: readonly SessionRow[]): SessionRow[] {
  const held = new Map(previous.map((row) => [row.session.id, row]))
  const newestFirst = (left: SessionSummary, right: SessionSummary) => right.lastUpdated.localeCompare(left.lastUpdated)
  const groups = { "Needs you": new Array<SessionSummary>(), Working: new Array<SessionSummary>(), Recent: new Array<SessionSummary>() }
  for (const session of sessions) {
    groups[session.awaitingAnswer ? "Needs you" : session.working ? "Working" : "Recent"].push(session)
  }
  const rows: SessionRow[] = []
  for (const group of ["Needs you", "Working", "Recent"] as const) {
    for (const [index, session] of groups[group].toSorted(newestFirst).entries()) {
      const heading = grouped && index === 0 ? group : undefined
      const prior = held.get(session.id)
      rows.push(prior?.session === session && prior.heading === heading && prior.group === group ? prior : { session, heading, group, need: needOf(session) })
    }
  }
  return rows
}

function needOf(session: SessionSummary): SessionRow["need"] {
  if (session.awaitingAnswer) return "question"
  if (session.notices?.some((notice) => notice.severity === "error")) return "error"
  return undefined
}
