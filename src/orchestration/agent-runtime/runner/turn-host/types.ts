import type { AgentLoopWakeInput } from "../../../../infra/agent-loop-events.js"
import type { Agent, AgentOptions, AgentRunResult, OmitAgentOptions, RunnerToolSurfaces } from "../../types.js"
import type { RetryState } from "../../llm/retry-budget.js"
import type { ResilienceDeps } from "../agent-resilience.js"

export type AgentHostContextOptions = OmitAgentOptions<AgentOptions, "runtimeSurfaces"> & {
  runtimeSurfaces?: RunnerToolSurfaces
}

/** The host is generic over the context-options shape its path produces, so a
 *  path whose createRunner is the raw runner constructor (subagent dispatch)
 *  keeps RunnableAgentOptions' completion requirement through the host instead
 *  of erasing it to the loose hosted shape. */
export interface AgentHostOptions<O = AgentHostContextOptions> {
  createRunner: (options: O) => Agent
  /** Called by `interruptGeneration` when no model context can park the
   *  turn, such as during context preparation. The owner of a turn
   *  authorization that outlives one generation (the chat turn slot) closes
   *  it here, because cancelling only this generation would still permit a
   *  teardown respawn. Answers whether it closed one. */
  closeTurnWithoutContext?: () => boolean
}

interface AgentHostTurnOptions<O> {
  createContextOptions(attempt: RetryState): O | Promise<O>
  onContextCreated?: (context: Agent) => void
  onContextStarted?: (context: Agent, attempt: RetryState) => void
  message: string | AgentLoopWakeInput
  resilience: ResilienceDeps
  classifyResult?: (result: AgentRunResult) => AgentRunResult
  onAttemptFailure?: (result: AgentRunResult) => void | Promise<void>
}

/** One logical generation at a time and its shared recovery policy. A caller
 *  that continues across turns, such as a chat runner, keeps its own turn
 *  slot beside it. */
export interface AgentGeneration<O = AgentHostContextOptions> {
  readonly generationState: "active" | "idle"
  runTurn(options: AgentHostTurnOptions<O>): Promise<AgentRunResult>
  /** Interrupts current model work, including recovery between contexts. */
  interruptGeneration(): boolean
  /** Aborts current model work, including recovery between contexts. */
  abortGeneration(): void
  /** Settles after the active logical generation and all retry attempts end. */
  settle(): Promise<void>
}
