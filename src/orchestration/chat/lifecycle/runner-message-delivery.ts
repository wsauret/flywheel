import type { ChatInput } from "../../../infra/substrate/events/chat-input.js"
import { messageSenderOf } from "../../../infra/substrate/events/output-blocks.js"
import type { OutputSession } from "../../session-store/output-session.js"
import { heldAtWakeLimit, type DeliveryOutcome, type LiveRecipientState } from "../../session/message-disposition.js"
import type { ChatTurnMailbox } from "../turn-mailbox.js"
import type { ChatWaitState } from "../runner-wait-state.js"
import type { ChatTurnLease, ChatTurnSlot } from "../turn-slot.js"
import type { IdleLanding } from "./chat-idle-landing.js"

/** The parts of a chat runner that a message from another session meets. */
export interface ChatMessageDeliveryPorts {
  readonly turns: Pick<ChatTurnSlot, "turnState" | "activeTurnLease" | "reserveTurn">
  readonly mailbox: Pick<ChatTurnMailbox, "enqueueNextTurn" | "enqueueHeldMessage">
  readonly session: Pick<OutputSession, "pushUserMessage" | "flush">
  ended(): boolean
  /** What the runner's turn waits for. */
  readonly wait: Pick<ChatWaitState, "leasedState" | "awaitsPerson" | "undecidedStart">
  landWhileIdle(reservation: ChatTurnLease, landing: IdleLanding<DeliveryOutcome>): Promise<DeliveryOutcome>
  commitHeldMessage(input: ChatInput): Promise<string | null>
  /** Whether a question waits for the person (`holdsForQuestion`). */
  awaitsAnswer(): Promise<boolean>
  /** Whether the turn that holds the slot is parked on a question for the
   *  person, read in the caller's tick. */
  leasedQuestionWaits(): boolean
  wake(input: ChatInput): void
}

/** How a chat runner takes a message from another session, and the state
 *  that such a message meets now. */
export function createChatMessageDelivery(ports: ChatMessageDeliveryPorts) {
  /** Shows the message as its row. A row the loop has yet to read stays
   *  queued until the loop's user echo sends it. */
  function show(input: ChatInput, queued: boolean): void {
    const from = messageSenderOf(input.producer)
    const entryId = input.dispatchIds?.[0]
    ports.session.pushUserMessage(input.text, Date.now(), { entryId, dispatchIds: input.dispatchIds, queued, injected: false, ...(from ? { from } : {}) })
    ports.session.flush()
  }

  /** Hands the message to the loop that holds the turn slot. A message the
   *  wake hop limit holds enters history without starting a turn. */
  function enqueue(outcome: DeliveryOutcome, input: ChatInput): DeliveryOutcome {
    if (outcome.status === "refused") return outcome
    if (heldAtWakeLimit(outcome)) ports.mailbox.enqueueHeldMessage(input)
    else ports.mailbox.enqueueNextTurn(input)
    show(input, true)
    return outcome
  }

  /** The state a message meets while a turn holds the slot: a question
   *  that waits holds it, also under a parked turn (PI-INTERACTION-050). */
  function leasedState(): LiveRecipientState {
    return ports.leasedQuestionWaits() ? "awaiting_answer" : ports.wait.leasedState()
  }

  return {
    /** The state a message would meet now, read without taking the turn slot. */
    async messageState(): Promise<LiveRecipientState> {
      for (let pending = ports.wait.undecidedStart(); pending; pending = ports.wait.undecidedStart()) await pending
      if (ports.ended()) return "at_rest"
      if (ports.turns.activeTurnLease) return leasedState()
      if (ports.turns.turnState === "active") return "running"
      if (await ports.awaitsAnswer()) return "awaiting_answer"
      return await ports.wait.awaitsPerson() ? "interrupted" : "idle"
    },

    /** Takes one accepted message, already held in its cell. A running turn
     *  reads it at its next drain, and so does a turn parked on its
     *  background work unless `decide` holds it; a turn parked after an
     *  interrupt or a stall folds it into history and waits for the person.
     *  An idle runner commits it first and starts a turn only when `decide`
     *  allows a wake; a held message lands in history for the next turn. It
     *  never counts as the person's turn and never clears the stall. */
    async deliverHeldMessage(input: ChatInput, decide: (state: LiveRecipientState) => DeliveryOutcome): Promise<DeliveryOutcome> {
      for (let pending = ports.wait.undecidedStart(); pending; pending = ports.wait.undecidedStart()) await pending
      if (ports.ended()) return decide("at_rest")
      if (ports.turns.activeTurnLease) return enqueue(decide(leasedState()), input)
      // Behind a waiting question the message waits in the mailbox, as
      // behind a parked ask, and its sender is told it is held.
      if (await ports.awaitsAnswer()) return enqueue(decide("awaiting_answer"), input)
      const reservation = ports.turns.reserveTurn()
      if (!reservation) return enqueue(decide("running"), input)
      const outcome = await ports.landWhileIdle(reservation, {
        admit: (waits) => {
          const admitted = decide(waits ? "interrupted" : "idle")
          return { result: admitted, landing: admitted.status === "refused" ? "refuse" : admitted.status === "delivered" && admitted.startsTurn ? "wake" : "hold" }
        },
        commit: () => ports.commitHeldMessage(input),
        wake: () => ports.wake(input),
      })
      // The commit put the message in history, so its row is not queued.
      if (outcome.status !== "refused") show(input, false)
      return outcome
    },
  }
}
