import type { SessionChangesUndo, SessionChangesUndoResult } from "../../protocol/session-changes-protocol-types.js"
import type { ChatInputLike } from "../../infra/chat-input.js"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { DebugLog } from "../../infra/debug-log.js"
import { durationMs, recordBackgroundFailure } from "../../infra/operation-log.js"
import { createSessionWorkSettlement } from "./runtime-work-settlement.js"
import type { ChatRunner } from "../chat/runner-types.js"
import type { ChatDurabilityContext } from "./session-chat-durability.js"
import { chatDurabilityContext, ensureDurableChatSession, recordedChatMessage, renderPreRunnerTurn, renderUnsavedPreRunnerTurn, writePreReadinessTurn } from "./session-chat-durability.js"
import { activateDurableChat, readOpenChatDisplaySeed, refreshOpenChatDisplay, replaceDisplaySeed } from "./session-reactivation.js"
import { editedSessionLabels } from "../session/session-label.js"
import type { QuestionRefusal, QuestionSettlementOutcome, RuntimeRunnerCapabilities, SendChatOutcome } from "./runtime-supervisor-types.js"
import { isTurnAtRest, type SessionTitlePatch } from "../../protocol/app-service-types.js"
import { entryActivity } from "../session-store/activity.js"
import { createSessionContinuation } from "./session-continuation.js"
import { finalizeDisposition, prepareDeactivation, prepareDisposition, shouldTombstone } from "./session-runtime-disposition.js"
import type { ActorLifecycle, DispatchOutcome, DispatchResult, RunnerStartup, SessionMutation, SessionRuntimeActor, SessionRuntimeActorContext } from "./session-runtime-actor-types.js"
import { loadAgentInputProjection } from "../session/agent-input-projection.js"
import { createSessionFactWriter } from "../session/session-fact-writer.js"
import { holdChildReconciliationIndex } from "../session/child-reconciliation-index.js"
import { createBackgroundNotificationDelivery } from "./session-background-notifications.js"
import { executionCwdFromSession } from "../session/session-execution-directory.js"
import { reconcileAgentInput } from "../session/agent-input-reconciliation.js"
import { moduleRequirementsForContribution } from "../module-requirements.js"
import { chatInputParts, observeSessionDispatch, questionSettlementDisplay, questionSettlementFact, runnerSendOutcome, settleWithin, validAgentInputAnswers } from "./session-runtime-actor-helpers.js"
import type { ChildSessionDeletionPlan } from "../session/child-session-deletion.js"
import { createChatSessionControl } from "./chat-session-control.js"
import { chatRunnerDeps } from "./chat-runner-deps.js"
import { readChatTurnEndEvidence } from "../session/chat-session-run-evidence.js"
import { liveSessionControl } from "../session/live-session-control.js"

const log = Log.create({ service: "session-runtime-actor" })

class StaleStartupError extends Error {
  constructor(sessionId: string) { super(`stale chat startup for ${sessionId}`) }
}

/** How long a lifecycle command waits for an in-flight startup to settle before
 *  tearing down anyway. The actor is already closing, so a startup that
 *  finishes later can no longer attach - it disposes its orphan runner and
 *  exits. So this grace only buys an orderly settle for the common fast case; a
 *  wedged cold-start must never hold a close open and leave the tab unclosable.
 *  Well under the client's control deadline. */
const CLOSE_STARTUP_GRACE_MS = 1_000

interface PendingDelivery {
  readonly entryId: string
  readonly input: ChatInputLike
}

