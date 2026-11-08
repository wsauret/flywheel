import type { CapabilityCheck } from "../../infra/capability-text.js"
import type { ChatInput, ChatInputLike } from "../../infra/chat-input.js"
import type { ModuleRuntimes } from "../../infra/module-runtime.js"
import type { HeldBackgroundNotification } from "../session/conversation/queued-background-notifications.js"
import type { DeliveryOutcome, LiveRecipientState } from "../session/live-session-control.js"
import type { createChatInvocationCompletion } from "./runner-completion.js"
import type { TurnCut } from "./runner-wait-state.js"
import type { TurnInterruption } from "../session/conversation/turn-end-record.js"
import type { BackgroundWorkTracking } from "../agent-runtime/background-work.js"

/** Interactive controls and projections layered over the shared runner host. */
export interface ChatPorts {
  readonly invocationCompletion?: ReturnType<typeof createChatInvocationCompletion>
  readonly turnState: "active" | "idle"
  onModuleRuntimesChange(listener: (modules: ModuleRuntimes) => void): () => void
  /** The runtimes the current runner generation was assembled with. */
  readonly moduleRuntimes: ModuleRuntimes
  readonly backgroundTasks: BackgroundWorkTracking
  /** Session resources available without starting or joining model work. */
  readonly chatModuleHosts: ModuleRuntimes
  /** Assembles the runtime without a model request and parks on background work. */
  hold(): Promise<ModuleRuntimes>
  /** The agent check (ARCH-CONTEXT-033) of the tool surface that the chat's next request would use, planned as a
   *  send plans it. It starts no turn, appends nothing to history, and changes no state. */
  capabilities(): Promise<CapabilityCheck>
  enqueueInput(input: ChatInputLike): void
  /** Takes one accepted message from another session (see `LiveSessionControl.deliver`). */
  deliverHeldMessage(input: ChatInput, decide: (state: LiveRecipientState) => DeliveryOutcome): Promise<DeliveryOutcome>
  /** The state a message from another session would meet now. */
  messageState(): Promise<LiveRecipientState>
  deliverBackgroundNotification(notification: HeldBackgroundNotification): Promise<boolean>
  requestWithContext(input: ChatInputLike, context: string): boolean
  drainQueuedUserInputs(): ChatInputLike[]
  /** The person's latest unread queued message, taken back for their editor
   *  (`recallQueuedInput`): resolves with it only once its hold is retired,
   *  null when nothing unread is queued, and rejects with the store's error
   *  when the hold cannot be retired, which leaves the message queued. */
  recallQueuedUserInput(): Promise<ChatInput | null>
  restartWithQueuedInputs(inputs: readonly ChatInputLike[]): void
  /** Starts the next model request from the committed leaf. `explicit` is a
   *  person's Resume: it authorizes a runner parked after an interrupt,
   *  records the continuation the model reads, and satisfies a stalled turn's
   *  wait for the user. The automatic wake after a settled question does
   *  none of these. */
  resumeCommitted(options?: { readonly explicit?: boolean }): boolean
  /** Resumes the turn that an unexpected exit or a restart cut while it
   *  waited for model capacity, when the chat's row still owes that wait
   *  at a time ahead: the resumed turn's request finds the routes still
   *  spent, so the turn waits again under the host and continues at that
   *  time (PI-MODEL-039). False when nothing is owed ahead, a turn runs, or
   *  the runner has ended. */
  awaitOwedCapacity(): Promise<boolean>
  interruptGeneration(): boolean
  /** Whether a turn runs in the turn slot and no one cut it: from its start
   *  until the loop parks with its turn answered and nothing running for it,
   *  or parks for the person after an interrupt, an unexpected exit, or a
   *  stall, or until an interrupt cuts it (`cutTurn`). A turn parked on a
   *  question or on background work still runs. `abortRunningTurn` cuts
   *  exactly such a turn. */
  readonly turnRunning: boolean
  /** Who cut the turn that holds the turn slot (`TurnCut`): undefined with
   *  no turn in the slot, or one that no one cut. A turn that starts later
   *  starts uncut, whatever cut the turn before it. */
  readonly turnCut: TurnCut | undefined
  /** Records who cut the turn that holds the turn slot, as the interrupt
   *  that cut it decides: a person's interrupt, the runtime's abort, or a
   *  person's turn end recorded over that abort. A person's cut lasts until
   *  their message or Resume continues the turn; the runtime's lasts for the
   *  turn's life. With no turn in the slot it records nothing. */
  cutTurn(by: TurnInterruption): void
  /** Ends the running turn for the runtime's planned stop: the run is cut,
   *  what it committed lands at its last save point, and the turn slot is
   *  released so a resume after the restart starts a fresh request from the
   *  committed leaf. The turn's own end reports its idle activity after the
   *  turn-end record is durable, so a client reads them in that order. False
   *  when no turn runs (`turnRunning`). */
  abortRunningTurn(): boolean
  /** Whether a client shows the session, which decides whether its engines run (`SessionEngines.setShown`). */
  setShown(shown: boolean): void
  /** The environment that serves the session's requests was refreshed, so its engines plan again
   *  (`SessionEngines.servingChanged`). */
  servingChanged(): void
  abortGeneration(): void
  /** Queues manual compaction behind active work. Returns false when it starts immediately. */
  requestCompact(): boolean
  learn(): boolean
  settle(): Promise<void>
  readonly pendingTurnSettlement: Promise<void> | undefined
  awaitLogicalTurnDurability(): Promise<void>
  terminateBackgroundWorks(): Promise<void>
  terminateBackgroundWork(toolUseId: string): void
  releaseForegroundBash(toolUseId: string): boolean
  transferForegroundForReplacement(): Promise<void>
  adoptHandedOver(): Promise<void>
}
