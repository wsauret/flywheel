/**
 * The model and effort that an agent's conversation picked at its start for a role setting that names no concrete
 * model, such as a role with no saved model or a saved tier (ARCH-RUNTIME-082). The pick is recorded once, beside the
 * conversation, so every later run of the agent, also after a restart, keeps it until the person changes the setting.
 * A setting that names a concrete model records nothing: the setting itself is the agent's model.
 */

import { Schema } from "effect";
import { durableOwnerAggregate, type DurableOwner } from "../../../infra/durable-owner.js";
import { createEventProjection, parseProjectionFact } from "../../../infra/projection/event-projection.js";
import type { AsyncEventReadSurface } from "../../../infra/store/event-store-types.js";
import { heldProjection } from "../../../infra/projection/projection-registry.js";
import type { SessionFactWriter } from "../persistence/session-fact-writer.js";
import { ConversationRolePickedFactSchema, type ConversationRolePickFact, type RolePickSetting } from "../persistence/conversation-role-pick-facts.js";

const parseConversationRolePickedFact = Schema.decodeUnknownSync(ConversationRolePickedFactSchema, { onExcessProperty: "error" });

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
