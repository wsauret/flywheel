import { Schema } from "effect"
import { defineFact } from "../../../infra/substrate/facts/event-registry.js"
import { ChatTurnEndingSchema } from "../../../protocol/session/chat-settlement-protocol-types.js"

/** A root chat stopped and now waits for the person (ARCH-SESSIONS-051): its
 *  turn ended, no wait is open, and no work that owes it a result runs. The
 *  chat's runner records it on the chat's session aggregate when its loop
 *  parks idle after a turn end, or when its run ends on a failure that no
 *  queued input continues. Project recovery records it for an owner that
 *  died between the final message and this fact.
 *
 *  `ending` says how the turn ended, in the words of the `chatSettlement`
 *  query. `finalEntryId` names the entry of the assistant's final message,
 *  and `firstLine` is its first line as plain text, so a list row needs no
 *  transcript read. Both are absent when the turn ended with no answer, as a
 *  failed or refused turn does. `endedAt`, in epoch milliseconds, is when
 *  the turn ended, for a stop recorded later than that: recovery records it
 *  at the time of the final message. Without it the turn ended when the fact
 *  was recorded. Only the newest fact of a session applies. */
const ChatTurnStoppedFactSchema = defineFact({
  type: "chat.turn.stopped",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    ending: ChatTurnEndingSchema,
    finalEntryId: Schema.optionalKey(Schema.NonEmptyString),
    firstLine: Schema.optionalKey(Schema.String),
    endedAt: Schema.optionalKey(Schema.Number),
  }),
})

/** A turn of a root chat started, or a parked turn continued, so a stop
 *  recorded before it no longer applies. A chat is stopped while its newest
 *  `chat.turn.stopped` is newer than its newest start. Only the newest fact
 *  of a session applies. */
const ChatTurnStartedFactSchema = defineFact({
  type: "chat.turn.started",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
  }),
})

export const ChatTurnStopFactSchemas = [ChatTurnStoppedFactSchema, ChatTurnStartedFactSchema] as const
export type ChatTurnStoppedFact = typeof ChatTurnStoppedFactSchema.Type
export type ChatTurnStartedFact = typeof ChatTurnStartedFactSchema.Type
export type ChatTurnStopFact = ChatTurnStoppedFact | ChatTurnStartedFact
