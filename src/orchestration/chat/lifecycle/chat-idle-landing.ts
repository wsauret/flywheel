import type { AgentHost, AgentHostTurnLease } from "../../agent-runtime/runner/turn-host/types.js"
import type { ChatTurnMailbox } from "../turn-mailbox.js"
import type { ChatWaitState } from "../runner-wait-state.js"
import type { ChatQueuedInputRecall } from "./chat-queued-input-recall.js"

/** One landing of input while no turn runs: whether it commits, and whether
 *  it starts its own turn. The chat runner owns the turn-slot sequence. */
export interface IdleLanding<T> {
  admit(waitsForPerson: boolean): { readonly result: T; readonly landing: "refuse" | "hold" | "wake" }
  commit(): Promise<string | null>
  wake(): void
}

/** The parts of a chat runner that the turn-slot sequence of an idle
 *  landing uses. */
export interface ChatIdleLandingPorts {
  readonly host: Pick<AgentHost, "releaseTurn">
  readonly mailbox: Pick<ChatTurnMailbox, "observeUserInput">
  readonly wait: Pick<ChatWaitState, "awaitsPerson">
  readonly recalls: Pick<ChatQueuedInputRecall, "open">
  ended(): boolean
  onTreeFailure(error: unknown): void
  startQueuedInputTurn(): void
}

/** The one turn-slot sequence for input that lands in history while no
 *  turn runs: a background notification, or a message from another
 *  session that is already held in its cell. The caller holds the slot's
 *  reservation, so a Resume or a person's message that arrives meanwhile
 *  waits in the mailbox. `admit` reads whether the last turn waits for the
 *  person, as an interrupt, an unexpected exit, or a stall leaves it, and
 *  answers whether the input commits and whether it starts its own turn.
 *  After the commit, the sequence starts that turn, or the turn the
 *  mailbox now waits with, or releases the slot. No turn starts after the
 *  runner ended. A failed commit releases the slot and rejects. */
export function createChatIdleLanding(ports: ChatIdleLandingPorts) {
  const { host, mailbox, wait, recalls } = ports
  return async function landWhileIdle<T>(reservation: AgentHostTurnLease, landing: IdleLanding<T>): Promise<T> {
    const userInputArrived = mailbox.observeUserInput()
    const admission = landing.admit(await wait.awaitsPerson())
    if (admission.landing === "refuse") {
      host.releaseTurn(reservation)
      return admission.result
    }
    try {
      await landing.commit()
    } catch (err) {
      host.releaseTurn(reservation)
      ports.onTreeFailure(err)
      throw err
    }
    // The decision reads the queue as the open recall leaves it. The
    // reservation stays held, so a send meanwhile still waits in the mailbox.
    if (recalls.open) await recalls.open
    // The one ended check after the last await: the runner can end during
    // the commit or the recall, and no turn starts after it ended.
    if (ports.ended()) host.releaseTurn(reservation)
    else if (admission.landing === "wake") landing.wake()
    else if (userInputArrived()) ports.startQueuedInputTurn()
    else host.releaseTurn(reservation)
    return admission.result
  }
}
