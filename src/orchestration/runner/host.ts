import { Deferred, Effect, Fiber } from "effect"
import { awaitWithAbortSignal, mergeAbortSignals } from "../../infra/abort.js"
import { probeLoopUnit } from "../../infra/event-loop-lag.js"
import { closeScopedAbortSignal, createScopedAbortSignal } from "../agent-runtime/scoped-abort-signal.js"
import { runAgentTurn } from "./agent-turn.js"
import { AgentTurnAborted } from "./agent-turn-types.js"
import type { AgentHost, AgentHostContextOptions, AgentHostOptions, AgentHostTurnLease } from "./types.js"
import type { Agent, AgentRunResult } from "../agent-runtime/types.js"

/** Owns context construction and one logical turn's shared recovery policy. */
export function createAgentHost<O = AgentHostContextOptions>(options: AgentHostOptions<O>): AgentHost<O> {
  let activeContext: Agent | null = null
  let activeTurn: Promise<AgentRunResult> | null = null
  let activeGeneration: ReturnType<typeof createScopedAbortSignal> | null = null
  interface ReservedTurn {
    readonly lease: AgentHostTurnLease
    readonly settled: Deferred.Deferred<void>
    readonly close: Effect.Effect<void>
  }
  interface RunningTurn extends ReservedTurn {
    readonly fiber: Fiber.Fiber<void>
  }
  let turnSlot: ReservedTurn | RunningTurn | null = null
  let turnContinuation: (() => void) | null = null

  const settle = (turn: ReservedTurn): void => { Effect.runSync(Deferred.succeed(turn.settled, undefined)) }
  const reserveTurn = (): AgentHostTurnLease | null => {
    if (turnSlot) return null
    const token = createScopedAbortSignal()
    turnSlot = { lease: { signal: token.signal }, settled: Deferred.makeUnsafe<void>(), close: closeScopedAbortSignal(token) }
    return turnSlot.lease
  }
  const ownsTurn = (lease: AgentHostTurnLease): boolean => turnSlot?.lease === lease
  const takeReservedTurn = (): AgentHostTurnLease | null => turnSlot && !("fiber" in turnSlot) ? turnSlot.lease : null
  const releaseTurn = (lease: AgentHostTurnLease): void => {
    const reserved = turnSlot
    if (!reserved || reserved.lease !== lease || "fiber" in reserved) return
    Effect.runSync(reserved.close)
    turnSlot = null
    settle(reserved)
  }
  const startTurn = (lease: AgentHostTurnLease, run: () => Promise<void>): void => {
    const reserved = turnSlot
    if (!reserved || reserved.lease !== lease || "fiber" in reserved) throw new Error("Runner host turn lease is not reserved")
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
  }
  const continueAfterTurn = (lease: AgentHostTurnLease, continuation: () => void): void => {
    if (!ownsTurn(lease)) throw new Error("Runner host does not own the turn continuation")
    if (turnContinuation) throw new Error("Runner host already has a turn continuation")
    turnContinuation = continuation
  }
  const interruptTurn = (): void => {
    const turn = turnSlot
    if (!turn || !("fiber" in turn)) return
    activeContext?.abort()
    Effect.runSync(turn.close)
    Effect.runFork(Fiber.interrupt(turn.fiber))
  }
  const settleTurn = async (): Promise<void> => {
    const observed = turnSlot
    if (observed) await Effect.runPromise(Deferred.await(observed.settled))
  }

  async function runTurn(turn: Parameters<AgentHost<O>["runTurn"]>[0]): Promise<AgentRunResult> {
    if (activeTurn) throw new Error("Runner host already has an active generation")
    const generation = createScopedAbortSignal()
    activeGeneration = generation
    const running = runAgentTurn({
      createContext: async (attempt, run) => {
        let contextOptions: O
        try {
          contextOptions = await awaitWithAbortSignal(
            Promise.resolve(turn.createContextOptions(attempt)),
            generation.signal,
          )
        } catch (error) {
          if (generation.signal.aborted) throw new AgentTurnAborted()
          throw error
        }
        if (generation.signal.aborted) throw new AgentTurnAborted()
        const context = options.createRunner({
          ...contextOptions,
          ...(attempt.requestContext ? { requestContext: attempt.requestContext } : {}),
          priorLLMCalls: run.priorLLMCalls,
          tally: run.tally,
        })
        activeContext = context
        try {
          turn.onContextCreated?.(context)
          return context
        } catch (error) {
          context.end()
          await context.done.catch(() => undefined)
          throw error
        }
      },
      onContextStarted: turn.onContextStarted,
      message: turn.message,
      onContextSettled: (context) => { if (activeContext === context) activeContext = null },
      resilience: {
        ...turn.resilience,
        signal: mergeAbortSignals(turn.resilience.signal, generation.signal),
      },
      ...(turn.classifyResult ? { classifyResult: turn.classifyResult } : {}),
      ...(turn.onAttemptFailure ? { onAttemptFailure: turn.onAttemptFailure } : {}),
    })
    activeTurn = running
    try {
      return await running
    } finally {
      probeLoopUnit("runner-teardown", "generation.close", () => {
        Effect.runSync(closeScopedAbortSignal(generation))
        if (activeGeneration === generation) activeGeneration = null
        if (activeTurn === running) {
          activeContext = null
          activeTurn = null
        }
      })
    }
  }

  const cancelActiveGeneration = (): boolean => {
    if (!activeTurn || !activeGeneration) return false
    Effect.runSync(closeScopedAbortSignal(activeGeneration))
    return true
  }
  const interruptGeneration = (): boolean => {
    if (activeContext) return activeContext.interruptGeneration?.() ?? false
    const turn = turnSlot
    if (!turn || turn.lease.signal.aborted) return cancelActiveGeneration()
    // With no loop to park, the lease is the authorization to continue.
    // Cancelling only this generation would still permit a teardown respawn.
    Effect.runSync(turn.close)
    cancelActiveGeneration()
    return true
  }
  const abortGeneration = (): void => {
    activeContext?.abort()
    cancelActiveGeneration()
  }

  return {
    get generationState() { return activeTurn ? "active" : "idle" },
    get turnState() { return turnSlot ? "active" : "idle" },
    get activeTurnLease() { return turnSlot?.lease ?? null },
    takeReservedTurn,
    releaseTurn,
    reserveTurn,
    ownsTurn,
    startTurn,
    interruptTurn,
    continueAfterTurn,
    runTurn,
    interruptGeneration,
    abortGeneration,
    settle: async () => { await Promise.all([activeTurn?.then(() => undefined, () => undefined), settleTurn()]) },
  }
}
