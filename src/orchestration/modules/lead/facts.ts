import { Schema } from "effect"
import { defineFact } from "../../../infra/event-registry.js"

/** The project aggregate that holds every lead fact. */
export const LEAD_AGGREGATE_ID = "lead"

const EntryIds = Schema.NonEmptyArray(Schema.NonEmptyString)

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

/** A chat that the lead started, and the ids of the person's entries in the lead chat that started it. */
const LeadChatStartedFactSchema = defineFact({
  type: "lead.chat.started",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sessionId: Schema.NonEmptyString, sourceEntryIds: EntryIds }),
})

/** The lead forwarded the person's entries to a chat. No fact holds message text. */
const LeadRequestForwardedFactSchema = defineFact({
  type: "lead.request.forwarded",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({
    leadSessionId: Schema.NonEmptyString,
    targetSessionId: Schema.NonEmptyString,
    newChat: Schema.Boolean,
    sourceEntryIds: EntryIds,
  }),
})

/** The person read a started chat's result up to this entry. */
const LeadResultReadFactSchema = defineFact({
  type: "lead.result.read",
  version: 1,
  actor: Schema.Literal("system"),
  payload: Schema.Struct({ sessionId: Schema.NonEmptyString, entryId: Schema.NonEmptyString }),
})

const LeadFactSchema = Schema.Union([
  LeadChatDesignatedFactSchema,
  LeadChatDismissedFactSchema,
  LeadChatStartedFactSchema,
  LeadRequestForwardedFactSchema,
  LeadResultReadFactSchema,
])

export type LeadFact = typeof LeadFactSchema.Type

export function parseLeadFact(value: unknown): LeadFact {
  return Schema.decodeUnknownSync(LeadFactSchema, { onExcessProperty: "error" })(value)
}