export function createSessionRuntimeActor(sessionId: string, ctx: SessionRuntimeActorContext): SessionRuntimeActor {
  let lifecycle: ActorLifecycle = { kind: "open" }
  let startup: RunnerStartup = { kind: "none" }
  // The actor owns its session's completion index for its whole life, and
  // every way the actor ends vacates the store, which releases it.
  const releaseReconciliationIndex = holdChildReconciliationIndex(ctx.projectionReader, sessionId)
  // Set while no client shows the chat, or its tab closed, and its turn is
  // not at rest: the store watch that ends the runner, or closes the chat
  // when `closeAtRest`, once the turn comes to rest.
  let restWatch: (() => void) | undefined
  let closeAtRest = false
  let pending: PendingDelivery[] = []
  const deliveredEntryIds = new Set<string>()
  // Every ordered phase runs here, one after another. A failed phase
  // surfaces to its caller and never stops the phases queued after it.
  const { mailbox, ownAcceptedWork, awaitAcceptedWork, hasAcceptedWork, waitForStartup } =
    createSessionWorkSettlement(() => startup.kind === "starting" ? startup.promise : undefined)
  const settleStartup = () => settleWithin(waitForStartup(), ctx.closeStartupGraceMs ?? CLOSE_STARTUP_GRACE_MS)
  const inputControl = createChatSessionControl({ store: ctx.eventStore, sessionId, lane: mailbox, runner: () => {
    const entry = ctx.sessionStore.get(sessionId)
    return entry?.kind === "chat" ? entry.runner : undefined
  } })
  let titlePending = false
  let undo: { readonly controller: AbortController; readonly settled: Promise<SessionChangesUndoResult> } | undefined

  const durability: ChatDurabilityContext = chatDurabilityContext(ctx, sessionId)
  const backgroundNotifications = createBackgroundNotificationDelivery({ sessionId, projectRoot: ctx.directories.projectRoot, eventStore: ctx.eventStore, projectionReader: ctx.projectionReader, eventWriter: ctx.eventWriter, admitsDelivery: () => lifecycle.kind === "open" && !ctx.isDisposed(),
    // A send or activation can commit while its own reconciliation holds the
    // lane, so the sweep runs after it rather than inside it.
    sweepAfterCommit: () => { void reconcileChildSessionCompletions().catch((error: unknown) => { recordBackgroundFailure(log, "sweep after a held workflow completion", { sessionId }, error) }) },
  })
  const continuation = createSessionContinuation(sessionId, ctx, {
    isClosing: () => lifecycle.kind !== "open",
    clearFailure, admitsWork,
    ensureChatRunner, backgroundNotifications, ownAcceptedWork,
    // The runner's writer lands held work after its turn's output, so a turn
    // parked on background work takes the record too. A turn that runs or
    // asks again by now keeps its display, which is ahead of the log; the
    // record then shows at the next refresh or attach.
    refreshDisplay: () => {
      void mailbox.run(() => refreshOpenChatDisplay(ctx, sessionId, { keep: "runningTurn" })).catch((error: unknown) => {
        recordBackgroundFailure(log, "refresh the open display after held work landed", { sessionId }, error)
      })
    },
  })

  function admitsWork(): boolean {
    return !ctx.isDisposed() && lifecycle.kind === "open" && ctx.sessionStore.has(sessionId)
  }

  function clearFailure(): void {
    if (startup.kind === "failed") startup = { kind: "none" }
  }

  function drainPending(runner: ChatRunner): void {
    if (pending.length === 0) return
    const before = pending.length
    const remaining: PendingDelivery[] = []
    for (const delivery of pending) {
      if (deliveredEntryIds.has(delivery.entryId)) continue
      if (runner.deliverCommitted(delivery.input)) {
        deliveredEntryIds.add(delivery.entryId)
        titlePending = false
      } else remaining.push(delivery)
    }
    pending = remaining
    log.debug("pending deliveries drained", { sessionId, before, remaining: pending.length, delivered: before - pending.length })
  }

  async function attachReadyRunner(runner: ChatRunner, conversationId: string, children: RuntimeRunnerCapabilities["childSessions"]): Promise<void> {
    try {
      // Close can already be waiting for startup in the mailbox. Refuse before
      // joining it, and re-check after every asynchronous read.
      if (!admitsWork()) throw new StaleStartupError(sessionId)
      await children.restoreTracking(sessionId, runner.backgroundTasks)
      // Earlier sends finish their commits before this read; later sends start
      // after attach and use the runner. Startup tails never enter this phase.
      await mailbox.run(async () => {
        if (!admitsWork()) throw new StaleStartupError(sessionId)
        const refreshed = await readOpenChatDisplaySeed(ctx, sessionId, conversationId)
        if (!admitsWork()) throw new StaleStartupError(sessionId)
        replaceDisplaySeed(ctx, sessionId, refreshed)
        if (!ctx.sessionStore.attachChatRunner(sessionId, runner)) throw new StaleStartupError(sessionId)
        inputControl.attach()
        if (ctx.isShown(sessionId)) runner.setShown(true)
      })
    } catch (error) {
      await runner.dispose()
      throw error
    }
  }

  async function startChatRunner(conversationId: string): Promise<ChatRunner> {
    const start = performance.now()
    log.debug("chat runner start", { sessionId, conversationId })
    const shell = ctx.sessionStore.get(sessionId)
    if (shell?.kind !== "chat") throw new StaleStartupError(sessionId)
    let runner: ChatRunner
    try {
      const capabilities = await ctx.runnerCapabilities()
      if (!admitsWork()) throw new StaleStartupError(sessionId)
      await capabilities.authAdmission.admit(sessionId)
      if (!admitsWork()) throw new StaleStartupError(sessionId)
      await ensureDurableChatSession(durability, conversationId)
      const durableSession = await ctx.manager.read(sessionId)
      const executionCwd = executionCwdFromSession(durableSession, sessionId, ctx.directories.projectRoot)
      runner = await capabilities.runnerLoader.createRunner(chatRunnerDeps({
        ctx, sessionId, conversationId, executionCwd, shell, durableSession, capabilities,
        generateTitleForNextMessage: titlePending, onFinish: enqueueChatFinish,
      }))
      await attachReadyRunner(runner, conversationId, capabilities.childSessions)
    } catch (err) {
      if (err instanceof StaleStartupError || !admitsWork()) log.info("chat runner stale", { sessionId, conversationId, durationMs: durationMs(start), error: errorMessage(err) })
      else log.error("chat runner failed", { sessionId, conversationId, durationMs: durationMs(start), error: errorMessage(err), errorDetail: errorDetail(err) })
      throw err
    }
    drainPending(runner)
    await restoreParkedTurn(runner, conversationId)
    return runner
  }

  /** A turn that a restart cut while it waited parks again on the attached
   *  runner (ARCH-SESSIONS-038, PI-INTERACTION-102, PI-MODEL-039). The runner
   *  serves the session from its attach on, so a step that fails here is not
   *  a failed start: the runner stays, the cut turn stays as the transcript
   *  shows it, and the person's Resume continues it. */
  async function restoreParkedTurn(runner: ChatRunner, conversationId: string): Promise<void> {
    try {
      if ((await readChatTurnEndEvidence(ctx.projectionReader, conversationId, { restoreWait: true }))?.restoredWait && admitsWork()) await runner.hold()
      // A turn an unexpected exit cut while it waited for model capacity
      // waits again on attach, as a turn cut on background work parks again.
      if (admitsWork()) await runner.awaitOwedCapacity()
    } catch (err) {
      if (!admitsWork()) throw err
      const message = errorMessage(err)
      log.error("chat runner restore failed", { sessionId, conversationId, error: message, errorDetail: errorDetail(err) })
      ctx.onRunnerError?.(sessionId, message)
    }
  }

  /** The one transition out of `starting` for a start that rejected. A start
   *  that failed while the actor is open shows one failure notice
   *  (PI-INTERACTION-042) and waits for the next activation or message. A
   *  failed start is not work in flight: an entry that a client shows stays
   *  with its notice, as the tab's lifecycle is the session's, and an entry
   *  that no client shows any more leaves the store; input already committed
   *  stays in the conversation. */
  function failStartup(failed: RunnerStartup, error: unknown): void {
    if (startup !== failed) return
    if (error instanceof StaleStartupError || !admitsWork()) {
      startup = { kind: "none" }
      return
    }
    const message = errorMessage(error)
    startup = { kind: "failed", message }
    ctx.sessionStore.showStartupFailure(sessionId, `Chat startup failed: ${message}`)
    ctx.onRunnerError?.(sessionId, message)
    if (restWatch) {
      void mailbox.run(() => vacateFailedStart()).then((tail) => tail()).catch((cause: unknown) => { recordBackgroundFailure(log, "vacate failed start", { sessionId }, cause) })
    }
  }

  function enqueueChatFinish(message?: string): void {
    if (lifecycle.kind !== "open" || ctx.isDisposed()) return
    // A runner can call back while ordered work awaits its disposal. Enqueue
    // without awaiting that same mailbox; dispatch already logs any rejection.
    void dispatch({ kind: "chat.finish", message }).catch(() => {})
  }

  /** The runner has ended, so its entry leaves the store and this actor
   *  ends with it, even when the store refuses a write here: an actor that
   *  stayed would stay closing and refuse every later message. A refused
   *  write leaves the durable session marked active, as a crash does. */
  async function finishChat(message?: string): Promise<void> {
    const start = performance.now()
    const prepared = await prepareDeactivation(ctx, sessionId)
      .catch((error: unknown) => { recordBackgroundFailure(log, "prepare finished session deactivation", { sessionId }, error) })
    if (message) ctx.onRunnerError?.(sessionId, message)
    else ctx.onRunnerDone?.(sessionId)
    await endActor(prepared ? () => finalizeDisposition(ctx, sessionId, prepared) : undefined)
    log.info("session closed", { sessionId, disposition: "finished", failed: message !== undefined, durationMs: durationMs(start) })
  }

  /** The one transition to ended, and the only way the actor leaves the
   *  supervisor besides `retireIfUnused`. Every exit from closing reaches it,
   *  also when a step before it failed: a close, delete, or finish whose read
   *  or write fails must not leave an actor that refuses every later message.
   *  `finalize` writes the durable outcome of the one command that calls it.
   *  The first call ends the runtime: the entry leaves the store, `finalize`
   *  writes after the runner ended, and the actor is forgotten last, so a
   *  command sent meanwhile waits behind the write. A command that the
   *  mailbox accepted before an earlier one ended the actor still writes its
   *  outcome (a Close chat queued behind a release marks the chat inactive),
   *  but never vacates or forgets again, so it cannot remove a newer actor
   *  of the same session. A failed `finalize` leaves the durable session
   *  marked active, as a crash does. */
  async function endActor(finalize?: () => Promise<void>): Promise<void> {
    if (lifecycle.kind === "ended") {
      await finalize?.()
      return
    }
    lifecycle = { kind: "ended" }
    try {
      // Removing the store entry ends the runner; the transcript state and
      // conversation trees the entry kept resident go with it.
      cancelRestWork()
      inputControl.vacate()
      await ctx.sessionStore.remove(sessionId)
      await ctx.transcriptCache.release(sessionId)
      releaseReconciliationIndex()
      await finalize?.()
    } finally { ctx.forget(sessionId) }
  }

  /** A start that failed and has settled is at rest: its input already
   *  committed waits in the conversation, not in a turn, until the next
   *  activation or message starts the runner again. */
  function turnAtRest(): boolean {
    const entry = ctx.sessionStore.get(sessionId)
    if (entry?.kind !== "chat" || startup.kind === "failed") return true
    return pending.length === 0 && isTurnAtRest({ activity: entryActivity(entry), waitingOnBackgroundWork: entry.waitingOnBackgroundWork })
  }

  /** No client shows the chat any more (ARCH-RUNTIME-023). Its runner ends now when
   *  its turn is at rest; otherwise the turn finishes first, a send that
   *  waits for the runner included, and the runner ends when it comes to
   *  rest. A question that waits on the person is at rest and stays in the
   *  conversation for the next runner. The durable session stays as it is:
   *  its lifecycle, name, and conversation, and an empty chat is kept. */
  async function runRelease(): Promise<void> {
    // A closed tab's close already waits for the turn, and ends the runner with the chat.
    if (closeAtRest || ctx.sessionStore.get(sessionId)?.kind !== "chat") return
    if (turnAtRest()) {
      await endRunner()
      return
    }
    awaitRest()
  }

  /** The chat's tab closed (PI-INTERACTION-082). Nothing ends now: the turn,
   *  its background commands, and its subagents go on, and the chat stays
   *  active while they do. When the turn is at rest, the chat closes as an
   *  explicit close does. An activation before then cancels the close. */
  async function runCloseAtRest(): Promise<() => Promise<boolean>> {
    closeAtRest = true
    if (turnAtRest()) return closeNow()
    awaitRest()
    return ready(true)
  }

  function closeNow(): Promise<() => Promise<boolean>> {
    stopForClose()
    return runLifecycle("close")
  }

  /** A close ends the chat's work: no startup attaches any more, and the
   *  runtime interrupts a turn that runs with Close chat's cut, which waits
   *  for the person's Resume. */
  function stopForClose(): void {
    markClosing()
    ctx.sessionStore.prepareForShutdown(sessionId, "close")
  }

  /** What waits for the turn's rest: the chat's close when its tab closed,
   *  else the end of the runner. Runs in the mailbox; a close's tail runs after it. */
  async function settleAtRest(): Promise<() => Promise<boolean>> {
    if (closeAtRest) return closeNow()
    await endRunner()
    return ready(true)
  }

  function awaitRest(): void {
    if (restWatch) return
    log.debug("session end deferred to rest", { sessionId, close: closeAtRest, pending: pending.length })
    restWatch = ctx.sessionStore.onChange((changed) => {
      if ((changed && !changed.has(sessionId)) || !turnAtRest()) return
      // A send ahead in the mailbox can start a new turn after this check, so
      // the turn must still be at rest when its turn in the mailbox comes.
      void mailbox.run(async () => restWatch && turnAtRest() ? settleAtRest() : ready(true)).then((tail) => tail())
        .catch((error: unknown) => { recordBackgroundFailure(log, "end the runner at rest", { sessionId }, error) })
    }, "session-rest")
  }

  /** Tells the attached runner whether a client shows the chat (`SessionRuntimeActorContext.isShown`). A runner that
   *  attaches later reads it at its attach. */
  function show(next: boolean): void {
    ctx.sessionStore.get(sessionId)?.runner?.setShown(next)
  }

  /** A new activation shows the chat again, so its runner stays and the chat stays open. */
  function cancelRestWork(): void {
    restWatch?.()
    restWatch = undefined
    closeAtRest = false
  }

  async function endRunner(): Promise<void> {
    const start = performance.now()
    const entry = ctx.sessionStore.get(sessionId)
    const runner = entry?.kind === "chat" && entry.runner !== null
    markClosing()
    ctx.sessionStore.prepareForShutdown(sessionId, "runtime")
    await settleStartup()
    await endActor()
    log.info("session released", { sessionId, runner, durationMs: durationMs(start) })
  }

  async function vacateFailedStart(): Promise<() => Promise<boolean>> {
    // A close owns its own teardown, and a newer startup owns the entry.
    return lifecycle.kind === "open" && startup.kind === "failed" ? settleAtRest() : ready(false)
  }

  async function teardown(disposition: "delete" | "close"): Promise<ChildSessionDeletionPlan | null> {
    const start = performance.now()
    const entry = ctx.sessionStore.get(sessionId)
    let prepared: Awaited<ReturnType<typeof prepareDisposition>>
    let deletion: ChildSessionDeletionPlan | null
    try {
      prepared = await prepareDisposition(ctx, sessionId, disposition)
      deletion = prepared.kind === "delete" ? await ctx.manager.admitDeletion(sessionId) : null
    } catch (error) {
      await endActor()
      throw error
    }
    if (deletion) return deletion
    const decided = prepared
    await endActor(decided.kind === "delete" ? undefined : () => finalizeDisposition(ctx, sessionId, decided))
    log.info("session closed", { sessionId, disposition, tombstone: prepared.kind === "delete", entryKind: entry?.kind, durationMs: durationMs(start) })
    return deletion
  }

  async function ensureChatRunner(): Promise<ChatRunner> {
    const current = ctx.sessionStore.get(sessionId)
    if (current?.kind !== "chat") throw new Error(`No chat shell for ${sessionId}`)
    if (current.runner) {
      log.debug("ensure chat runner reused runner", { sessionId })
      drainPending(current.runner)
      return current.runner
    }
    if (ctx.isDisposed() || lifecycle.kind !== "open") throw new StaleStartupError(sessionId)
    if (startup.kind === "starting") {
      log.debug("ensure chat runner joined startup", { sessionId })
      return startup.promise
    }
    const promise = startChatRunner(current.conversationId)
    const starting: RunnerStartup = { kind: "starting", promise }
    startup = starting
    log.debug("ensure chat runner created startup", { sessionId })
    void promise.then(() => { if (startup === starting) startup = { kind: "none" } }, (error: unknown) => { failStartup(starting, error) })
    return promise
  }

  async function commitPreReadinessTurn(conversationId: string, input: ChatInputLike): Promise<void> {
    const start = performance.now()
    log.debug("pre-readiness turn commit start", { sessionId, conversationId, inputParts: chatInputParts(input) })
    await ensureDurableChatSession(durability, conversationId)
    const entryId = await writePreReadinessTurn(durability, conversationId, input)
    pending.push({ entryId, input })
    log.debug("pre-readiness turn commit done", { sessionId, conversationId, entryId, pending: pending.length, durationMs: durationMs(start) })
  }

  /** The ordered (mailbox-serialized) section of a send. An attached runner takes
   *  the input synchronously; a cold send renders the user turn and commits it
   *  durably - the part whose arrival order matters. It returns the
   *  un-serialized startup tail so two queued cold sends both commit durably
   *  before a slow runner attaches, rather than the second commit deadlocking
   *  behind the first send's host startup. The tail resolves the send's outcome. */
  async function runSend(input: ChatInputLike): Promise<() => Promise<SendChatOutcome>> {
    const unavailable = () => Promise.resolve<SendChatOutcome>({ ok: false, reason: `Session ${sessionId} is no longer available` })
    const shell = ctx.sessionStore.get(sessionId)
    if (shell?.kind !== "chat") return unavailable
    // A copy of a message the conversation holds is a receipt (ARCH-SESSIONS-030). It
    // is read before admission and every other refusal, so a recorded
    // message never comes back refused, and it records nothing. A runner
    // that ended before it took the message, such as one that a restart
    // replaced, starts again here, as the first send started it.
    const confirmedSubmissionIds = await recordedChatMessage(durability, shell.conversationId, input)
    if (confirmedSubmissionIds) {
      void ensureChatRunner().catch(() => {})
      return () => Promise.resolve({ ok: true, confirmedSubmissionIds })
    }
    // Read again after the ledger's read: a runner can attach meanwhile.
    const entry = ctx.sessionStore.get(sessionId)
    if (entry?.kind !== "chat") return unavailable
    const runner = entry.runner
    let activeOutcome: Promise<SendChatOutcome> | undefined
    if (runner) {
      const capabilities = await ctx.runnerCapabilities()
      await capabilities.authAdmission.admit(sessionId)
      activeOutcome = runnerSendOutcome(sessionId, input, runner.send(input))
    }
    // The sweep never decides the send: the runner may already hold the
    // input, and a failed sweep shows on the session as its own fault.
    const reconciliation = await ctx.reconcileChildSessionCompletions?.(
      sessionId,
      { deliverNotification: (notification) => backgroundNotifications.deliver(entry, notification) },
    ).catch((error: unknown) => {
      log.debug("send completion sweep failed", { sessionId, error: errorMessage(error) })
      return undefined
    })
    if (!entry.runner) await backgroundNotifications.drainHeld(entry)
    if (activeOutcome) return () => activeOutcome
    if ((reconciliation?.reconciledCount ?? 0) > 0) await refreshOpenChatDisplay(ctx, sessionId)
    const attached = ctx.sessionStore.get(sessionId)
    if (attached?.kind === "chat" && attached.runner) {
      const capabilities = await ctx.runnerCapabilities()
      await capabilities.authAdmission.admit(sessionId)
      const outcome = runnerSendOutcome(sessionId, input, attached.runner.send(input))
      return () => outcome
    }
    // Render before the durable commit, in the same synchronous frame as the
    // runner-null check above: an attach can only interleave at an await, so
    // the block is always in the store before attachChatRunner's display seed
    // captures it. The commit's continuation may then resume after an attach;
    // the tail's ensureChatRunner reuses the attached runner and drains the
    // pending delivery, so the input still reaches the model exactly once.
    renderPreRunnerTurn(ctx.sessionStore, sessionId, input)
    try {
      await commitPreReadinessTurn(entry.conversationId, input)
    } catch (err) {
      const message = errorMessage(err)
      const reason = renderUnsavedPreRunnerTurn(ctx.sessionStore, sessionId, message)
      ctx.onRunnerError?.(sessionId, message)
      return () => Promise.resolve({ ok: false, reason })
    }
    void ensureChatRunner().catch(() => {})
    return () => Promise.resolve({ ok: true })
  }

  function runRequestContext(input: ChatInputLike, context: string): () => Promise<boolean> {
    const entry = ctx.sessionStore.get(sessionId)
    if (entry?.kind !== "chat") return () => Promise.resolve(false)
    if (entry.runner) {
      const runner = entry.runner
      return async () => {
        await (await ctx.runnerCapabilities()).authAdmission.admit(sessionId)
        return runner.requestWithContext(input, context)
      }
    }
    return () => ensureChatRunner().then((runner) => runner.requestWithContext(input, context)).catch(() => false)
  }

  /** Orders lifecycle admission, then settles deletion outside the mailbox.
   * Explicit closes invalidate startup before ordering. Conditional cleanup
   * does so only after admission, so refusal leaves an open tab untouched. */
  async function runLifecycle(disposition: "delete" | "close", inactiveBefore?: number): Promise<() => Promise<boolean>> {
    // An explicit close is already closing, so startup cannot attach.
    // Wait only briefly for orderly settlement; a wedged cold start must not
    // hold the close past the client's control deadline.
    if (inactiveBefore !== undefined && ctx.sessionStore.has(sessionId)) return ready(false)
    if (inactiveBefore === undefined) await settleStartup()
    const deletion = inactiveBefore === undefined ? await teardown(disposition) : await ctx.manager.admitDeletion(sessionId, inactiveBefore)
    if (inactiveBefore !== undefined) {
      if (!deletion?.targets.length) return ready(false)
      markClosing()
    }
    return async () => {
      if (deletion) {
        try { await ctx.executeChildSessionDeletion(deletion) } finally { await endActor() }
        if (inactiveBefore === undefined) log.info("session closed", { sessionId, disposition, tombstone: true })
      }
      return true
    }
  }

  /** The one transition from open to closing: the startup in flight can no
   *  longer attach a runner, every later one is refused, and no rest watch or
   *  message route outlives it. A runner's failure stays reported once, and
   *  an ended actor stays ended. */
  function markClosing(failure?: string): void {
    undo?.controller.abort()
    cancelRestWork()
    inputControl.vacate()
    if (lifecycle.kind === "open" || (lifecycle.kind === "closing" && lifecycle.failure === undefined && failure !== undefined)) {
      lifecycle = failure === undefined ? { kind: "closing" } : { kind: "closing", failure }
    }
  }

  async function runUndo(request: SessionChangesUndo): Promise<SessionChangesUndoResult> {
    if (lifecycle.kind !== "open" || ctx.isDisposed()) return { status: "refused", message: "Session is closing" }
    const controller = new AbortController()
    const operation = { controller, settled: Promise.resolve().then(() => ctx.undoChanges(request, controller.signal)) }
    undo = operation
    try { return await operation.settled }
    finally { undo = undefined }
  }

  // The tail of a command whose outcome is already settled inside the mailbox turn:
  // unlike `session.send`, these have no cold-start path, so their tail just yields the
  // value the ordered section already resolved.
  const ready = <A extends DispatchOutcome>(outcome: A): (() => Promise<A>) => () => Promise.resolve(outcome)

  /** Activation runs INSIDE the mailbox so concurrent entry points (picker open,
   *  a cold send's auto-activation) serialize on the has-check: the second call
   *  sees the shell the first one opened and returns without a second
   *  openSessionRuntime (which would reset the entry's runner to null).
   *
   *  Activation is stationary: it repairs the durable tree (terminal input
   *  committed after the shell closed gets its tool-result batch appended) but
   *  never starts a model turn. Only a user input wakes the continuation, so
   *  question settlement passes wake: true. */
  async function runActivation(options?: { wake: boolean }): Promise<() => Promise<boolean>> {
    if (lifecycle.kind !== "open" || ctx.isDisposed()) return ready(false)
    clearFailure()
    const activation = await activateDurableChat(ctx, sessionId)
    // An open shell can be behind the durable log: a child's completion sweep
    // or other work can commit while the shell has no runner.
    // A second client or a reattach can also open the session mid-turn, when
    // the display is ahead of the log, so that display stays.
    if (activation.status === "already-active") await refreshOpenChatDisplay(ctx, sessionId, { keep: "turnInFlight" })
    // A loadable durable chat already produced a turn, so no title regeneration.
    if (activation.status === "opened") titlePending = false
    let attachRunner = false
    if (activation.status !== "unavailable") {
      const entry = ctx.sessionStore.get(sessionId)
      if (entry?.kind === "chat") {
        await backgroundNotifications.drainHeld(entry)
        const recovered = activation.status === "opened" ? activation
          : await reconcileAgentInput({ conversationId: entry.conversationId, sessionId, store: ctx.eventStore, projectionReader: ctx.projectionReader, writer: ctx.eventWriter })
        // The settlement above is already durable; the wake reports whether a
        // runner resumed it.
        if (options?.wake && recovered.completedLeaf) return continuation.continueCommitted((runner) => runner.resumeCommitted())
        // A session a client shows holds its runner (ARCH-SESSIONS-038): activation
        // attaches it idle before acknowledging the tab. Startup joins the
        // mailbox after this ordered section; waiting here would deadlock.
        attachRunner = !entry.runner
      }
    }
    if (!attachRunner) return ready(activation.status !== "unavailable")
    return async () => {
      try {
        await ensureChatRunner()
        return true
      } catch (error) {
        // A close, release, or disposal superseded the startup, so the chat
        // did not open. That is the person's choice, not a startup failure.
        if (error instanceof StaleStartupError) return false
        throw error
      }
    }
  }

  /** Ordered rename: materializes a transient chat's durable row through the
   *  same ensureDurableChatSession the send path uses - serialized by this
   *  mailbox, so it can never race a cold send's materialization - then writes
   *  the durable label as a user rename (marking the session user-named) and
   *  mirrors it onto the live entry. */
  async function runRename(patch: SessionTitlePatch): Promise<boolean> {
    const entry = ctx.sessionStore.get(sessionId)
    if (!entry && await ctx.manager.read(sessionId) === null) return false
    if (entry?.kind === "chat") await ensureDurableChatSession(durability, entry.conversationId)
    const labels = (await ctx.manager.read(sessionId)) ? editedSessionLabels(patch) : null
    if (!labels) return false
    await ctx.manager.updateLabel(sessionId, labels, "user")
    const updated = await ctx.manager.read(sessionId)
    if (entry && updated) ctx.sessionStore.updateEntry(sessionId, { description: updated.label, shortDescription: updated.shortLabel })
    return true
  }

  /** Refuses a settlement with its reason, which the mutation states in
   *  words, and one record that names the reason and no content. */
  function refuseQuestion(toolUseId: string, refusal: QuestionRefusal): () => Promise<QuestionSettlementOutcome> {
    DebugLog.record({ type: "question.settlement.refused", sessionId, payload: { toolUseId, refusal } })
    return ready({ ok: false, refusal })
  }
  async function settleQuestion(command: Extract<SessionMutation, { kind: "question.answer" | "question.cancel" }>): Promise<() => Promise<QuestionSettlementOutcome>> {
    const interaction = (await loadAgentInputProjection(ctx.projectionReader, sessionId)).get(command.toolUseId)
    if (interaction?.toolUseId !== command.toolUseId) return refuseQuestion(command.toolUseId, "not_pending")
    if (interaction.kind === "answered" || interaction.kind === "cancelled") return refuseQuestion(command.toolUseId, interaction.kind === "answered" ? "already_answered" : "already_skipped")
    if (interaction.kind !== "pending") return refuseQuestion(command.toolUseId, "not_pending")
    if (command.kind === "question.answer" && !validAgentInputAnswers(interaction, command.answers)) return refuseQuestion(command.toolUseId, "invalid_answer")
    // Only a chat asks the person (PI-AGENT-024). An agent of a workflow of an
    // earlier build can still hold an open question; the person's answer or
    // cancel resumes the workflow, which folds it into the agent's conversation. A question
    // nobody settles is withdrawn when the workflow resumes. Remove the
    // workflow branch after 2027-04-03.
    const session = await ctx.manager.read(sessionId)
    const kind = session?.kind ?? ctx.sessionStore.get(sessionId)?.kind
    const retiredWorkflowId = session?.kind === "workflow-agent" ? session.workflowMembership.workflowId : undefined
    const retiredAgentQuestion = retiredWorkflowId !== undefined && ctx.resumeWorkflow !== undefined
    if (kind !== "chat" && !retiredAgentQuestion) return refuseQuestion(command.toolUseId, "not_chat")
    const writer = createSessionFactWriter({ sessionId, writer: ctx.eventWriter })
    try {
      await writer.record(questionSettlementFact(interaction.interactionId, command))
    } finally {
      writer.dispose()
    }
    if (retiredAgentQuestion) {
      // The durable fact above is the authority; the resume folds it into the
      // agent's conversation before any agent of the workflow re-enters.
      log.info("retired agent question settled", { sessionId, toolUseId: command.toolUseId, settlement: command.kind })
      try { await ctx.resumeWorkflow?.(retiredWorkflowId) }
      catch (error) { ctx.onRunnerError?.(sessionId, errorMessage(error)) }
      return ready({ ok: true })
    }

    // The live display follows the committed settlement on every path. A
    // question no tool waits on any more (suspended, then the conversation
    // moved on) has no waiter to show it, and the reseed below keeps the
    // display of a turn in flight, so nothing else would.
    const waiting = ctx.sessionStore.get(sessionId)
    waiting?.runner?.applyProjectionEvent(questionSettlementDisplay(command))
    if (waiting?.runner && waiting.runnerState === "awaiting_user") {
      const delivered = command.kind === "question.answer"
        ? ctx.sessionStore.answerQuestion(sessionId, command.toolUseId, command.answers)
        : ctx.sessionStore.cancelQuestion(sessionId, command.toolUseId)
      if (delivered) return ready({ ok: true })
    }
    try {
      const wake = await runActivation({ wake: true })
      return async () => {
        try { await wake() }
        catch (error) { ctx.onRunnerError?.(sessionId, errorMessage(error)) }
        return { ok: true }
      }
    } catch (error) {
      ctx.onRunnerError?.(sessionId, errorMessage(error))
      return ready({ ok: true })
    }
  }

  /** The manual review (`/learn`) is new optional Learning work, so a roster
   *  this client kept from before a disable is refused here rather than at the
   *  runner: nothing is asked of the review until current policy admits it. */
  async function learnFromSession(): Promise<boolean> {
    const admission = await (await ctx.runnerCapabilities()).capabilities?.admit({ operation: "the /learn review", required: moduleRequirementsForContribution("commands", "learn") })
    if (admission && !admission.ok) {
      log.info("learn refused", { sessionId, reason: admission.reason })
      return false
    }
    return ctx.sessionStore.learnFromSession(sessionId)
  }

  /** The serialized body of one command, returning the un-serialized tail that
   *  resolves its outcome. The mailbox advances when this Promise settles, so a
   *  delegated command (`chat.compact`, `recall`) - which finishes
   *  its whole turn synchronously against the attached runner under
   *  `SessionStore`'s `activeEntry` rule (no runner => false/null) - holds the
   *  mailbox only for that turn. Cold send and question-recovery tails start the
   *  host after the mailbox advances, so attach can enter its own ordered phase.
   *  A lifecycle command waits for
   *  any in-flight startup to settle, then tears down. The exhaustive switch
   *  verifies every arm produces a `DispatchOutcome`; `dispatch` correlates that to
   *  the caller's `C`. */
  async function orderedSection(command: SessionMutation): Promise<() => Promise<DispatchOutcome>> {
    switch (command.kind) {
      case "session.changes.undo":
        return ready(await runUndo(command.request))
      case "session.activate":
        cancelRestWork()
        if (command.shown) show(true)
        return runActivation()
      case "session.release":
        show(false)
        await runRelease()
        return ready(true)
      case "session.hide":
        show(false)
        return ready(true)
      case "session.send":
        return runSend(command.input)
      case "chat.resume":
        return continuation.resume()
      case "operation.accept":
        return continuation.accept(command.operation)
      case "chat.request_context":
        return runRequestContext(command.input, command.context)
      case "question.answer":
        return settleQuestion(command)
      case "background.terminate":
        ctx.sessionStore.terminateBackgroundWork(sessionId, command.toolUseId)
        return ready(true)
      case "question.cancel":
        return settleQuestion(command)
      case "chat.compact":
        await (await ctx.runnerCapabilities()).authAdmission.admit(sessionId)
        return ready(await ctx.sessionStore.compactConversation(sessionId))
      case "chat.learn":
        return ready(await learnFromSession())
      case "recall-input": return ready(await liveSessionControl(ctx.projectionReader, sessionId)?.recallQueuedMessage?.() ?? null)
      case "session.rename":
        return ready(await runRename(command))
      case "chat.finish":
        await finishChat(command.message)
        return ready(true)
      case "session.close":
        return command.atRest ? runCloseAtRest() : runLifecycle("close")
      case "session.delete":
        return runLifecycle("delete", command.inactiveBefore)
      case "session.discard_transient":
        return runLifecycle("delete")
    }
  }

  function dispatch<C extends SessionMutation>(command: C): Promise<DispatchResult<C>> {
    const start = performance.now()
    log.debug("dispatch start", { sessionId, command: command.kind, lifecycle: lifecycle.kind })
    // Lifecycle commands run a synchronous preflight the instant they are
    // dispatched, before their ordered body waits behind the mailbox. Chat close
    // preserves durable input waits; workflow shutdown is awaited in teardown.
    // A tab's close ends no work, so it waits its turn in the mailbox.
    if (command.kind === "chat.finish") {
      // Report the failure at once, even when Undo delays the terminal cleanup.
      markClosing(ctx.sessionStore.get(sessionId)?.kind === "chat" ? command.message : undefined)
    } else if (command.kind === "session.close" && !command.atRest) {
      stopForClose()
    } else if ((command.kind === "session.delete" && command.inactiveBefore === undefined) || command.kind === "session.discard_transient") {
      markClosing()
    }
    // Only the ordered section holds the mailbox, never its tail, so a slow
    // `session.send` host startup cannot stall the next commit.
    const ordered = mailbox.run(() => orderedSection(command))
    // SAFETY: the switch produces exactly the outcome correlated to command.kind
    // (session.send -> SendChatOutcome, recall -> ChatInputLike|null, a question
    // settlement -> QuestionSettlementOutcome, else boolean) and
    // every arm is checked against DispatchOutcome. TypeScript cannot reduce the
    // open-generic DispatchResult<C> through a value-discriminated switch, so this
    // one boundary cast re-correlates the verified outcome to C.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: TypeScript cannot correlate the generic command with the exhaustive switch result
    return ownAcceptedWork(observeSessionDispatch(sessionId, command.kind, start, ordered.then((tail) => tail()))) as Promise<DispatchResult<C>>
  }

  async function reconcileChildSessionCompletions() {
    const entry = ctx.sessionStore.get(sessionId)
    const runner = entry?.runner
    // Answer and cancel need the mailbox to end the turn whose durability we
    // await. Only reconciliation itself can hold that mailbox.
    if (runner) await runner.awaitLogicalTurnDurability()
    return mailbox.run(async () => {
      const currentEntry = ctx.sessionStore.get(sessionId)
      const outcome = await ctx.reconcileChildSessionCompletions?.(
        sessionId,
        currentEntry
          ? { deliverNotification: (notification) => backgroundNotifications.deliver(currentEntry, notification) }
          : undefined,
      )
        ?? { reconciledCount: 0, workflowAggregateReads: 0 }
      if (currentEntry && !currentEntry.runner) await backgroundNotifications.drainHeld(currentEntry)
      if (outcome.reconciledCount > 0) await refreshOpenChatDisplay(ctx, sessionId)
      return outcome
    })
  }

  return {
    retireIfUnused() {
      if (ctx.sessionStore.has(sessionId) || hasAcceptedWork()) return
      lifecycle = { kind: "ended" }
      releaseReconciliationIndex()
      ctx.forget(sessionId)
    },
    reconcileChildSessionCompletions,
    startTitleGeneration() { titlePending = true },
    ensureChatRunner,
    dispatch,
    // The runtime's planned stop, which records a runtime interrupt through
    // the teardown abort rather than a person's.
    prepareForShutdown(by) { ctx.sessionStore.prepareForShutdown(sessionId, by) },
    markClosing,
    settleStartup,
    awaitAcceptedWork,
    hasAcceptedWork,
    joinOrderedWork: () => mailbox.settled(),
    shouldTombstone: () => shouldTombstone(ctx, sessionId),
    closeSettled: async (disposition) => {
      const prepared = await prepareDisposition(ctx, sessionId, disposition)
      if (prepared.kind === "delete") {
        await ctx.executeChildSessionDeletion(await ctx.manager.admitDeletion(sessionId))
      } else {
        await finalizeDisposition(ctx, sessionId, prepared)
      }
    },
    runtimeState() {
      if (lifecycle.kind === "closing" && lifecycle.failure !== undefined) return { kind: "failed", message: lifecycle.failure }
      if (startup.kind === "failed") return { kind: "failed", message: startup.message }
      return startup.kind === "starting" ? { kind: "starting" } : null
    },
  }
}
