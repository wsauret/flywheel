/**
 * The system prompt that a conversation fixed for its current context (ARCH-CONTEXT-044). It is recorded once for
 * each render, beside the conversation, so a restart, a resume, and a fork send the same bytes instead of rendering
 * the current inputs again. Only the newest render of a conversation applies, and only to the context whose opening
 * it names.
 */

import { createHash } from "node:crypto";
import { Schema } from "effect";
import { durableOwnerAggregate, type DurableOwner } from "../../infra/durable-owner.js";
import { defineFact } from "../../infra/event-registry.js";
import { createEventProjection, parseProjectionFact } from "../../infra/event-projection.js";
import type { AsyncEventReadSurface } from "../../infra/event-store-types.js";
import { heldProjection } from "../../infra/projection-registry.js";
import type { ConversationMessage } from "../agent-runtime/llm/types.js";
import type { SessionFactWriter } from "./session-fact-writer.js";

const PromptPartSchema = Schema.Struct({
  label: Schema.NonEmptyString,
  tier: Schema.Literals(["stable", "session", "conversation"]),
  change: Schema.Literals(["replace", "catalog", "hold"]),
  text: Schema.String,
});

const ConversationPromptFixedFactSchema = defineFact({
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
const parseConversationPromptFixedFact = Schema.decodeUnknownSync(ConversationPromptFixedFactSchema, { onExcessProperty: "error" });

/** One conversation's fixed prompt: the context it is fixed for, the identity it rendered for, and its parts. */
export type ConversationPromptBaseline = Omit<ConversationPromptFixedFact["payload"], "conversationId">;

/** The name of the context that `messages` hold: the hash of the content of its first message. A compaction opens
 *  the fresh context with a new first message. */
export function promptContextOpening(messages: readonly ConversationMessage[]): string {
  const first = messages[0];
  const content = first === undefined || first.kind === "assistant" || first.kind === "toolResult" ? "" : first.content;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** The fixed prompt of one conversation, which `owner`'s aggregate holds. */
export interface ConversationPromptBaselines {
  read(): Promise<ConversationPromptBaseline | undefined>;
  /** Records `baseline` as the conversation's fixed prompt; it replaces the one before it. */
  record(baseline: ConversationPromptBaseline): Promise<void>;
}

/** The latest fixed prompt of each conversation of `owner`, in one fold for the owner, so the conversations of one
 *  owner read its facts once. */
function promptBaselineProjection(reader: AsyncEventReadSurface, owner: DurableOwner) {
  const aggregateId = durableOwnerAggregate(owner);
  return heldProjection(reader, `conversation-prompt-baseline:${aggregateId}`, () => createEventProjection<{ readonly baselines: Map<string, ConversationPromptBaseline> }>(reader, {
    name: "conversation-prompt-baseline",
    aggregateId,
    factTypes: ["conversation.prompt.fixed"],
    initialState: () => ({ baselines: new Map() }),
    draft: (state) => ({ baselines: new Map(state.baselines) }),
    reduce(state, event) {
      const { conversationId, ...baseline } = parseProjectionFact(event, parseConversationPromptFixedFact).payload;
      state.baselines.set(conversationId, baseline);
      return state;
    },
  }));
}

/** The latest fixed prompt of `conversationId` in `owner`'s aggregate. Given `messages`, only a prompt fixed for the
 *  context that they hold, such as the captured branch of a fork. */
export async function readConversationPromptBaseline(reader: AsyncEventReadSurface, owner: DurableOwner, conversationId: string, messages?: readonly ConversationMessage[]): Promise<ConversationPromptBaseline | undefined> {
  const baseline = (await promptBaselineProjection(reader, owner).replay()).baselines.get(conversationId);
  return messages === undefined || baseline?.opening === promptContextOpening(messages) ? baseline : undefined;
}

/** The fact that records `baseline` as the fixed prompt of `conversationId`. A fork records its source's prompt for
 *  its own conversation, so it sends the bytes that its source sent. */
export function conversationPromptFixedFact(conversationId: string, baseline: ConversationPromptBaseline): ConversationPromptFixedFact {
  return parseConversationPromptFixedFact({ type: "conversation.prompt.fixed", version: 1, actor: "flywheel", payload: { conversationId, ...baseline } });
}

export function conversationPromptBaselines(reader: AsyncEventReadSurface, writer: SessionFactWriter, owner: DurableOwner, conversationId: string): ConversationPromptBaselines {
  return {
    read: () => readConversationPromptBaseline(reader, owner, conversationId),
    async record(baseline) {
      await writer.record(conversationPromptFixedFact(conversationId, baseline));
    },
  };
}
