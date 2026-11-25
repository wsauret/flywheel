import { Effect } from "effect"
import { awaitWithAbortSignal, mergeAbortSignals } from "../../../../infra/timing/abort.js"
import { probeLoopUnit } from "../../../../infra/diagnostics/event-loop-lag.js"
import { closeScopedAbortSignal, createScopedAbortSignal } from "../../loop/turn/scoped-abort-signal.js"
import { runAgentTurn } from "./agent-turn.js"
import { AgentTurnAborted } from "./agent-turn-types.js"
import type { AgentGeneration, AgentHostContextOptions, AgentHostOptions } from "./types.js"
import type { Agent, AgentRunResult } from "../../types.js"

/** Owns context construction and one logical turn's shared recovery policy. */
export function createAgentGeneration<O = AgentHostContextOptions>(options: AgentHostOptions<O>): AgentGeneration<O> {
  let activeContext: Agent | null = null
  let activeTurn: Promise<AgentRunResult> | null = null
  let activeGeneration: ReturnType<typeof createScopedAbortSignal> | null = null

  async function runTurn(turn: Parameters<AgentGeneration<O>["runTurn"]>[0]): Promise<AgentRunResult> {
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
          context.abort()
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
    const closedTurn = options.closeTurnWithoutContext?.() ?? false
    const cancelled = cancelActiveGeneration()
    return closedTurn || cancelled
  }
  const abortGeneration = (): void => {
    activeContext?.abort()
    cancelActiveGeneration()
  }

  return {
    get generationState() { return activeTurn ? "active" : "idle" },
    runTurn,
    interruptGeneration,
    abortGeneration,
    settle: async () => { await activeTurn?.then(() => undefined, () => undefined) },
  }
}
