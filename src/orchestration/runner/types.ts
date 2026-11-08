import type { AgentLoopWakeInput } from "../../infra/agent-loop-events.js"
import type { OutputProjectionEvent } from "../../infra/output/output-projection-events.js"
import type { Agent, AgentOptions, AgentRunResult, RunnerToolSurfaces } from "../agent-runtime/types.js"
import type { RetryState } from "../agent-runtime/llm/retry-budget.js"
import type { ResilienceDeps } from "../agent-runtime/agent-resilience.js"

export type AgentHostContextOptions = Omit<AgentOptions, "runtimeSurfaces"> & {
  runtimeSurfaces?: RunnerToolSurfaces
}

/** The host is generic over the context-options shape its path produces, so a
 *  path whose createRunner is the raw runner constructor (subagent dispatch)
 *  keeps RunnableAgentOptions' completion requirement through the host instead
 *  of erasing it to the loose hosted shape. */
export interface AgentHostOptions<O = AgentHostContextOptions> {
  createRunner: (options: O) => Agent
}

export interface AgentHostTurnLease {
  readonly signal: AbortSignal
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

export interface AgentHost<O = AgentHostContextOptions> {
  readonly generationState: "active" | "idle"
  readonly turnState: "active" | "idle"
  readonly activeTurnLease: AgentHostTurnLease | null
  reserveTurn(): AgentHostTurnLease | null
  takeReservedTurn(): AgentHostTurnLease | null
  releaseTurn(lease: AgentHostTurnLease): void
  ownsTurn(lease: AgentHostTurnLease): boolean
  startTurn(lease: AgentHostTurnLease, run: () => Promise<void>): void
  interruptTurn(): void
  continueAfterTurn(lease: AgentHostTurnLease, continuation: () => void): void
  runTurn(options: AgentHostTurnOptions<O>): Promise<AgentRunResult>
  /** Interrupts current model work, including recovery between contexts. */
  interruptGeneration(): boolean
  /** Aborts current model work, including recovery between contexts. */
  abortGeneration(): void
  /** Settles after the active logical generation and all retry attempts end. */
  settle(): Promise<void>
}
import type { ChatInputLike } from "../../infra/chat-input.js"
export interface Runner {
  readonly sessionId: string
  /** Projects an already durable event without recording it again. */
  applyProjectionEvent(event: OutputProjectionEvent): void
  abort(): void
  /** Cuts the running turn and any running tool call and hands the turn to
   *  the person: the one resumable cut. False when nothing runs. */
  interrupt(): boolean
  /** Continues the interrupted turn or step from where it stopped, with no
   *  new message; false when nothing is interrupted or the runner ended.
   *  `announce` is false after a planned replacement's unseen cut, so the
   *  continuation shows no Resumed row either. */
  resume(options: { readonly announce: boolean }): boolean
  dispose(): Promise<void>
  /** Takes the person's latest unread queued message back for their editor.
   *  Resolves with it only after its hold is retired, and null when nothing
   *  unread is queued. Rejects with the store's error when the hold cannot
   *  be retired, which leaves the message queued. */
  recallQueuedMessage(): Promise<ChatInputLike | null>
  compact(): Promise<boolean>
  /** Fire the combined learning review immediately (the /learn command). */
  learn?(): boolean
  /** Reload runtime config, auth, and model listing from disk. Optional;
   *  workflow runners that complete in one shot may omit it. */
  refreshDeps?(): Promise<void>
}
