import type { TurnParkState } from "../../infra/substrate/events/agent-loop-events.js"
import type { SessionRelation } from "../../infra/substrate/events/chat-input-schema.js"

/** The state of a live recipient at the moment its control takes a message.
 *  A control with no runner attached is at rest. A session of any kind whose
 *  loop answered its turn and parks while its background work runs is
 *  `waiting_on_work`: a message reaches its turn without a wake, but like an
 *  idle session it has no model request in flight that would bound a chain
 *  of messages. */
export type LiveRecipientState = "running" | TurnParkState | "between_steps" | "at_rest" | "handing_off"

/** What one message delivery did. `held` keeps the message for a later
 *  turn; a live session that holds a message takes it into its history and
 *  starts no request for it. `confirmedSubmissionIds` acknowledges messages
 *  that an agent view of a workflow shows, since a workflow has no
 *  transcript. */
export type DeliveryOutcome =
  | { readonly status: "delivered"; readonly startsTurn: boolean; readonly confirmedSubmissionIds?: readonly string[]; readonly inTranscript?: boolean }
  | { readonly status: "held"; readonly reason: "interrupted" | "no_reader" | "wake_limit"; readonly confirmedSubmissionIds?: readonly string[] }
  | { readonly status: "refused"; readonly reason: "settled" | "deleted" | "not_found" | "self" | "handing_off" }

/** The state of a recipient as delivery reads it. */
export type RecipientState = LiveRecipientState | "planned_cut" | "settled" | "deleted" | "not_found"

/** How a session reads to a caller of `list_sessions`. */
export type SessionListState = "running" | "handing_off" | "idle" | "interrupted" | "closed" | "settled"

/** How a session list reads a recipient state, or nothing for a session
 *  that is gone. */
export function listState(state: RecipientState): SessionListState | undefined {
  switch (state) {
    case "running":
    case "waiting_on_work":
    case "between_steps":
    case "planned_cut": return "running"
    case "handing_off": return "handing_off"
    case "idle": return "idle"
    case "interrupted": return "interrupted"
    case "at_rest": return "closed"
    case "settled": return "settled"
    case "deleted":
    case "not_found": return undefined
  }
}

/** A peer chain at this hop cannot wake an idle or waiting recipient. */
const WAKE_HOP_LIMIT = 5

/** Decides delivery from recipient state and producer provenance.
 * Parent-child messages are exempt from the peer wake limit. */
export function messageDisposition(input: {
  readonly state: RecipientState
  readonly origin: "human" | "session"
  readonly hop: number
  readonly self: boolean
  readonly relation?: SessionRelation
}): DeliveryOutcome {
  const { state, origin } = input
  if (state === "deleted" || state === "not_found") return { status: "refused", reason: state }
  if (origin === "session" && input.self) return { status: "refused", reason: "self" }
  switch (state) {
    case "settled": return { status: "refused", reason: "settled" }
    case "handing_off": return { status: "refused", reason: "handing_off" }
    case "running":
    case "planned_cut":
    case "between_steps": return { status: "delivered", startsTurn: false }
    case "idle":
    case "waiting_on_work":
      return origin === "session" && input.relation !== "child" && input.relation !== "parent" && input.hop >= WAKE_HOP_LIMIT
        ? { status: "held", reason: "wake_limit" }
        : { status: "delivered", startsTurn: state === "idle" }
    case "interrupted": return { status: "held", reason: "interrupted" }
    case "at_rest": return { status: "held", reason: "no_reader" }
  }
}

/** Whether a live loop takes a message with this outcome as held: the
 *  message folds into the loop's history and starts no turn. A message held
 *  behind an interrupt needs no mark, because its parked loop already waits
 *  for the person. */
export function heldAtWakeLimit(outcome: DeliveryOutcome): boolean {
  return outcome.status === "held" && outcome.reason === "wake_limit"
}
