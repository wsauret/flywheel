import { Schema } from "effect"
import { defineFact } from "../../../infra/event-registry.js"

/** The project aggregate that holds every lead fact. */
export const LEAD_AGGREGATE_ID = "lead"

const EntryIds = Schema.NonEmptyArray(Schema.NonEmptyString)
/** The hash of the passages of a split request (`passagesHash`). A fact without it forwarded the whole entries; the
 *  facts of builds before the split hold none. */
const PassagesHash = Schema.optionalKey(Schema.NonEmptyString)

/** The chat that a launch opens as the lead. The latest designation or dismissal decides. */
const LeadChatDesignatedFactSchema = defineFact({
  type: "lead.chat.designated",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sessionId: Schema.NonEmptyString }),
})

/** The person closed the lead chat, so a launch opens it no more until the lead command. */
const LeadChatDismissedFactSchema = defineFact({
  type: "lead.chat.dismissed",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sessionId: Schema.NonEmptyString }),
})

/** A chat that the lead started, and the forward that started it: the ids of the person's entries in the lead chat,
 *  and the hash of their passages for a split request. */
const LeadChatStartedFactSchema = defineFact({
  type: "lead.chat.started",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sessionId: Schema.NonEmptyString, sourceEntryIds: EntryIds, passagesHash: PassagesHash }),
})

/** The lead forwarded the person's entries, or passages of them, to a chat. No fact holds message text. */
const LeadRequestForwardedFactSchema = defineFact({
  type: "lead.request.forwarded",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({
    leadSessionId: Schema.NonEmptyString,
    targetSessionId: Schema.NonEmptyString,
    newChat: Schema.Boolean,
    sourceEntryIds: EntryIds,
    passagesHash: PassagesHash,
  }),
})

/** A chat joined the lead's list (PI-LEAD-004): a root chat other than the lead became active while it was not in the
 *  list. `briefed` is true when the chat joined at its creation while the lead showed, so its prompt holds the
 *  lead's rules for its whole life (PI-LEAD-012). */
const LeadChatJoinedFactSchema = defineFact({
  type: "lead.chat.joined",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sessionId: Schema.NonEmptyString, briefed: Schema.Boolean }),
})

/** The person closed a chat of the lead's list, so it leaves the list until it becomes active again. A runtime stop
 *  records none. */
const LeadChatClosedFactSchema = defineFact({
  type: "lead.chat.closed",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sessionId: Schema.NonEmptyString }),
})

/** A chat of the lead's list came to rest with nothing for the person and no client shows it, so it leaves the list
 *  until it becomes active again (PI-LEAD-004). The person did not close it. */
const LeadChatRetiredFactSchema = defineFact({
  type: "lead.chat.retired",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sessionId: Schema.NonEmptyString }),
})

/** The first run of the list in a project joined every chat that the list adopts from the rule before it: each
 *  chat that the lead started and that this rule still showed. Its absence makes the next start run it again. */
const LeadListSeededFactSchema = defineFact({
  type: "lead.list.seeded",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({}),
})

/** The person read a listed chat's result up to this entry. */
const LeadResultReadFactSchema = defineFact({
  type: "lead.result.read",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sessionId: Schema.NonEmptyString, entryId: Schema.NonEmptyString }),
})

/** The person opened a listed chat while its row was failed or cut at this entry, so the row shows that state no more
 *  until the chat changes state again. */
const LeadChatSeenFactSchema = defineFact({
  type: "lead.chat.seen",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sessionId: Schema.NonEmptyString, state: Schema.Literals(["failed", "cut"]), entryId: Schema.NonEmptyString }),
})

const LeadFactSchema = Schema.Union([
  LeadChatDesignatedFactSchema,
  LeadChatDismissedFactSchema,
  LeadChatStartedFactSchema,
  LeadRequestForwardedFactSchema,
  LeadResultReadFactSchema,
  LeadChatSeenFactSchema,
  LeadChatJoinedFactSchema,
  LeadChatClosedFactSchema,
  LeadChatRetiredFactSchema,
  LeadListSeededFactSchema,
])

export type LeadFact = typeof LeadFactSchema.Type

export function parseLeadFact(value: unknown): LeadFact {
  return Schema.decodeUnknownSync(LeadFactSchema, { onExcessProperty: "error" })(value)
}
