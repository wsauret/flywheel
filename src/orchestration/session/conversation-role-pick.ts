/**
 * The model and effort that an agent's conversation picked at its start for a role setting that names no concrete
 * model, such as a role with no saved model or a saved tier (ARCH-RUNTIME-082). The pick is recorded once, beside the
 * conversation, so every later run of the agent, also after a restart, keeps it until the person changes the setting.
 * A setting that names a concrete model records nothing: the setting itself is the agent's model.
 */

import { Schema } from "effect";
import { durableOwnerAggregate, type DurableOwner } from "../../infra/durable-owner.js";
import { defineFact } from "../../infra/event-registry.js";
import { createEventProjection, parseProjectionFact } from "../../infra/event-projection.js";
import type { AsyncEventReadSurface } from "../../infra/event-store-types.js";
import { heldProjection } from "../../infra/projection-registry.js";
import type { SessionFactWriter } from "./session-fact-writer.js";

/** The authored setting that a pick answers: the role and the fields that a person or a workflow authored for it. */
const RolePickSettingSchema = Schema.Struct({
  roleId: Schema.NonEmptyString,
  model: Schema.optionalKey(Schema.NonEmptyString),
  effort: Schema.optionalKey(Schema.NonEmptyString),
  defaultEffort: Schema.optionalKey(Schema.NonEmptyString),
});

const ConversationRolePickedFactSchema = defineFact({
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
const parseConversationRolePickedFact = Schema.decodeUnknownSync(ConversationRolePickedFactSchema, { onExcessProperty: "error" });

export type RolePickSetting = typeof RolePickSettingSchema.Type;
type RolePick = ConversationRolePickFact["payload"];

/** The identity of a setting, by which a pick applies only while its setting stays as it was. */
export function rolePickSettingKey(setting: RolePickSetting): string {
  return JSON.stringify([setting.roleId, setting.model ?? null, setting.effort ?? null, setting.defaultEffort ?? null]);
}

/** The latest pick of one conversation, which `owner`'s aggregate holds. */
export interface ConversationRolePicks {
  read(): Promise<RolePick | undefined>;
  /** Records `pick` as the conversation's pick; it replaces the pick before it. */
  record(pick: Omit<RolePick, "conversationId">): Promise<void>;
}

export function conversationRolePicks(reader: AsyncEventReadSurface, writer: SessionFactWriter, owner: DurableOwner, conversationId: string): ConversationRolePicks {
  const aggregateId = durableOwnerAggregate(owner);
  const projection = heldProjection(reader, `conversation-role-pick:${aggregateId}:${conversationId}`, () => createEventProjection<{ pick?: RolePick }>(reader, {
    name: "conversation-role-pick",
    aggregateId,
    factTypes: ["conversation.role.picked"],
    initialState: () => ({}),
    reduce(state, event) {
      const fact = parseProjectionFact(event, parseConversationRolePickedFact);
      return fact.payload.conversationId === conversationId ? { pick: fact.payload } : state;
    },
  }));
  return {
    read: async () => (await projection.replay()).pick,
    async record(pick) {
      await writer.record({ type: "conversation.role.picked", version: 1, actor: "flywheel", payload: { conversationId, ...pick } });
    },
  };
}
