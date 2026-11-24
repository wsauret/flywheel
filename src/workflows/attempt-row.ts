import { Schema } from "effect";
import type { AttemptRow } from "./view/types.js";

export const AttemptStatusSchema = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("running"),
  Schema.Literal("completed"),
  Schema.Literal("blocked"),
  Schema.Literal("failed"),
  Schema.Literal("skipped"),
]);

export const BriefPersonaSlotSchema = Schema.Struct({
  role: Schema.String,
  personas: Schema.mutable(Schema.Array(Schema.String)),
});

/** One attempt of an agent of the workflow, as the view rows record it. */
export const AttemptRowSchema: Schema.Codec<AttemptRow> = Schema.Struct({
  id: Schema.String,
  definitionId: Schema.NonEmptyString,
  briefId: Schema.NonEmptyString,
  workflowDefinitionId: Schema.NonEmptyString,
  name: Schema.String,
  status: AttemptStatusSchema,
  description: Schema.optionalKey(Schema.String),
  item: Schema.optionalKey(Schema.Unknown),
  subagents: Schema.optionalKey(Schema.Array(BriefPersonaSlotSchema)),
  writes: Schema.Array(Schema.String),
  lastConversationId: Schema.optionalKey(Schema.String),
  resumeRevertCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  startedAt: Schema.optionalKey(Schema.Number),
  completedAt: Schema.optionalKey(Schema.Number),
  toolUses: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
