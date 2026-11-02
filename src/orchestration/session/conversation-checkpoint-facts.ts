import { Schema } from "effect";
import { defineFact } from "../../infra/event-registry.js";

export const CheckpointDecisionSchema = Schema.Struct({
  date: Schema.String.check(Schema.makeFilter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && !Number.isNaN(Date.parse(date)) || "Expected YYYY-MM-DD")),
  words: Schema.NonEmptyString,
  replaces: Schema.NullOr(Schema.NonEmptyString),
});

export const ConversationCheckpointSchema = Schema.Struct({
  designIntent: Schema.Struct({ text: Schema.String, approved: Schema.Boolean }),
  decisions: Schema.Array(CheckpointDecisionSchema),
  currentState: Schema.String,
  openQuestions: Schema.String,
  nextStep: Schema.String,
  relevantSkills: Schema.Array(Schema.Struct({ id: Schema.NonEmptyString, reason: Schema.NonEmptyString })),
  references: Schema.Array(Schema.NonEmptyString),
  workingNotes: Schema.String,
});

export type ConversationCheckpoint = typeof ConversationCheckpointSchema.Type;
export type CheckpointDecision = typeof CheckpointDecisionSchema.Type;

const ConversationCheckpointUpdatedFactSchema = defineFact({
  type: "conversation.checkpoint.updated",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    checkpoint: ConversationCheckpointSchema,
  }),
});

/** The approved parent intent that a subagent inherits at launch. Written
 *  once in the child's publication batch; the child's system prompt renders
 *  it in the session tier, so no reset removes it (ARCH-CONTEXT-018). */
const SessionIntentInheritedFactSchema = defineFact({
  type: "session.intent.inherited",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ intent: Schema.NonEmptyString }),
});

export const ConversationCheckpointFactSchemas = [ConversationCheckpointUpdatedFactSchema, SessionIntentInheritedFactSchema] as const;
export type ConversationCheckpointFact = typeof ConversationCheckpointUpdatedFactSchema.Type;
export const parseConversationCheckpointFact = Schema.decodeUnknownSync(ConversationCheckpointUpdatedFactSchema, { onExcessProperty: "error" });
export const parseSessionIntentInheritedFact = Schema.decodeUnknownSync(SessionIntentInheritedFactSchema, { onExcessProperty: "error" });
