import type { EventBusDrainResult, Unsubscribe } from "../../infra/event-bus.js"
import { Log } from "../../infra/log.js"
import { chatInputImages, chatInputText, normalizeChatInput, type ChatInput, type ChatInputLike } from "../../infra/chat-input.js"
import { interruptedLabel, RESUMED_LABEL } from "../../infra/output/run-labels.js"
import { isRuntimeInterruption, type ControlInterruption, type PlannedCutInterrupt, type RuntimeInterruption, type TurnInterruption } from "../session/conversation/turn-end-record.js"
import type { ConversationTreeWriterController } from "./tree-writer.js"
import type { ChatCallbacks, ChatSessionState } from "./types.js"
import type { ChatPorts } from "./host-ports.js"
import type { OutputSession } from "../runner/output-session.js"
import type { ChatSendResult } from "./runner-types.js"
import { personMessageKey } from "../session/conversation/queued-user-inputs.js"
import { recordPersonMessageReceipt } from "../session/conversation/person-message-ledger.js"

const log = Log.create({ service: "chat" })

interface ChatControls {
  /** A person's message. Resolves `accepted` once it is saved, shown, and
   *  handed to the runner; `recorded` when the conversation already holds it
   *  under its submission; `ended` when the chat or its one-shot invocation
   *  has ended. Rejects with the store's error when the message cannot be
   *  saved, which leaves the chat open. */
  send(input: ChatInputLike): Promise<ChatSendResult>
  deliverCommitted(input: ChatInputLike): boolean
  /** A command's turn: hands the request and its request-only context to
   *  the runner and shows its invocation as a person's message is shown.
   *  False when the chat or its one-shot invocation has ended. */
  requestWithContext(input: ChatInputLike, context: string): boolean
  recallQueuedMessage(): ChatInput | null
  /** A person's interrupt: cuts the running turn and any running tool call,
   *  keeps what it committed, and hands the turn to the person. The parked
   *  loop records the turn end; Resume continues it. */
  interrupt(): boolean
  /** Whether the runtime's interrupt would cut a turn now: a turn runs,
   *  parked on a question or on background work included, and no one has
   *  cut it. `interruptForRuntime` cuts exactly such a turn. */
  holdsRunningTurn(): boolean
  /** The runtime's stop: cuts the running turn through the teardown abort
   *  and records it as interrupted by `by`, so a Resume continues it. A
   *  planned replacement's cut shows nothing. Queued input stays queued. */
  interruptForRuntime(by: RuntimeInterruption): boolean
  /** A person's interrupt of the turn a planned replacement's cut ended,
   *  which a successor still owes: nothing runs to cut, so it records the
   *  person's turn end over the cut and shows it as `interrupt` does. A
   *  turn the runtime cut that still unwinds takes it too: its record is
   *  queued already, and the person's queues behind it, so the person's is
   *  the last turn end. A turn that runs and that no one cut answers
   *  `running`, and once the session has ended it records nothing
   *  (`PlannedCutInterrupt`). */
  interruptPlannedCut(by: ControlInterruption): PlannedCutInterrupt
  /** Continues an interrupted or unexpectedly exited turn from where it
   *  stopped with no new message: the person's Resume and any later
   *  automatic continuation both end here. `announce` is false after a cut
   *  no one saw. */
  resume(options: { readonly announce: boolean }): boolean
  abort(): void
  end(options?: { readonly suspendedOnQuestion?: boolean }): Promise<void>
}

interface ChatControlsInput {
  lifecycle: ChatPorts
  session: OutputSession
  callbacks: ChatCallbacks
  eventUnsubs: Unsubscribe[]
  state: ChatSessionState
  treeWriter: ConversationTreeWriterController
  onTreeFailure: (err: Error) => void
  drainEvents: () => Promise<EventBusDrainResult>
  /** Durable record of an interrupt that no parked loop records: the
   *  runtime's stop, appended behind the cut turn's last save point, or a
   *  person's interrupt of a turn the planned cut already ended.
   *  Fire-and-forget; the owner handles its failures. */
  recordInterruption: (by: TurnInterruption) => void
  /** A person's new message is about to supersede whatever turn ended last.
   *  When that turn was interrupted, its standing typed-decision approvals
   *  are voided: a confirmation granted for work the person then left must
   *  not authorize a later launch. A Resume keeps them. Fire-and-forget. */
  supersedeInterruptedTurn: () => void
}

