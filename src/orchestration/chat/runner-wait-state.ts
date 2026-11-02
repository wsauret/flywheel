import type { TurnParkState } from "../../infra/agent-loop-events.js"
import type { AgentLoopMaintenance } from "../agent-runtime/agent-loop-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { AgentHost, AgentHostTurnLease } from "../runner/types.js"
import type { LiveRecipientState } from "../session/live-session-control.js"

const log = Log.create({ service: "chat" })

/** What a chat runner's turn waits for, the one record of it in memory:
 *  whether a turn runs that an interrupt would cut, and what a message from
 *  another session meets. The durable turn end is the record that outlives
 *  the runner; this state answers for the loop that holds the turn slot. */
export interface ChatWaitState {
  /** A stream stalled and handed the turn to the person. */
  readonly stalled: boolean
  stall(): void
  /** A person's message or Resume answered the stall. */
  clearStall(): void
  /** A turn runs that the runtime's interrupt would cut. */
  turnRunning(): boolean
  /** Whether the person must act before the next request: the stall, or the
   *  durable turn end that an interrupt or an unexpected exit recorded. */
  awaitsPerson(): Promise<boolean>
  /** Decides once, as a maintenance start takes the turn slot, whether the
   *  start waits for the person. A maintenance start, such as the hold a
   *  child's resume takes, runs no turn of its own and parks where the last
   *  turn ended, so its decision is its state from that moment, before its
   *  loop parks. */
  decideMaintenance(lease: AgentHostTurnLease): Promise<AgentLoopMaintenance>
  /** The decision of a maintenance start that holds the turn slot and has not
   *  settled yet. No interrupt has a turn to cut meanwhile, and a message
   *  waits for the decision to learn what it meets. */
  undecidedStart(): Promise<AgentLoopMaintenance> | undefined
  /** A logical turn started or the loop resumed from its park: a turn runs. */
  resumed(): void
  /** The loop parked as its `TurnParkedContext.park` states. */
  parked(state: TurnParkState): void
  /** The state a message meets from the loop that holds the turn slot. A
   *  loop parked with its turn answered is idle: a message wakes it into a
   *  new turn. A loop parked on its background work waits on that work: a
   *  message reaches its turn without a wake, unless the wake limit holds it.
   *  A loop parked after an interrupt or a stall waits for the person. */
  leasedState(): LiveRecipientState
}

export function createChatWaitState(input: {
  readonly host: Pick<AgentHost, "turnState" | "ownsTurn">
  readonly sessionId: string
  /** Whether the conversation's last turn ended by an interrupt or an
   *  unexpected exit, read from its durable turn end. */
  readonly readLastTurnWaitsForPerson: () => Promise<boolean>
}): ChatWaitState {
  // A stream that stalled hands the turn to the person: nothing produced may
  // restart it until a person's message or Resume. This is the reconnect
  // concern alone; an interrupt's wait lives in the parked loop's gate and,
  // with no runner, in the durable turn end.
  let stalled = false
  // How the loop that holds the turn slot parked, undefined while its turn
  // runs. `idle` answered its turn with nothing running for it, so the turn
  // is over and the runtime's interrupt has nothing to cut or record.
  // `waiting_on_work` waits on background work of its turn, which an
  // interrupt still cuts. `interrupted` waits for the person's Resume or
  // message: a message from another session folds into its history and
  // starts no request.
  let park: TurnParkState | undefined
  let undecidedMaintenance: Promise<AgentLoopMaintenance> | undefined

  /** The durable turn end is the one record of an interrupt or an unexpected
   *  exit that outlives the runner, so a restarted session waits for the
   *  person as a parked one does. A turn end the state Worker cannot read
   *  now proves nothing, so the conversation waits for the person: no
   *  background work starts a turn the person may have interrupted. */
  async function lastTurnWaitsForPerson(): Promise<boolean> {
    try {
      return await input.readLastTurnWaitsForPerson()
    } catch (error) {
      log.warn("the last turn end could not be read, so the committed notification waits for the person", { sessionId: input.sessionId, error: errorMessage(error) })
      return true
    }
  }
  const awaitsPerson = async (): Promise<boolean> => stalled || await lastTurnWaitsForPerson()

  return {
    get stalled() { return stalled },
    stall() { stalled = true },
    clearStall() { stalled = false },
    turnRunning: () => input.host.turnState === "active" && undecidedMaintenance === undefined && (park === undefined || park === "waiting_on_work"),
    awaitsPerson,
    decideMaintenance(lease) {
      const decision: Promise<AgentLoopMaintenance> = lastTurnWaitsForPerson().then((turnEndWaits) => {
        if (input.host.ownsTurn(lease)) park = stalled || turnEndWaits ? "interrupted" : undefined
        if (undecidedMaintenance === decision) undecidedMaintenance = undefined
        return { awaitsPerson: stalled || turnEndWaits, turnEndWaits }
      })
      undecidedMaintenance = decision
      return decision
    },
    undecidedStart: () => undecidedMaintenance,
    resumed() { park = undefined },
    parked(state) { park = state },
    leasedState: () => stalled ? "interrupted" : park ?? "running",
  }
}
