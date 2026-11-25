import type { AgentLoopWakeInput } from "../../../../infra/substrate/events/agent-loop-events.js"
import type { OutputProjectionEvent } from "../../../../infra/substrate/output/output-projection-events.js"
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

/** One logical generation at a time and its shared recovery policy: what a
 *  caller that runs one turn and then stops needs. */
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

/** A generation host with the turn slot that a chat runner reserves, starts,
 *  and continues across the person's messages. */
export interface AgentHost<O = AgentHostContextOptions> extends AgentGeneration<O> {
  readonly turnState: "active" | "idle"
  readonly activeTurnLease: AgentHostTurnLease | null
  reserveTurn(): AgentHostTurnLease | null
  takeReservedTurn(): AgentHostTurnLease | null
  releaseTurn(lease: AgentHostTurnLease): void
  ownsTurn(lease: AgentHostTurnLease): boolean
  startTurn(lease: AgentHostTurnLease, run: () => Promise<void>): void
  interruptTurn(): void
  continueAfterTurn(lease: AgentHostTurnLease, continuation: () => void): void
}
import type { ChatInputLike } from "../../../../infra/substrate/events/chat-input.js"
/** What a chat runner and a workflow runner both are. Controls whose shape
 *  differs between them, such as interrupt and resume, belong to each kind
 *  (`ChatRunner`, `WorkflowRunner`). */
export interface Runner {
  readonly sessionId: string
  /** Projects an already durable event without recording it again. */
  applyProjectionEvent(event: OutputProjectionEvent): void
  dispose(): Promise<void>
  /** Takes the person's latest unread queued message back for their editor.
   *  Resolves with it only after its hold is retired, and null when nothing
   *  unread is queued. Rejects with the store's error when the hold cannot
   *  be retired, which leaves the message queued. */
  recallQueuedMessage(): Promise<ChatInputLike | null>
  compact(): Promise<boolean>
  /** Reload runtime config, auth, and model listing from disk. Optional;
   *  workflow runners that complete in one shot may omit it. */
  refreshDeps?(): Promise<void>
}