function queuedInputsForRestart(inputs: readonly ChatInputLike[], fallbackTexts: readonly string[]): ChatInput[] {
  const normalized = inputs.map(normalizeChatInput)
  if (normalized.length > 0) return normalized
  const text = fallbackTexts.join("\n\n")
  return text ? [{ text }] : []
}

export function createChatControls(controlsInput: ChatControlsInput): ChatControls {
  const { lifecycle, session, callbacks, eventUnsubs, state, treeWriter, onTreeFailure, drainEvents, recordInterruption, supersedeInterruptedTurn } = controlsInput

  // The last message sent, which the next one waits for.
  let earlierSends: Promise<unknown> = Promise.resolve()

  function holdsRunningTurn(): boolean {
    return !state.ended && lifecycle.turnRunning
  }

  function interruptForRuntime(by: RuntimeInterruption): boolean {
    if (!holdsRunningTurn() || !lifecycle.abortRunningTurn()) return false
    log.info("chat interrupted by the runtime", { by })
    lifecycle.cutTurn(by)
    session.endTurn("paused")
    if (by !== "replacement") session.pushSystemMessage(interruptedLabel("runtime"), Date.now())
    recordInterruption(by)
    session.flush()
    return true
  }

  function interruptPlannedCut(by: ControlInterruption): PlannedCutInterrupt {
    if (state.ended) return "ended"
    // A turn the runtime cut can take a while to unwind; its record is
    // queued already, so this one queues behind it and is the last.
    const cut = lifecycle.turnCut
    const cutByRuntime = cut?.kind === "aborted" && isRuntimeInterruption(cut.by)
    if (lifecycle.turnState !== "idle" && !cutByRuntime) return "running"
    log.info("chat interrupted after the runtime's planned cut", { by, turnUnwinding: lifecycle.turnState !== "idle" })
    lifecycle.cutTurn(by)
    session.pushSystemMessage(interruptedLabel(by), Date.now())
    recordInterruption(by)
    session.flush()
    return "recorded"
  }

  function resume(options: { readonly announce: boolean }): boolean {
    if (state.ended) return false
    if (!lifecycle.resumeCommitted({ explicit: true })) return false
    if (options.announce) session.pushSystemMessage(RESUMED_LABEL, Date.now())
    session.flush()
    return true
  }

  function interrupt(): boolean {
    if (state.ended || lifecycle.turnState === "idle") return false
    log.info("chat interrupted by user")
    const interruptedRunner = lifecycle.interruptGeneration()
    if (!interruptedRunner) return false
    lifecycle.cutTurn("person")

    session.endTurn("paused")

    // Show the "Interrupted" row BEFORE flipping queued user blocks
    // pending→delivered, so the transcript reads naturally: the queued
    // ticket, then the interruption, then the now-unqueued message that the
    // interrupt sent. The durable record is the parked loop's to write.
    session.pushSystemMessage(interruptedLabel("person"), Date.now())

    // Flip queued user blocks pending→delivered. A message typed while the
    // turn ran is the continuation: the agent loop's input reservation
    // consumes it and continues with it as the next user turn. Keep turn
    // state alive so the UI reflects the resumed work. The loop's exit
    // handler tears down naturally when work truly ends.
    session.drainQueued()
    session.flush()
    return true
  }

  function abort(): void {
    if (state.ended) return
    lifecycle.abortGeneration()
    const pendingInputs = lifecycle.drainQueuedUserInputs()
    const pendingTexts = session.drainQueued()
    session.flush()

    const inputsToResend = queuedInputsForRestart(pendingInputs, pendingTexts)
    // The turn pipeline owns detach and the save-point flush; restarting
    // before it settles would race the previous runner's durable writes.
    void lifecycle.settle().then(() => {
      if (state.ended) return
      if (inputsToResend.length > 0) lifecycle.restartWithQueuedInputs(inputsToResend)
    })
  }

  async function end(options?: { readonly suspendedOnQuestion?: boolean }): Promise<void> {
    if (state.ended) return
    state.end()
    // This is the only place a runner ends, so it is the only place that
    // reports the end. A turn slot that is held does not prove that a turn
    // runs: a reserved slot is released with no turn, and no run reports it.
    try {
      if (lifecycle.turnState === "active") lifecycle.abortGeneration()
      // The loop may still be writing canonical messages, and treeWriter.dispose
      // is a data-loss boundary, so this waits for real settlement: the aborted
      // run's turn child, its foreground tools, and its durable writes have all
      // unwound before anything reachable from them is disposed. The session is
      // already closed to new work (state.end above), so waiting costs nothing
      // but time.
      await lifecycle.settle()
      if (options?.suspendedOnQuestion) {
        treeWriter.suspendPending()
        // The turn waits on the person: its finished results join the
        // conversation behind the ask, and no record ends it.
        try {
          await treeWriter.settleSuspendedTurn()
        } catch (err) {
          onTreeFailure(err instanceof Error ? err : new Error(String(err)))
        }
      }
      // Background processes may still own files in the session scratch. Drain
      // them before tree/output disposal makes that scratch eligible for deletion.
      await lifecycle.terminateBackgroundWorks()
      await drainEvents()
      for (const unsubscribe of eventUnsubs) unsubscribe()
      session.flush()
      // Tree writer fsync/dispose runs before the output flusher closes,
      // disposal order in session-resources-service handles transcript/budget.
      try { await treeWriter.dispose() } catch (err) { onTreeFailure(err instanceof Error ? err : new Error(String(err))) }
      session.dispose()
    } finally {
      callbacks.onEnded()
    }
  }

  /** Shows the person's message. Its row carries the client's submission
   *  ids, which is the client's proof of delivery, so it is shown only once
   *  the message is durable. */
  function showSent(input: ChatInputLike, queued: boolean, entryId: string | undefined): void {
    const { invocation, submissionIds } = normalizeChatInput(input)
    if (invocation) {
      // Inline step/skill invocation: paint the divider and the raw user
      // arguments; the expanded prompt body is model-facing only.
      session.pushDivider(invocation.label, Date.now())
      if (invocation.args) session.pushUserMessage(invocation.args, Date.now(), { entryId, queued, injected: false, ...(submissionIds?.length ? { submissionIds } : {}) })
    } else {
      const images = chatInputImages(input)
      session.pushUserMessage(chatInputText(input), Date.now(), { entryId, queued, injected: false, ...(submissionIds?.length ? { submissionIds } : {}), ...(images.length ? { images } : {}) })
    }
  }

  /** Each message is read against the ledger, saved, and handed to the
   *  runner only after the message sent before it settled. So the runner
   *  takes messages in send order, and a later copy of a submission always
   *  finds the earlier copy's entry or cell. Saves take milliseconds.
   *
   *  Admission is decided when the message arrives, not when its turn in
   *  the order comes: a one-shot invocation cannot seal over a message it
   *  already took, and a message that arrives after the chat ended is
   *  refused even if the ledger check waits. */
  function send(input: ChatInputLike): Promise<ChatSendResult> {
    const completion = lifecycle.invocationCompletion
    const releaseAdmission = state.ended ? undefined : completion?.admitInput()
    const admitted = !state.ended && (completion === undefined || releaseAdmission !== undefined)
    const sent = earlierSends.then(() => sendInOrder(input, admitted)).finally(() => releaseAdmission?.())
    earlierSends = sent.catch(() => {})
    return sent
  }

  async function sendInOrder(input: ChatInputLike, admitted: boolean): Promise<ChatSendResult> {
    // A message the conversation already holds under its submission is a
    // copy that a client sent again after its connection lost the answer.
    // It is answered first, before any refusal or side effect, and records
    // nothing (ARCH-SESSIONS-030).
    const key = personMessageKey(input)
    const recorded = key === undefined ? undefined : await treeWriter.recordedPersonMessage(key)
    if (recorded !== undefined) {
      recordPersonMessageReceipt(session.sessionId, input, recorded)
      return "recorded"
    }
    if (!admitted) {
      if (state.ended) log.warn("chat send after ended")
      return "ended"
    }
    const text = chatInputText(input)
    const queued = lifecycle.turnState === "active"

    if (lifecycle.turnState === "idle" && !state.providerConversationId) {
      log.debug("chat first send; queueing fresh runner")
    } else if (lifecycle.turnState === "idle") {
      log.debug("chat runner reconnecting via new runner", { providerConversationId: state.providerConversationId })
    } else {
      log.debug("chat message sent", { length: text.length })
    }

    // A message into a running turn continues it; one after an interrupt, or
    // into a session with no runner, leaves the last turn behind.
    if (lifecycle.turnCut !== undefined || lifecycle.turnState === "idle") supersedeInterruptedTurn()

    // Durable at dispatch, so the message is shown and reaches the runner
    // only once it is saved. A message into a running turn would otherwise
    // wait in memory until the turn's next save point, and a crash in that
    // window has nothing else to restore it from: its cell lands now, and
    // the flush that commits the message retires it. An idle message is the
    // user turn the runner starts from. A save the store refuses fails this
    // send alone: the chat stays open, and the person keeps the message to
    // send again.
    const saved = queued ? await holdQueued(input) : await commitIdle(input, key)
    // A chat that ended meanwhile has no runner to take the message, which
    // its conversation keeps.
    if (state.ended) return "accepted"
    showSent(input, queued, saved.entryId)
    lifecycle.enqueueInput(saved.input)
    return "accepted"
  }

  async function holdQueued(input: ChatInputLike): Promise<{ input: ChatInputLike; entryId: string | undefined }> {
    const dispatchId = await treeWriter.holdQueuedUserInput(input)
    const held = normalizeChatInput(input)
    return { input: dispatchId ? { ...held, dispatchIds: [...(held.dispatchIds ?? []), dispatchId] } : held, entryId: dispatchId ?? undefined }
  }

  /** Commits an idle message under its submission key, or under a fresh id
   *  that a refused save gives back. */
  async function commitIdle(input: ChatInputLike, key: string | undefined): Promise<{ input: ChatInputLike; entryId: string }> {
    if (key !== undefined) {
      await treeWriter.commitUserTurn(input, key)
      return { input, entryId: key }
    }
    const entryId = await treeWriter.reserveMessageId()
    try {
      await treeWriter.commitUserTurn(input, entryId)
    } catch (error) {
      treeWriter.releaseMessageId(entryId)
      throw error
    }
    return { input, entryId }
  }

  function recallQueuedMessage(): ChatInput | null {
    if (state.ended) return null
    const recalled = lifecycle.recallQueuedUserInput()
    if (!recalled) return null
    const removed = session.recallQueued()
    if (removed === null) {
      lifecycle.restartWithQueuedInputs([recalled])
      return null
    }
    session.flush()
    if (recalled.dispatchIds && recalled.dispatchIds.length > 0) {
      // The words went back into the editor, which is not durable state, so
      // the cells retire here: recovering a message the user took back would
      // resend what they chose not to send.
      void treeWriter.dropQueuedUserInputs(recalled.dispatchIds).catch((err) => {
        log.warn("queued input cell drop failed", { error: err instanceof Error ? err.message : String(err) })
      })
      const { dispatchIds: _retired, ...bare } = recalled
      return bare
    }
    return recalled
  }

  function deliverCommitted(input: ChatInputLike): boolean {
    if (state.ended) { log.warn("chat committed delivery after ended"); return false }
    if (lifecycle.invocationCompletion?.sealed) return false
    lifecycle.enqueueInput(input)
    return true
  }

  function requestWithContext(input: ChatInputLike, context: string): boolean {
    if (!lifecycle.requestWithContext(input, context)) return false
    // Never a queued row: the mailbox never recalls a context request, and
    // recall takes the last queued row, so a queued one could be taken in
    // place of the person's recalled message.
    showSent(input, false, undefined)
    return true
  }

  return { send, deliverCommitted, requestWithContext, interrupt, holdsRunningTurn, interruptForRuntime, interruptPlannedCut, resume, abort, end, recallQueuedMessage }
}
