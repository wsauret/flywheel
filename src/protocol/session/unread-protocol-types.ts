import { Schema } from "effect"
import { ChatTurnEndingSchema } from "./chat-settlement-protocol-types.js"

/** A root chat that stopped for the person and that the person has not read
 *  (PI-INTERACTION-186). `stopKey` names the stop: its final entry, or the
 *  stop itself when it ended on an error, so a stop that the runtime records
 *  again for the same answer keeps its key. `firstLine` is the first line of
 *  the final message, absent for a stop on an error. `stoppedAt` is the time
 *  of the stop, in epoch milliseconds. */
const StoppedChatSchema = Schema.Struct({
  sessionId: Schema.String,
  ending: ChatTurnEndingSchema,
  firstLine: Schema.optionalKey(Schema.String),
  stoppedAt: Schema.Number,
  stopKey: Schema.String,
})
export type StoppedChat = typeof StoppedChatSchema.Type

/** The time of each root chat's latest turn, in epoch milliseconds, by
 *  session id: when its newest turn started or stopped (PI-INTERACTION-189).
 *  A chat with no recorded turn has the time of the newest entry batch of
 *  the conversation that it was created with, and a chat with neither is
 *  absent. Opening, closing, or reading a chat, a mark, and a restart of the
 *  service never change a time. */
const ChatTurnTimesSchema = Schema.Record(Schema.String, Schema.Number)
export type ChatTurnTimes = typeof ChatTurnTimesSchema.Type

/** The chats of the project that need the person and the chats with unread
 *  messages (ARCH-PROTOCOL-072): `stopped` holds every stopped chat that the
 *  person has not read, newest stop first, and `unread` the session ids of
 *  chats whose agent still works and that hold agent messages the person
 *  has not read (PI-INTERACTION-188). A chat that a connection is at is read,
 *  so it is in neither. A client joins the ids with the rows it lists. */
const UnreadChatsPlacesSchema = Schema.Struct({ stopped: Schema.Array(StoppedChatSchema), unread: Schema.Array(Schema.String) })
type UnreadChatsPlaces = typeof UnreadChatsPlacesSchema.Type

/** The places and, in `turns`, the latest turn time of every chat that has one. */
export interface UnreadChatsView extends UnreadChatsPlaces {
  readonly turns: ChatTurnTimes
}

export const RuntimeUnreadChatsSnapshotResultSchema = Schema.Struct({ ...UnreadChatsPlacesSchema.fields, turns: ChatTurnTimesSchema, snapshotPosition: Schema.Number })
export type RuntimeUnreadChatsSnapshotResult = typeof RuntimeUnreadChatsSnapshotResultSchema.Type

/** One patch carries only what its change moved, so it never grows with the
 *  number of chats: `places`, the whole stopped and unread view, only when a
 *  chat's place in it changed, and in `turns` each latest turn time that
 *  moved, or null for a chat that was deleted. A client folds a patch with
 *  `foldUnreadChatsPatch`. Patches are delivered in order, and a client that
 *  misses one reads the snapshot again, so a client that reads a snapshot
 *  and folds every later patch holds what a later snapshot answers.
 *
 *  `newStops` holds the chats that this change lists because they just
 *  stopped for the person unread, each once for its stop (PI-INTERACTION-052,
 *  PI-REMOTE-015). A read, a mark, and a stop that the runtime records again
 *  for the same answer announce nothing, so a pager pages only from it, also
 *  for a patch that a read covers. */
export const UnreadChatsPatchPayloadSchema = Schema.Struct({
  kind: Schema.Literal("unreadChats.changed"),
  places: Schema.optionalKey(UnreadChatsPlacesSchema),
  turns: Schema.Record(Schema.String, Schema.NullOr(Schema.Number)),
  newStops: Schema.Array(StoppedChatSchema),
})
export type UnreadChatsPatchPayload = typeof UnreadChatsPatchPayloadSchema.Type

/** The view after `payload`, from the view held before it. The held times
 *  keep their identity when the patch moved none. */
export function foldUnreadChatsPatch(current: UnreadChatsView, payload: UnreadChatsPatchPayload): UnreadChatsView {
  const { stopped, unread } = payload.places ?? current
  const moved = Object.entries(payload.turns)
  if (moved.length === 0) return { stopped, unread, turns: current.turns }
  const turns = new Map(Object.entries(current.turns))
  for (const [sessionId, at] of moved) {
    if (at === null) turns.delete(sessionId)
    else turns.set(sessionId, at)
  }
  return { stopped, unread, turns: Object.fromEntries(turns) }
}

export function unreadChatsCursor() {
  return { scope: "workspace", domain: "unreadChats" } as const
}

/** What a client connection tells the account service about the person
 *  (ARCH-SESSIONS-052). `chat.presence` names the chat that the person is at
 *  on this connection, or none without `sessionId`; it replaces what the
 *  connection said before and ends with the connection. It is live state
 *  only: it attaches no runner and records nothing until the presence ends.
 *  `chat.mark_read` and `chat.mark_unread` are the person's marks from a
 *  list (PI-INTERACTION-187). Only the account service serves them. */
export const UnreadChatsMutationSchemas = [
  Schema.Struct({ type: Schema.Literal("chat.presence"), sessionId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("chat.mark_read"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("chat.mark_unread"), sessionId: Schema.String }),
] as const
export type UnreadChatsMutation = (typeof UnreadChatsMutationSchemas)[number]["Type"]

const UNREAD_CHATS_MUTATION_TYPES: ReadonlySet<string> = new Set(UnreadChatsMutationSchemas.map((schema) => schema.fields.type.literal))

export function isUnreadChatsMutation<M extends { readonly type: string }>(mutation: M): mutation is Extract<M, UnreadChatsMutation> {
  return UNREAD_CHATS_MUTATION_TYPES.has(mutation.type)
}
