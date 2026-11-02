import { errorMessage } from "../../infra/error-message.js"
import { PersistenceWriteRefused } from "../../infra/event-store-types.js"
import { isAbortError } from "../../infra/abort.js"
import { probeLoopUnit } from "../../infra/event-loop-lag.js"
import type { AgentTurnOptions } from "./agent-turn-types.js"
import { AgentTurnAborted } from "./agent-turn-types.js"
import { runWithResilience } from "../agent-runtime/agent-resilience.js"
import { createAgentRunTally } from "../agent-runtime/agent-loop-state.js"
import { HandoffCorrectionExhausted } from "../agent-runtime/errors.js"
import { failureTerminal, type Agent, type AgentRunResult } from "../agent-runtime/types.js"

/** Runs one logical turn: its first run and every run that recovery starts.
 *  The turn's model-call budget continues across those runs, and only a new
 *  turn, such as an explicit Resume, starts it again (ARCH-RUNTIME-003). */
export async function runAgentTurn(opts: AgentTurnOptions): Promise<AgentRunResult> {
  let priorLLMCalls = 0
  const runAttempt: Parameters<typeof runWithResilience>[0] = async (attempt) => {
    let ctx: Agent | undefined
    const tally = createAgentRunTally()
    let contextSettled = false
    const relinquishContext = (): void => {
      if (!ctx || contextSettled) return
      contextSettled = true
      opts.onContextSettled?.(ctx)
    }
    try {
      ctx = await opts.createContext(attempt, { priorLLMCalls, tally })
      ctx.send(opts.message)
      opts.onContextStarted?.(ctx, attempt)
      const result = await ctx.done.catch((err: unknown): AgentRunResult => {
        if (isAbortError(err)) return { durationMs: 0, servedRequests: 0, terminal: { kind: "aborted" } }
        throw err
      })
      relinquishContext()
      const classified = opts.classifyResult ? opts.classifyResult(result) : result
      if (failureTerminal(classified.terminal)) await opts.onAttemptFailure?.(classified)
      return classified
    } catch (err) {
      if (err instanceof PersistenceWriteRefused) return { durationMs: 0, servedRequests: 0, terminal: { kind: "local_persistence_error", error: err } }
      if (err instanceof AgentTurnAborted) {
        return { durationMs: 0, servedRequests: 0, terminal: { kind: "aborted" } }
      }
      // An exhausted handoff correction is a broken handoff contract, not a
      // failed request: as api_error it would read as the provider rejecting
      // the request.
      if (err instanceof HandoffCorrectionExhausted) throw err
      // A local fault, such as a store error, can clear, so a later run may
      // try again. The tally keeps the progress of a run that rejected.
      return { durationMs: 0, servedRequests: tally.served, terminal: { kind: "api_error", message: errorMessage(err), recovery: { kind: "retry" } } }
    } finally {
      priorLLMCalls += tally.requests
      if (ctx) {
        const context = ctx
        try { probeLoopUnit("runner-teardown", "context.end", () => context.end()) }
        finally { relinquishContext() }
      }
    }
  }

  return runWithResilience(runAttempt, {
    ...opts.resilience,
  })
}
