import { Schema } from "effect";
import { defineFact } from "../../../infra/event-registry.js";

const PromptPartSchema = Schema.Struct({
  label: Schema.NonEmptyString,
  tier: Schema.Literals(["stable", "session", "conversation"]),
  change: Schema.Literals(["replace", "catalog", "hold"]),
  text: Schema.String,
});

export const ConversationPromptFixedFactSchema = defineFact({
  type: "conversation.prompt.fixed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    /** The context that the prompt is fixed for (`promptContextOpening`). */
    opening: Schema.NonEmptyString,
    /** The code, the model, and the tool surface that the prompt rendered for. */
    identity: Schema.NonEmptyString,
    parts: Schema.Array(PromptPartSchema),
  }),
});

export const ConversationPromptBaselineFactSchemas = [ConversationPromptFixedFactSchema] as const;
export type ConversationPromptFixedFact = typeof ConversationPromptFixedFactSchema.Type;
