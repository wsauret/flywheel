import type { NeedsYou } from "../../../../src/protocol/client/session/needs-you.js"
import { groupSessionList, type ListedTurns, type SessionListGroup } from "../../../../src/protocol/client/session/session-list-groups.js"
import type { StoppedChat } from "../../../../src/protocol/session/unread-protocol-types.js"
import type { SessionSummary } from "../../client/session/view-state.js"

/** One drawn row of the session list. */
export interface SessionRow {
  readonly session: SessionSummary
  readonly group: SessionListGroup
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
  /** The time the row's time column shows, in epoch milliseconds. */
  readonly lastActiveAt: number
}

/** Draws the places that `groupSessionList` gives the chats, with a heading
 *  above the first row of each group when `grouped`.
 *
 *  Rows keep their identity across passes. The list keys its rows by session
 *  and hands each one its row through a signal, so a row object minted afresh
 *  on every pass made all of them re-render for a change to one. A row whose
 *  session, place, heading, time, and marks are what they were is the
 *  previous pass's object, and only the rows that changed re-render. */
export function layoutSessionRows(sessions: readonly SessionSummary[], needsYou: NeedsYou, turns: ListedTurns, grouped: boolean, previous: readonly SessionRow[]): SessionRow[] {
  const held = new Map(previous.map((row) => [row.session.id, row]))
  let group: SessionListGroup | undefined
  return groupSessionList({ rows: sessions, needsYou, working: (session) => session.working, turns }).map((entry) => {
    const heading = grouped && entry.group !== group ? entry.group : undefined
    group = entry.group
    const { row: session, stopped, lastActiveAt } = entry
    const unread = needsYou.unread.has(session.id)
    const prior = held.get(session.id)
    const same = prior?.session === session && prior.heading === heading && prior.group === entry.group && prior.lastActiveAt === lastActiveAt && sameStop(prior.stopped, stopped) && prior.unread === unread
    return same ? prior : { session, heading, group: entry.group, need: needOf(session, stopped), stopped, unread, lastActiveAt }
  })
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
