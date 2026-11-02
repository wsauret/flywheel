import type { ChatInput } from "../../infra/chat-input.js"
import { messageSenderOf } from "../../infra/output-blocks.js"
import type { AgentHost, AgentHostTurnLease } from "../runner/types.js"
import type { OutputSession } from "../runner/output-session.js"
import { heldAtWakeLimit, type DeliveryOutcome, type LiveRecipientState } from "../session/live-session-control.js"
import type { ChatTurnMailbox } from "./turn-mailbox.js"
import type { ChatWaitState } from "./runner-wait-state.js"

/** One landing of input while no turn runs: whether it commits, and whether
 *  it starts its own turn. The chat runner owns the turn-slot sequence. */
export interface IdleLanding<T> {
  admit(waitsForPerson: boolean): { readonly result: T; readonly landing: "refuse" | "hold" | "wake" }
  commit(): Promise<string | null>
  wake(): void
}

/** The parts of a chat runner that a message from another session meets. */
export interface ChatMessageDeliveryPorts {
  readonly host: Pick<AgentHost, "turnState" | "activeTurnLease" | "reserveTurn">
  readonly mailbox: Pick<ChatTurnMailbox, "enqueueNextTurn" | "enqueueHeldMessage">
  readonly session: Pick<OutputSession, "pushUserMessage" | "flush">
  ended(): boolean
  /** What the runner's turn waits for. */
  readonly wait: Pick<ChatWaitState, "leasedState" | "awaitsPerson" | "undecidedStart">
  landWhileIdle(reservation: AgentHostTurnLease, landing: IdleLanding<DeliveryOutcome>): Promise<DeliveryOutcome>
  commitHeldMessage(input: ChatInput): Promise<string | null>
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

  return {
    /** The state a message would meet now, read without taking the turn slot. */
    async messageState(): Promise<LiveRecipientState> {
      for (let pending = ports.wait.undecidedStart(); pending; pending = ports.wait.undecidedStart()) await pending
      if (ports.ended()) return "at_rest"
      if (ports.host.activeTurnLease) return ports.wait.leasedState()
      if (ports.host.turnState === "active") return "running"
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
      if (ports.host.activeTurnLease) return enqueue(decide(ports.wait.leasedState()), input)
      const reservation = ports.host.reserveTurn()
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
