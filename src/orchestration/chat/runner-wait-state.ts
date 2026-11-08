import type { TurnParkState } from "../../infra/agent-loop-events.js"
import type { AgentLoopMaintenance } from "../agent-runtime/agent-loop-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { AgentHost, AgentHostTurnLease } from "../runner/types.js"
import type { LiveRecipientState } from "../session/live-session-control.js"
import { isRuntimeInterruption, type ControlInterruption, type TurnInterruption } from "../session/conversation/turn-end-record.js"

const log = Log.create({ service: "chat" })

/** Who cut the turn that holds the turn slot, and what the cut left of it.
 *  `interrupted`: a person's interrupt cut its generation, and its loop
 *  parks for them; their message or Resume continues the same turn.
 *  `aborted`: the runtime's stop ended its run, which never runs again;
 *  `by` names the last turn end recorded over it, the runtime's own or a
 *  person's that queued behind it (`ChatControls.interruptPlannedCut`). */
export type TurnCut =
  | { readonly kind: "interrupted"; readonly by: ControlInterruption }
  | { readonly kind: "aborted"; readonly by: TurnInterruption }

/** One turn of the slot, as its loop and its interrupts report it. */
interface SlotTurn {
  /** How its loop parked, undefined while the turn runs. */
  park: TurnParkState | undefined
  /** Who cut it, undefined while no one has. */
  cut: TurnCut | undefined
}

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
  /** A turn runs that the runtime's interrupt would cut: it holds the slot,
   *  no one cut it, and its loop runs or waits on its background work. */
  turnRunning(): boolean
  /** Who cut the turn that holds the slot; undefined with no turn in the
   *  slot, or none that anyone cut. */
  turnCut(): TurnCut | undefined
  /** Someone cut the turn that holds the slot: a person's interrupt, the
   *  runtime's abort, or a person's turn end recorded over that abort. A
   *  cut stays the turn's: a turn that starts later holds a new lease and
   *  starts uncut. With no turn in the slot, nothing runs to cut. */
  cut(by: TurnInterruption): void
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
  /** A logical turn started or the loop resumed from its park: a turn runs,
   *  and a person's cut of it is answered. */
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
  readonly host: Pick<AgentHost, "activeTurnLease" | "ownsTurn">
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
  // The state of each turn, keyed by the lease that the slot holds for it,
  // so a turn starts as running and uncut: no writer resets a past turn's
  // park or cut for the next one. A park `idle` answered its turn with
  // nothing running for it, so the turn is over and the runtime's interrupt
  // has nothing to cut or record. `waiting_on_work` waits on background
  // work of its turn, which an interrupt still cuts. `interrupted` waits for
  // the person's Resume or message: a message from another session folds
  // into its history and starts no request.
  const turns = new WeakMap<AgentHostTurnLease, SlotTurn>()
  function slotTurn(): SlotTurn | undefined {
    const lease = input.host.activeTurnLease
    if (lease === null) return undefined
    let turn = turns.get(lease)
    if (turn === undefined) turns.set(lease, turn = { park: undefined, cut: undefined })
    return turn
  }
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
    turnRunning() {
      const turn = slotTurn()
      return turn !== undefined && turn.cut === undefined && undecidedMaintenance === undefined && (turn.park === undefined || turn.park === "waiting_on_work")
    },
    turnCut: () => slotTurn()?.cut,
    cut(by) {
      const turn = slotTurn()
      if (turn === undefined) return
      if (turn.cut?.kind === "aborted" || isRuntimeInterruption(by)) turn.cut = { kind: "aborted", by }
      else turn.cut = { kind: "interrupted", by }
    },
    awaitsPerson,
    decideMaintenance(lease) {
      const decision: Promise<AgentLoopMaintenance> = lastTurnWaitsForPerson().then((turnEndWaits) => {
        const turn = input.host.ownsTurn(lease) ? slotTurn() : undefined
        if (turn) turn.park = stalled || turnEndWaits ? "interrupted" : undefined
        if (undecidedMaintenance === decision) undecidedMaintenance = undefined
        return { awaitsPerson: stalled || turnEndWaits, turnEndWaits }
      })
      undecidedMaintenance = decision
      return decision
    },
    undecidedStart: () => undecidedMaintenance,
    resumed() {
      const turn = slotTurn()
      if (turn === undefined) return
      turn.park = undefined
      // Only a person's cut continues: the runtime's abort ended the run.
      if (turn.cut?.kind === "interrupted") turn.cut = undefined
    },
    parked(state) {
      const turn = slotTurn()
      if (turn) turn.park = state
    },
    leasedState: () => stalled ? "interrupted" : slotTurn()?.park ?? "running",
  }
}
