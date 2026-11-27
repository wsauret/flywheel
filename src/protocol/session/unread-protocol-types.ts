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

/** The chats of the project that need the person and the chats with unread
 *  messages (ARCH-PROTOCOL-072): `stopped` holds every stopped chat that the
 *  person has not read, newest stop first, and `unread` the session ids of
 *  chats whose agent still works and that hold agent messages the person
 *  has not read (PI-INTERACTION-188). A chat that a connection is at is read,
 *  so it is in neither. A client joins the ids with the rows it lists. */
const UnreadChatsFields = { stopped: Schema.Array(StoppedChatSchema), unread: Schema.Array(Schema.String) }
export interface UnreadChatsView {
  readonly stopped: readonly StoppedChat[]
  readonly unread: readonly string[]
}

export const RuntimeUnreadChatsSnapshotResultSchema = Schema.Struct({ ...UnreadChatsFields, snapshotPosition: Schema.Number })
export type RuntimeUnreadChatsSnapshotResult = typeof RuntimeUnreadChatsSnapshotResultSchema.Type

/** One patch carries the whole view, so the newest supersedes any it overtook.
 *  `newStops` holds the chats that this change lists because they just
 *  stopped for the person unread, each once for its stop (PI-INTERACTION-052,
 *  PI-REMOTE-015). A read, a mark, and a stop that the runtime records again
 *  for the same answer announce nothing, so a pager pages only from it, also
 *  for a patch that a read covers. */
export const UnreadChatsPatchPayloadSchema = Schema.Struct({ kind: Schema.Literal("unreadChats.changed"), ...UnreadChatsFields, newStops: Schema.Array(StoppedChatSchema) })
export type UnreadChatsPatchPayload = typeof UnreadChatsPatchPayloadSchema.Type

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
