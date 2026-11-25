import { Schema } from "effect";
import { defineFact } from "../../../infra/substrate/facts/event-registry.js";

/** The authored setting that a pick answers: the role and the fields that a person or a workflow authored for it. */
const RolePickSettingSchema = Schema.Struct({
  roleId: Schema.NonEmptyString,
  model: Schema.optionalKey(Schema.NonEmptyString),
  effort: Schema.optionalKey(Schema.NonEmptyString),
  defaultEffort: Schema.optionalKey(Schema.NonEmptyString),
});

export const ConversationRolePickedFactSchema = defineFact({
  type: "conversation.role.picked",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NonEmptyString,
    setting: RolePickSettingSchema,
    model: Schema.NonEmptyString,
    effort: Schema.NonEmptyString,
  }),
});

export const ConversationRolePickFactSchemas = [ConversationRolePickedFactSchema] as const;
export type ConversationRolePickFact = typeof ConversationRolePickedFactSchema.Type;
export type RolePickSetting = typeof RolePickSettingSchema.Type;
