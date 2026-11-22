import { Schema } from "effect"
import type { HeadlessChatOutcome } from "./headless-chat.js"
import { workspaceDomainCursor } from "./runtime-ui-protocol-types.js"

/** Asks whether the work that a chat owns has ended: the chat's turn and
 *  every session of its launch tree, not other chats of the project
 *  (PI-AGENT-074). The runtime answers at once and never waits for the work. */
export const ChatSettlementQuerySchema = Schema.Struct({ type: Schema.Literal("chatSettlement"), sessionId: Schema.NonEmptyString })
export type ChatSettlementQuery = typeof ChatSettlementQuerySchema.Type

/** The agent failure kinds that end a turn. An abort is a stop that a caller
 *  asked for, so it ends no turn. */
const TurnFailureKindSchema = Schema.Literals([
  "local_persistence_error", "context_overflow", "output_overflow", "api_error",
  "model_unavailable", "transient_disconnect", "stream_stalled", "api_overloaded",
])

/** How the last turn of a chat ended: its model answered, the provider
 *  refused the conversation content, or the run failed with `failure`. */
export const ChatTurnEndingSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("completed") }),
  Schema.Struct({ kind: Schema.Literal("refused") }),
  Schema.Struct({ kind: Schema.Literal("failed"), failure: TurnFailureKindSchema }),
])
export type ChatTurnEnding = typeof ChatTurnEndingSchema.Type

const HeadlessChatOutcomeSchema: Schema.Codec<HeadlessChatOutcome> = Schema.Literals(["complete", "input_required", "incomplete", "failed"])

/** `busy` while work that the chat owns runs. A settled answer names the
 *  outcome, and `turnEnding` names how the chat's last turn ended when a turn
 *  ended since the chat last accepted input. The chat's totals state every
 *  usage that the work recorded before a settled answer is sent
 *  (ARCH-RUNTIME-080). */
export const ChatSettlementResultSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("busy") }),
  Schema.Struct({ state: HeadlessChatOutcomeSchema, turnEnding: Schema.optionalKey(ChatTurnEndingSchema) }),
])
export type ChatSettlementResult = typeof ChatSettlementResultSchema.Type

/** A wake with no content: the work that some chat owns may have changed, so
 *  a client that waits on a chat's settlement asks again. */
export interface SettlementPatchPayload { readonly kind: "settlement.changed" }
export const SettlementPatchPayloadSchema: Schema.Codec<SettlementPatchPayload> = Schema.Struct({ kind: Schema.Literal("settlement.changed") })

export function settlementCursor() {
  return workspaceDomainCursor("settlement")
}
