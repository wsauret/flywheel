import { Schema } from "effect"
import { defineFact } from "../../../infra/substrate/facts/event-registry.js"

/** Why the account service recorded a read receipt (ARCH-SESSIONS-052): the
 *  last connection that was at the chat left it, the chat stopped while a
 *  connection was at it, or the person marked the chat read or unread. */
const ChatReadCauseSchema = Schema.Literals(["presence_ended", "stopped_under_presence", "marked_read", "marked_unread"])
export type ChatReadCause = typeof ChatReadCauseSchema.Type

/** How far the person has read a root chat, on the chat's session
 *  aggregate. `readThrough` is the store position through which the person
 *  has read the chat's messages. `finalEntryId` names the final entry of the
 *  newest stop that the person has read, so a stop recorded again for the
 *  same answer stays read. A receipt with cause `marked_unread` reads
 *  nothing: the chat is unread until a later receipt. The account service
 *  is the only producer. Only the newest receipt of a session applies. */
const ChatReadRecordedFactSchema = defineFact({
  type: "chat.read.recorded",
  version: 1,
  actor: Schema.Literal("user"),
  payload: Schema.Struct({
    readThrough: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    finalEntryId: Schema.optionalKey(Schema.NonEmptyString),
    cause: ChatReadCauseSchema,
  }),
})

export const ChatReadReceiptFactSchemas = [ChatReadRecordedFactSchema] as const
export type ChatReadRecordedFact = typeof ChatReadRecordedFactSchema.Type
