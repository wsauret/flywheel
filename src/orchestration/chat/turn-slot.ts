import { Deferred, Effect, type Fiber } from "effect"
import { closeScopedAbortSignal, createScopedAbortSignal } from "../agent-runtime/loop/turn/scoped-abort-signal.js"

/** The authorization of one chat turn. Its signal aborts when the turn is
 *  interrupted or its reservation is released. */
export interface ChatTurnLease {
  readonly signal: AbortSignal
}

/** The chat runner's one turn slot, which it reserves, starts, and continues
 *  across the person's messages. The model generation of a turn runs on the
 *  runner's `AgentGeneration`; the slot holds the authorization to continue. */
export interface ChatTurnSlot {
  readonly turnState: "active" | "idle"
  readonly activeTurnLease: ChatTurnLease | null
  reserveTurn(): ChatTurnLease | null
  takeReservedTurn(): ChatTurnLease | null
  releaseTurn(lease: ChatTurnLease): void
  ownsTurn(lease: ChatTurnLease): boolean
  startTurn(lease: ChatTurnLease, run: () => Promise<void>): void
  continueAfterTurn(lease: ChatTurnLease, continuation: () => void): void
  /** Closes the lease of the turn in the slot, unless it is closed already,
   *  and answers whether it closed one. With no loop to park, the lease is
   *  the authorization to continue, so an interrupt closes it
   *  (`AgentHostOptions.closeTurnWithoutContext`). */
  closeLiveTurn(): boolean
  /** Settles after the turn in the slot, reserved or running, ends. */
  settle(): Promise<void>
}

export function createChatTurnSlot(): ChatTurnSlot {
  interface ReservedTurn {
    readonly lease: ChatTurnLease
    readonly settled: Deferred.Deferred<void>
    readonly close: Effect.Effect<void>
  }
  interface RunningTurn extends ReservedTurn {
    readonly fiber: Fiber.Fiber<void>
  }
  let turnSlot: ReservedTurn | RunningTurn | null = null
  let turnContinuation: (() => void) | null = null

  const settle = (turn: ReservedTurn): void => { Effect.runSync(Deferred.succeed(turn.settled, undefined)) }
  const ownsTurn = (lease: ChatTurnLease): boolean => turnSlot?.lease === lease

  return {
    get turnState() { return turnSlot ? "active" : "idle" },
    get activeTurnLease() { return turnSlot?.lease ?? null },
    reserveTurn() {
      if (turnSlot) return null
      const token = createScopedAbortSignal()
      turnSlot = { lease: { signal: token.signal }, settled: Deferred.makeUnsafe<void>(), close: closeScopedAbortSignal(token) }
      return turnSlot.lease
    },
    takeReservedTurn: () => turnSlot && !("fiber" in turnSlot) ? turnSlot.lease : null,
    releaseTurn(lease) {
      const reserved = turnSlot
      if (!reserved || reserved.lease !== lease || "fiber" in reserved) return
      Effect.runSync(reserved.close)
      turnSlot = null
      settle(reserved)
    },
    ownsTurn,
    startTurn(lease, run) {
      const reserved = turnSlot
      if (!reserved || reserved.lease !== lease || "fiber" in reserved) throw new Error("Chat turn lease is not reserved")
      const fiber = Effect.runFork(Effect.promise(run).pipe(
        Effect.ensuring(reserved.close),
        Effect.ensuring(Effect.sync(() => {
          if (turnSlot?.lease === lease) turnSlot = null
          settle(reserved)
          const continuation = turnContinuation
          turnContinuation = null
          continuation?.()
        })),
      ))
      turnSlot = { ...reserved, fiber }
    },
    continueAfterTurn(lease, continuation) {
      if (!ownsTurn(lease)) throw new Error("Chat turn slot does not own the turn continuation")
      if (turnContinuation) throw new Error("Chat turn slot already has a turn continuation")
      turnContinuation = continuation
    },
    closeLiveTurn() {
      const turn = turnSlot
      if (!turn || turn.lease.signal.aborted) return false
      Effect.runSync(turn.close)
      return true
    },
    async settle() {
      const observed = turnSlot
      if (observed) await Effect.runPromise(Deferred.await(observed.settled))
    },
  }
}
