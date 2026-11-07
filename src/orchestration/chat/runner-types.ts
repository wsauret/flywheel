import type { AnyBlock } from "../../infra/output-blocks.js"
import type { CapabilityCheck } from "../../infra/capability-text.js"
import type { ChatInput, ChatInputLike } from "../../infra/chat-input.js"
import type { Runner } from "../runner/types.js"
import type { AgentInputAnswers } from "../../protocol/question-protocol-types.js"
import type { ModuleRuntimes } from "../../infra/module-runtime.js"
import type { HeldBackgroundNotification } from "../session/conversation/queued-background-notifications.js"
import type { ControlInterruption, PlannedCutInterrupt, RuntimeInterruption } from "../session/conversation/turn-end-record.js"
import type { HeldRetainedOperation } from "../module-seams.js"
import type { DeliveryOutcome, LiveRecipientState } from "../session/live-session-control.js"
import type { BackgroundWorkTracking } from "../agent-runtime/background-work.js"

/** What a person's message to a chat came to. `recorded` is a message the
 *  conversation already held under its submission identity: a client sent it
 *  again after its connection lost the answer, and nothing changed (ARCH-SESSIONS-030).
 *  `ended` is a chat, or its one-shot invocation, that takes no more input. */
export type ChatSendResult = "accepted" | "recorded" | "ended"

export interface ChatRunner extends Runner {
  /** Session resources available from attachment until awaited disposal. */
  readonly chatModuleHosts: ModuleRuntimes
  onModuleRuntimesChange?(listener: (modules: ModuleRuntimes) => void): () => void
  /** Resolves after the current model turn has settled and its buffered conversation facts are durable. */
  awaitTurnSettlement(): Promise<void>
  /** Present until the logical turn parks durably or finishes its terminal callbacks. */
  readonly pendingTurnSettlement?: Promise<void>
  /** Resolves immediately between logical turns, or after the active logical turn reaches its next durable save point. */
  awaitLogicalTurnDurability(): Promise<void>
  /** A person's message: saved, then shown and started or queued behind the
   *  running turn. Resolves `accepted` once it is saved, `recorded` when the
   *  conversation already holds it under its submission, and `ended` when
   *  the chat has ended; rejects with the store's error when it cannot be
   *  saved, which leaves the chat open for the person to send it again. */
  send(input: ChatInputLike): Promise<ChatSendResult>
  /** Takes one accepted message from another session (`LiveSessionControl.deliver`). */
  deliverHeldMessage(input: ChatInput, decide: (state: LiveRecipientState) => DeliveryOutcome): Promise<DeliveryOutcome>
  /** The state a message from another session would meet now. */
  messageState(): Promise<LiveRecipientState>
  deliverCommitted(input: ChatInputLike): boolean
  /** Admit already-durable module work to this runner's ordinary save point. */
  acceptRetainedOperation?(operation: HeldRetainedOperation): Promise<void>
  deliverBackgroundNotification(notification: HeldBackgroundNotification): Promise<boolean>
  requestWithContext(input: ChatInputLike, context: string): boolean
  /** The module runtimes the current runner generation was assembled with;
   *  absent on a runner that has not assembled one. A command handler reads
   *  its module's instance through its typed handle. */
  readonly moduleRuntimes?: ModuleRuntimes
  /** The attached host's registry, available before a child starts. */
  readonly backgroundTasks: BackgroundWorkTracking
  /** Assembles this runner's runtime without a model request and parks it on
   *  its background work, so work that continues under this session (a
   *  child's resume) has the runtime it dispatches through. Resolves with the
   *  assembled module runtimes; answers at once when a turn has assembled. */
  hold(): Promise<ModuleRuntimes>
  /** The agent check (ARCH-CONTEXT-033) of the tool surface that the chat's next request would use, planned as a
   *  send plans it. It starts no turn, appends nothing to history, and changes no state. */
  capabilities(): Promise<CapabilityCheck>
  /** A client shows the session (`true`), also again at a reattach, or the last client released it (`false`). The
   *  session's engines run only while it is shown (ARCH-PROVIDERS-070). */
  setShown(shown: boolean): void
  answerQuestion(toolUseId: string, answers: AgentInputAnswers): void
  cancelQuestion(toolUseId: string): void
  resumeCommitted(): boolean
  /** See `ChatPorts.awaitOwedCapacity`. */
  awaitOwedCapacity(): Promise<boolean>
  /** Whether a planned replacement would cut a turn now: a turn runs,
   *  parked on background work included, and no one has cut it. A turn that
   *  waits on a question is the person's, so no stop cuts it and its
   *  question stays open. `interruptForReplacement` and a `replacement`
   *  `prepareForShutdown` cut exactly this turn. Only the runner can answer: the session's published activity
   *  reads idle once a turn's logical end is reported, and the loop can run
   *  a further request after that, such as the reply nudge that follows a
   *  silent launch of a background command. */
  holdsRunningTurn(): boolean
  /** The runtime's stop: a running turn ends as the runtime's interrupt
   *  `by`, which a Resume continues, and an idle runner shelves its queued
   *  input. A `replacement` stop ends the turn as the planned cut does. */
  prepareForShutdown(by: RuntimeInterruption): void
  /** A planned replacement's cut: interrupts the running turn by the
   *  runtime, including one parked on background work. The
   *  caller moves held foreground commands to the background before this
   *  cut, so it ends no command. Resolves when the turn is durable. True
   *  when it interrupted a running turn. */
  interruptForReplacement(): Promise<boolean>
  /** An interrupt by `by` of the turn a planned replacement's cut ended,
   *  which a successor still owes: nothing runs to cut, so it records the
   *  turn end that names `by` over the cut and shows it as `interrupt`
   *  does. Resolves once the record is durable, or, while the cut turn
   *  still unwinds, once the record is queued behind that turn's own; or at
   *  once with why it recorded nothing. */
  interruptPlannedCut(by: ControlInterruption): Promise<PlannedCutInterrupt>
  terminateBackgroundWork(toolUseId: string): void
  releaseForegroundBash(toolUseId: string): boolean
  /** A planned replacement's move of every held foreground command, a
   *  child's included, to the background before its cut interrupts the
   *  turn. Resolves once the registry tracks each moved command or it has
   *  ended; a command held later moves at once. */
  transferForegroundForReplacement(): Promise<void>
  /** Adopts the commands a previous build handed to this chat's
   *  conversation, once, without starting a turn. Resolves when the adoption
   *  has settled, and never rejects: what it cannot adopt is left for a later
   *  host. Every turn waits for it before its first model request. */
  adoptHandedOver(): Promise<void>
  /** Seed the display blocks the store accumulated before attach. The store's
   *  attachChatRunner calls this in the same synchronous frame that makes the
   *  runner the block authority, so no pre-runner append can fall between the
   *  capture and the handoff. */
  seedDisplayBlocks(blocks: readonly AnyBlock[]): void
  publishCommittedNotice?(notice: { readonly id: string; readonly message: string; readonly timestamp: number }): void
}
