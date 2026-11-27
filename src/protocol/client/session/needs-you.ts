import type { WaitingSessionsView } from "../../session/question-protocol-types.js"
import type { StoppedChat, UnreadChatsView } from "../../session/unread-protocol-types.js"

/** One row of the Needs you list: a chat that waits on a question, or a chat
 *  that stopped for the person unread. `since` is when the question opened
 *  or the chat stopped, in epoch milliseconds. */
type NeedsYouRow =
  | { readonly kind: "question"; readonly sessionId: string; readonly since: number }
  | { readonly kind: "stopped"; readonly sessionId: string; readonly since: number; readonly stopped: StoppedChat }

export interface NeedsYou {
  /** Questions newest first, then stopped unread chats newest first. A chat
   *  that has both is listed once, as its question. */
  readonly rows: readonly NeedsYouRow[]
  /** The listed chats outside `rows` that hold unread messages, which a
   *  client marks in place (PI-INTERACTION-188). */
  readonly unread: ReadonlySet<string>
  /** How many chats need the person: one for each row. */
  readonly count: number
}

/** What every client shows of the chats that need the person, from the
 *  project's waiting set, its unread set, and the chats the client lists
 *  (PI-INTERACTION-057, PI-INTERACTION-186). A session that the client does
 *  not list, such as a deleted chat or a subagent, shows nowhere. A view the
 *  client has not read, as from an older runtime that refuses the read,
 *  counts as empty. */
export function selectNeedsYou(input: {
  readonly waiting: WaitingSessionsView | undefined
  readonly unread: UnreadChatsView | undefined
  readonly listed: Iterable<{ readonly id: string }>
}): NeedsYou {
  const listed = new Set<string>()
  for (const row of input.listed) listed.add(row.id)
  const questions = (input.waiting?.sessions ?? [])
    .filter((waiting) => listed.has(waiting.sessionId))
    .toSorted((left, right) => right.openedAt - left.openedAt)
    .map((waiting): NeedsYouRow => ({ kind: "question", sessionId: waiting.sessionId, since: waiting.openedAt }))
  const asked = new Set(questions.map((row) => row.sessionId))
  // The runtime publishes stopped chats newest first.
  const stopped = (input.unread?.stopped ?? [])
    .filter((chat) => listed.has(chat.sessionId) && !asked.has(chat.sessionId))
    .map((chat): NeedsYouRow => ({ kind: "stopped", sessionId: chat.sessionId, since: chat.stoppedAt, stopped: chat }))
  const rows = [...questions, ...stopped]
  const inRows = new Set(rows.map((row) => row.sessionId))
  const unread = new Set((input.unread?.unread ?? []).filter((sessionId) => listed.has(sessionId) && !inRows.has(sessionId)))
  return { rows, unread, count: rows.length }
}
