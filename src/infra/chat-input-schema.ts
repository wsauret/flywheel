import { Schema } from "effect";

/** How one session relates to another, in the order a listing shows them.
 *  Every schema and reader of a relation uses this one list. */
export const SESSION_RELATIONS = ["parent", "child", "sibling", "other"] as const;
export const SessionRelationSchema = Schema.Literals(SESSION_RELATIONS);
export type SessionRelation = typeof SessionRelationSchema.Type;

const ChatAttachmentSchema = Schema.Struct({ marker: Schema.String, mediaType: Schema.String, data: Schema.String, name: Schema.optionalKey(Schema.String) });
const ChatInvocationSchema = Schema.Struct({ label: Schema.String, args: Schema.optionalKey(Schema.String) });
export const ChatInputObjectSchema = Schema.Struct({
  text: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(ChatAttachmentSchema)),
  invocation: Schema.optionalKey(ChatInvocationSchema),
  submissionIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});

/** Durable user content, without transport dispatch correlation. Empty text permits attachment-only input. */
export const DurableFollowUpInputSchema = Schema.Struct({
  ...ChatInputObjectSchema.fields,
  origin: Schema.optionalKey(Schema.Literal("human")),
});
export type DurableFollowUpInput = typeof DurableFollowUpInputSchema.Type;
