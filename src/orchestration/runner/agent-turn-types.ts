import type { AgentLoopWakeInput } from "../../infra/agent-loop-events.js"
import type { ResilienceDeps } from "../agent-runtime/agent-resilience.js"
import type { Agent, AgentRunResult } from "../agent-runtime/types.js"
import type { RetryState } from "../agent-runtime/llm/retry-budget.js"
import type { AgentRunTally } from "../agent-runtime/agent-loop-state.js"

/** Thrown by createContext to signal that the turn is stale and should abort. */
export class AgentTurnAborted extends Error {
  constructor() { super("Agent turn aborted") }
}

/** The budget accounting of one run of a turn, which the turn owns across the
 *  runs that recovery starts (ARCH-RUNTIME-003). */
interface AgentTurnRun {
  /** The model calls that the earlier runs of this turn started. */
  readonly priorLLMCalls: number
  /** The run's counts. The runner keeps them current, so the turn reads them
   *  also when the run rejects. */
  readonly tally: AgentRunTally
}

export interface AgentTurnOptions {
  createContext(attempt: RetryState, run: AgentTurnRun): Agent | Promise<Agent>
  message: string | AgentLoopWakeInput
  resilience: ResilienceDeps
  onContextStarted?: (context: Agent, attempt: RetryState) => void
  onContextSettled?: (context: Agent) => void
  classifyResult?: (result: AgentRunResult) => AgentRunResult
  /** Awaited before resilience re-runs an attempt: terminal failures and
   *  model-reassignment rebuilds. Callers flush pending conversation-tree
   *  writes here so the next attempt's context read is coherent. */
  onAttemptFailure?: (result: AgentRunResult) => void | Promise<void>
}
