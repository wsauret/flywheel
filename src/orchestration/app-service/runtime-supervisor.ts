import { EventReaderService, EventStoreWriterService } from "../../infra/event-store-effect.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { loggedOperation } from "../../infra/operation-log.js"
import { startupTrace } from "../../infra/startup-trace.js"
import type { ChatInputLike } from "../../infra/chat-input.js"
import type { ChatRunner } from "../chat/runner-types.js"
import type { WorkflowRunner } from "../workflow-host/runner-types.js"
import { readWorkflowStatees } from "../../workflows/view/view-store.js"
import type { AgentInputAnswer } from "../../protocol/question-protocol-types.js"
import type { SessionRuntimeView, SessionTitlePatch } from "../../protocol/app-service-types.js"
import { chatDurabilityContext, createDurableChatSession } from "./session-chat-durability.js"
import { createSessionRuntimeActor } from "./session-runtime-actor.js"
import type { SessionRuntimeActor, SessionRuntimeActorContext } from "./session-runtime-actor-types.js"
import type { QuestionSettlementOutcome, ResumeChatOutcome, RuntimeSupervisor, RuntimeSupervisorDeps, SendChatOutcome } from "./runtime-supervisor-types.js"
import { createTranscriptProjectionCache } from "./transcript-projection-cache.js"
import { attachedRunnerDelivery } from "./session-background-notifications.js"
import { liveChildRun, liveChildRuns, liveSessionControl } from "../session/live-session-control.js"
import { isEmptyChat } from "../session/empty-chat.js"
import type { SessionKind } from "../session/types.js"
import { suspendReplyWaits } from "../session/reply-waits.js"
import { authorizePlannedSessionContinuation, continuationTargetId, interruptChildForReplacement, pendingRetainedOperationContinuations, plannedContinuationsFor, readPlannedSessionContinuationAsync, retirePlannedSessionContinuation } from "../session/planned-session-continuation.js"
import { commandHandoversForAsync } from "../session/command-handover.js"
import type { ControlInterruption, RuntimeInterruption } from "../session/conversation/turn-end-record.js"
import type { WorkflowDeliveryAddress } from "../session/conversation/addressed-workflow-messages.js"
import type { SuccessorRows } from "./project-executor-protocol.js"
import { turnInFlight } from "../session-store/view.js"
import { entryActivity } from "../session-store/activity.js"
import { claimComposerReturns } from "../session/composer-returns.js"
import { isActiveActivity } from "../../protocol/app-service-types.js"
import type { RetainedOperationAcceptance } from "../module-seams.js"
import {
  executeChildSessionDeletionPlan as executeDeletionPlan,
  type ChildSessionDeletionPlan,
} from "../session/child-session-deletion.js"

const log = Log.create({ service: "runtime-supervisor" })

interface QuestionAnswers {
  readonly [question: string]: AgentInputAnswer
}

export function createRuntimeSupervisor(deps: RuntimeSupervisorDeps): RuntimeSupervisor {
  const eventStore = deps.store ?? deps.runtime.runSync(EventReaderService)
  const eventWriter = deps.writer ?? deps.runtime.runSync(EventStoreWriterService)
  const transcriptCache = deps.transcriptCache ?? createTranscriptProjectionCache({ sessionStore: deps.sessionStore, reader: eventStore, projectionReader: deps.projectionReader, projectRoot: deps.directories.projectRoot })
  const actors = new Map<string, SessionRuntimeActor>()
  let disposed = false
  // After a stop that followed a planned replacement's cut: how many rows
  // the handoff holds in this project for the successor.
  let successorRowsAfterStop: SuccessorRows | undefined
  async function executeChildSessionDeletion(plan: ChildSessionDeletionPlan): Promise<void> {
    await executeDeletionPlan({
      projectRoot: deps.directories.projectRoot,
      reader: eventStore,
      projectionReader: deps.projectionReader,
      writer: eventWriter,
      read: deps.manager.read,
      finalizeDeletionTarget: async (target) => {
        if (target.kind === "workflow") return await deps.manager.finalizeDeletionTarget(target)
        await deps.sessionStore.abort(target.sessionId)
        await deps.sessionStore.remove(target.sessionId)
        return await deps.manager.finalizeDeletionTarget(target)
      },
      abort: async (sessionId) => { await deps.sessionStore.abort(sessionId) },
      deliverNotification: attachedRunnerDelivery(deps.sessionStore),
    }, plan)
  }
  /** The sessions that a client shows (`SessionRuntimeActorContext.isShown`). Only a client's activation, its release,
   *  its hide, and the session's close or deletion change it. */
  const shownSessions = new Set<string>()
  const actorContext: SessionRuntimeActorContext = {
    undoChanges: deps.undoChanges,
    transcriptCache,
    sessionStore: deps.sessionStore,
    manager: deps.manager,
    eventStore,
    projectionReader: deps.projectionReader,
    eventWriter,
    executeChildSessionDeletion,
    authProfileId: deps.authProfileId,
    ...(deps.sessionViewLoader ? { sessionViewLoader: deps.sessionViewLoader } : {}),
    directories: deps.directories,
    runtime: deps.runtime,
    runnerCapabilities: deps.runnerCapabilities,
    ...(deps.onRunnerDone ? { onRunnerDone: deps.onRunnerDone } : {}),
    ...(deps.onRunnerError ? { onRunnerError: deps.onRunnerError } : {}),
    ...(deps.resumeWorkflow ? { resumeWorkflow: deps.resumeWorkflow } : {}),
    ...(deps.retainedOperations ? { retainedOperations: deps.retainedOperations } : {}),
    ...(deps.reconcileChildSessionCompletions ? { reconcileChildSessionCompletions: deps.reconcileChildSessionCompletions } : {}),
    ...(deps.closeStartupGraceMs !== undefined ? { closeStartupGraceMs: deps.closeStartupGraceMs } : {}),
    isDisposed: () => disposed,
    isShown: (id) => shownSessions.has(id),
    forget: (id) => { actors.delete(id) },
  }
  function ensureActor(sessionId: string): SessionRuntimeActor {
    if (disposed) throw new Error("runtime supervisor is disposed")
    let actor = actors.get(sessionId)
    if (!actor) {
      actor = createSessionRuntimeActor(sessionId, actorContext)
      actors.set(sessionId, actor)
      log.debug("actor created", { sessionId, actors: actors.size })
    }
    return actor
  }
  async function reconcileChildSessionCompletions(parentSessionId: string) {
    // Workflow teardown can publish a result after admission closes. Keep its
    // notice durable without waking a runner that shutdown has already closed.
    if (disposed) return await deps.reconcileChildSessionCompletions?.(parentSessionId)
      ?? { reconciledCount: 0, workflowAggregateReads: 0 }
    return ensureActor(parentSessionId).reconcileChildSessionCompletions()
  }
  /** A client's start of a chat: it always opens a new chat and never takes
   *  or removes another one. */
  async function openSessionRuntime(options: { readonly name?: string } = {}): Promise<string> {
    return loggedOperation({ log, operation: "open chat shell", level: "debug", summarize: (sessionId) => ({ sessionId, actors: actors.size }) }, async () => {
      startupTrace("runtime openSessionRuntime start")
      const sessionId = deps.manager.allocateId()
      const conversationId = deps.manager.allocateId()
      startupTrace("runtime openSessionRuntime ids allocated")
      // The catalog projection is strict: a row needs durable metadata carrying
      // the canonical executionCwd (ARCH-DIRECTORIES-006), so the shell is never visible
      // before it. The id was allocated here, so the row is created without a
      // read, born with its auth profile; a later send or rename
      // reuses this row rather than creating a second one, and an untouched
      // blank shell is tombstoned on discard, close, or a stop that no client
      // holds the project through.
      await createDurableChatSession(chatDurabilityContext(actorContext, sessionId), conversationId, options.name === undefined ? {} : { name: options.name })
      startupTrace("runtime openSessionRuntime durable metadata published")
      const actor = ensureActor(sessionId)
      deps.sessionStore.openSessionRuntime({ sessionId, conversationId, description: options.name ?? "New Chat" })
      startupTrace("runtime openSessionRuntime store opened")
      // A named chat (a workflow launch's parent) takes its run's generated
      // name later, so it generates no title of its own.
      if (options.name === undefined) actor.startTitleGeneration()
      return sessionId
    })
  }
  function adoptBlankChat(options: { readonly sessionId: string; readonly conversationId: string; readonly description: string }): void {
    if (!deps.sessionStore.has(options.sessionId)) deps.sessionStore.openSessionRuntime(options)
    ensureActor(options.sessionId).startTitleGeneration()
  }
  function forkSession(sourceSessionId: string): Promise<string> {
    return loggedOperation(
      { log, operation: "fork session", level: "debug", fields: { sourceSessionId }, summarize: (destinationSessionId) => ({ destinationSessionId }) },
      () => deps.manager.forkChat(sourceSessionId),
    )
  }
  async function activateSession(sessionId: string, options?: { readonly shown?: true }): Promise<boolean> {
    // The supervisor's steps are DEBUG: the app-service dispatch record is the
    // one record of the user's mutation, and the actor records the session's
    // activation and close.
    // Activation is an ordered mailbox command: the actor serializes it against
    // concurrent activations and sends, closing the double-openSessionRuntime race.
    return loggedOperation(
      { log, operation: "activate session", level: "debug", fields: { sessionId }, summarize: (result) => ({ activated: result, actors: actors.size }) },
      () => {
        if (options?.shown === true) shownSessions.add(sessionId)
        return ensureActor(sessionId).dispatch({ kind: "session.activate", ...options })
      },
    )
  }
  function ensureChatRunner(sessionId: string): Promise<ChatRunner> {
    return loggedOperation({ log, operation: "ensure chat runner", level: "debug", fields: { sessionId } }, () => ensureActor(sessionId).ensureChatRunner())
  }
  /** Availability (activation, missing/inactive session) is the supervisor's
   *  job because it owns the session-view loader; the actor mailbox then
   *  serializes the runner-or-cold-commit work for the confirmed-available
   *  session. Callers check residency synchronously first: a turn on a
   *  resident session must enter the mailbox in the tick it was requested,
   *  ahead of a recall or command dispatched right after it. */
  async function activateChat(sessionId: string): Promise<boolean> {
    return await activateSession(sessionId) && deps.sessionStore.get(sessionId)?.kind === "chat"
  }
  const isResidentChat = (sessionId: string): boolean => deps.sessionStore.get(sessionId)?.kind === "chat"
  /** A delivered turn is proof the session is in use, so a paused session that takes one becomes active. */
  async function markActive(sessionId: string): Promise<void> {
    if ((await deps.manager.read(sessionId))?.lifecycleState === "inactive") await deps.manager.updateLifecycleState(sessionId, "active")
  }
  async function sessionKind(sessionId: string): Promise<SessionKind | undefined> {
    const kind = deps.sessionStore.get(sessionId)?.kind ?? (await deps.manager.read(sessionId))?.kind
    return kind === "workflow" ? undefined : kind
  }
  async function sendChat(sessionId: string, input: ChatInputLike): Promise<SendChatOutcome> {
    if (!isResidentChat(sessionId) && !(await activateChat(sessionId))) return { ok: false, reason: `Session ${sessionId} is no longer available` }
    const outcome = await loggedOperation(
      { log, operation: "send chat", level: "debug", fields: { sessionId }, summarize: (result) => ({ ok: result.ok }) },
      () => ensureActor(sessionId).dispatch({ kind: "session.send", input }),
    )
    if (outcome.ok) await markActive(sessionId)
    return outcome
  }
  async function acceptRetainedOperation(sessionId: string, operation: RetainedOperationAcceptance): Promise<boolean> {
    return ensureActor(sessionId).dispatch({ kind: "operation.accept", operation })
  }
  async function requestChatContext(sessionId: string, input: ChatInputLike, context: string): Promise<boolean> {
    if (!isResidentChat(sessionId) && !(await activateChat(sessionId))) return false
    const delivered = await loggedOperation(
      { log, operation: "request chat context", level: "debug", fields: { sessionId }, summarize: (result) => ({ delivered: result }) },
      () => ensureActor(sessionId).dispatch({ kind: "chat.request_context", input, context }),
    )
    if (delivered) await markActive(sessionId)
    return delivered
  }
  /** A session no actor holds has no runner to end; one with an actor takes
   *  the release through its mailbox, behind an activation or a send queued
   *  before it. */
  async function releaseSession(sessionId: string): Promise<void> {
    shownSessions.delete(sessionId)
    await actors.get(sessionId)?.dispatch({ kind: "session.release" })
  }
  async function hideSession(sessionId: string): Promise<void> {
    shownSessions.delete(sessionId)
    await actors.get(sessionId)?.dispatch({ kind: "session.hide" })
  }
  async function closeChat(sessionId: string, atRest?: true): Promise<boolean> {
    // Close is idempotent user intent: nothing may refuse it. A session unknown
    // to both the resident store and the durable record is already closed, so
    // report success. A durable but non-resident session (e.g. a workflow that
    // went inactive under an open tab) still gets its real teardown through the
    // actor, which no-ops the parts that no longer exist. A tab's close ends
    // no work, so the release of its last holder decides whether a client
    // still shows the chat.
    if (!atRest) shownSessions.delete(sessionId)
    if (!deps.sessionStore.get(sessionId) && await deps.manager.read(sessionId) === null) return true
    return ensureActor(sessionId).dispatch(atRest ? { kind: "session.close", atRest } : { kind: "session.close" })
  }
  async function discardTransientChat(sessionId: string): Promise<{ readonly removed: boolean }> {
    const entry = deps.sessionStore.get(sessionId)
    if (entry?.kind !== "chat" || entry.outputBlocks().length > 0) return { removed: false }
    const actor = ensureActor(sessionId)
    if (!await actor.shouldTombstone()) return { removed: false }
    await actor.dispatch({ kind: "session.discard_transient" })
    return { removed: true }
  }
  async function deleteSession(sessionId: string, inactiveBefore?: number): Promise<boolean> {
    if (inactiveBefore !== undefined) {
      const existing = actors.has(sessionId)
      const actor = ensureActor(sessionId)
      try {
        return await actor.dispatch({ kind: "session.delete", inactiveBefore })
      } finally {
        if (!existing && actors.get(sessionId) === actor) actor.retireIfUnused()
      }
    }
    if (!deps.sessionStore.has(sessionId) && await deps.manager.read(sessionId) === null) {
      // Unreadable metadata must not block removal: no live runtime exists for
      // a session that cannot be projected, so skip the actor and tombstone
      // directly (the metadata-store delete is unconditional by design).
      if (!await isCorruptSession(sessionId)) return false
      await executeChildSessionDeletion(await deps.manager.admitDeletion(sessionId))
      return true
    }
    shownSessions.delete(sessionId)
    await ensureActor(sessionId).dispatch({ kind: "session.delete" })
    return true
  }
  async function isCorruptSession(sessionId: string): Promise<boolean> {
    return (await deps.manager.listMetadata()).errors.some((error) => error.sessionId === sessionId)
  }
  async function renameSession(sessionId: string, patch: SessionTitlePatch): Promise<boolean> {
    if (!deps.sessionStore.has(sessionId) && await deps.manager.read(sessionId) === null) return false
    // Ordered mailbox command: rename may materialize a transient chat's
    // durable row, so it must serialize against a cold send doing the same.
    return ensureActor(sessionId).dispatch({ kind: "session.rename", ...patch })
  }
  function reorderSession(sessionId: string, beforeSessionId: string | null): boolean {
    return deps.sessionStore.reorder(sessionId, beforeSessionId)
  }
  /** Out-of-actor by design: a notice dismissal is a store patch, never runner
   *  coordination. Dismissing a scope with no raised notice is a successful
   *  no-op, matching resolve semantics everywhere else. */
  function dismissNotice(sessionId: string, scope: string): boolean {
    if (!deps.sessionStore.has(sessionId)) return false
    deps.sessionStore.updateEntry(sessionId, { noticeOperation: { operation: { type: "resolve-scope", scope }, timestamp: Date.now() } })
    return true
  }
  /** The one Interrupt of a session by a person or by the parent agent of
   *  a child. Preemptive and actor-free, like the detach below: a running
   *  turn, step, or subagent run is cut at once, and a session a planned
   *  replacement's cut left owed to its successor records the turn end that
   *  names `by` over the cut instead (`ContinuationLanes.interrupt`),
   *  through the live chat or workflow runner that holds its conversation.
   *  A subagent's run lives in its parent's runner, so its live control
   *  cuts it and settles it as interrupted. */
  function interruptSession(sessionId: string, by: ControlInterruption, address?: WorkflowDeliveryAddress): Promise<boolean> {
    const member = liveSessionControl(eventStore, sessionId)?.member
    if (member) return Promise.resolve(member.interrupt(by))
    const entry = () => deps.sessionStore.get(sessionId)
    const workflow = () => deps.workflowHosts.get(sessionId)
    const childRun = () => liveChildRun(eventStore, sessionId)?.child
    return deps.continuationLanes.interrupt({
      reader: eventStore,
      projectionReader: deps.projectionReader,
      writer: eventWriter,
      manager: deps.manager,
      sessionId,
      by,
      ...(address === undefined ? {} : { address }),
      runs: () => {
        if (workflow()) return deps.workflowHosts.isRunning(sessionId)
        if (childRun()) return true
        const current = entry()
        return current !== undefined && isActiveActivity(entryActivity(current))
      },
      interrupt: async () => {
        const host = workflow()
        if (host) return host.interrupt(by, address)
        const run = childRun()
        if (!run) return deps.sessionStore.interrupt(sessionId, by, address)
        await run.interrupt(by)
        return true
      },
      owner: () => { const current = entry(); return workflow() ?? (current?.kind === "chat" ? current.runner ?? undefined : undefined) },
    })
  }
  async function resumeChat(sessionId: string): Promise<ResumeChatOutcome> {
    // A resume is new work on the session, so it activates the session the
    // way a send does: the runner it starts is the session's, and the row
    // that admits Interrupt while the turn runs reads the active lifecycle.
    if (!isResidentChat(sessionId) && !(await activateChat(sessionId))) return { ok: false, reason: `Session ${sessionId} is no longer available` }
    if ((await deps.manager.read(sessionId))?.lifecycleState === "inactive") await deps.manager.updateLifecycleState(sessionId, "active")
    return ensureActor(sessionId).dispatch({ kind: "chat.resume" })
  }
  function releaseForegroundBash(sessionId: string, toolUseId: string): boolean {
    // Preemptive and actor-free: the hold lives on the runner in the shared
    // session store, and workflow sessions have no per-session chat actor.
    return liveSessionControl(eventStore, sessionId)?.member?.releaseForegroundBash(toolUseId)
      ?? deps.sessionStore.releaseForegroundBash(sessionId, toolUseId)
  }
  /** A person's Stop of one background call of a chat. A call that
   *  launched a child stops through the child's durable binding, and the
   *  child kind's installed owner settles it, so no runner has to hold the
   *  call: the Stop works for every launch origin and after the chat's runner
   *  restarted or ended. It runs outside the chat's mailbox, so a Stop never
   *  waits for the chat's running turn. A command a planned
   *  replacement handed over stops through the keeper; other work, and a
   *  child whose kind no module stops this way, through the runner. */
  async function terminateBackgroundWork(sessionId: string, toolUseId: string): Promise<void> {
    if (deps.keeper?.terminate(sessionId, toolUseId)) return
    const settle = await deps.sessionStops?.(sessionId, toolUseId)
    log.info("background stop routed", { sessionId, route: settle ? "child-binding" : "runner" })
    if (settle) {
      const answer = await settle()
      if (!answer.ok) throw new Error(answer.error)
    } else {
      const member = liveSessionControl(eventStore, sessionId)?.member
      if (member) member.terminateBackgroundWork(toolUseId)
      else await ensureActor(sessionId).dispatch({ kind: "background.terminate", toolUseId })
    }
  }
  function answerQuestion(sessionId: string, toolUseId: string, answers: QuestionAnswers): Promise<QuestionSettlementOutcome> {
    return ensureActor(sessionId).dispatch({ kind: "question.answer", toolUseId, answers })
  }
  function cancelQuestion(sessionId: string, toolUseId: string): Promise<QuestionSettlementOutcome> {
    return ensureActor(sessionId).dispatch({ kind: "question.cancel", toolUseId })
  }
  function compactChat(sessionId: string): Promise<boolean> {
    const member = liveSessionControl(eventStore, sessionId)?.member
    if (member) return member.compact()
    return ensureActor(sessionId).dispatch({ kind: "chat.compact" })
  }
  function reviewChat(sessionId: string): Promise<boolean> {
    return ensureActor(sessionId).dispatch({ kind: "chat.learn" })
  }
  async function recallQueuedMessage(sessionId: string): Promise<ChatInputLike | null> {
    return await ensureActor(sessionId).dispatch({ kind: "recall-input" })
  }
  function runtimeState(sessionId: string): Extract<SessionRuntimeView, { kind: "starting" | "failed" }> | null {
    return actors.get(sessionId)?.runtimeState() ?? null
  }
  async function awaitAcceptedWork(): Promise<void> {
    let joined: readonly SessionRuntimeActor[]
    do {
      joined = [...actors.values()]
      await Promise.all(joined.map((actor) => actor.awaitAcceptedWork()))
    } while ([...actors.values()].some((actor) => !joined.includes(actor) || actor.hasAcceptedWork()))
  }
  function warmChatRunner(): Promise<void> {
    return deps.runnerCapabilities().then(({ runnerLoader }) => runnerLoader.warm(), () => {})
  }
  /** A planned replacement's cut of everything running (PI-REMOTE-012):
   *  every child an owner here runs, every chat turn including one parked on
   *  a question, and every agent of a workflow, each by its step below. A session
   *  a person interrupted is idle and gets no row. A running shell command
   *  is never cut here: the cut first moves every held foreground command to
   *  the background, and each command's owner hands it to the successor
   *  when it closes. Once this executor's stop begins, the cut starts no
   *  further step, because the stop runs the same steps for everything the
   *  cut has not reached. Returns the sessions it interrupted. */
  async function interruptForReplacement(handoffId: string): Promise<readonly string[]> {
    const reached = (sessionIds: readonly string[]): readonly string[] => disposed ? [] : sessionIds
    return loggedOperation({ log, operation: "interrupt for replacement", fields: { handoffId }, summarize: (ids) => ({ interrupted: ids.length }) }, () =>
      cutInLanes(reached, handoffId, () => !disposed))
  }
  /** Runs the cut's steps, each in its session's continuation lane, where
   *  the steps of one session take turns with a person's interrupt of it: an
   *  interrupt that arrives during a step waits for it and then wins. Every
   *  held foreground command here moves to the background first, because a
   *  step's interrupt ends a command that is still in its hold. The
   *  children's steps run next and the chats' and workflows' after them,
   *  each over the sessions `select` keeps of those running as it begins.
   *  The second phase runs whatever the first's steps did, so a child whose
   *  pause fails keeps no chat or workflow from the planned cut. Settles
   *  once every step has settled, so no step still runs when the caller goes
   *  on; then throws one AggregateError of every step that failed, or
   *  answers the sessions a step interrupted. */
  async function cutInLanes(select: (sessionIds: readonly string[]) => readonly string[], handoffId: string, mayRetire: () => boolean): Promise<readonly string[]> {
    await transferForegroundForReplacement()
    const settle = (sessionIds: readonly string[], step: (sessionId: string) => Promise<boolean>) => Promise.all(sessionIds.map((sessionId) =>
      deps.continuationLanes.run(sessionId, () => step(sessionId)).then((interrupted) => ({ sessionId, interrupted }), (error: unknown) => ({ sessionId, error }))))
    const children = await settle(select(liveChildRuns(eventStore).map((control) => control.sessionId)), (sessionId) => cutChild(sessionId, handoffId))
    const workflows = await settle(select(deps.workflowHosts.allIds()), (id) => cutWorkflow(id, handoffId, mayRetire))
    const sessions = await settle(select(deps.sessionStore.allIds()), (sessionId) => cutSession(sessionId, handoffId, mayRetire))
    const outcomes = [...children, ...workflows, ...sessions]
    const failures = outcomes.flatMap((outcome) => "error" in outcome ? [outcome.error] : [])
    if (failures.length > 0) throw new AggregateError(failures, "the replacement's cut failed for some work")
    return outcomes.flatMap((outcome) => "interrupted" in outcome && outcome.interrupted ? [outcome.sessionId] : [])
  }
  /** Moves every held foreground command of every session here to the
   *  background, and settles once each moved command is tracked or has
   *  ended. A child's held commands are its parent's, so the move covers
   *  them before any child's pause. */
  async function transferForegroundForReplacement(): Promise<void> {
    await Promise.all([
      ...deps.sessionStore.allIds().map((sessionId) => deps.sessionStore.transferForegroundForReplacement(sessionId)),
      ...deps.workflowHosts.allIds().map((id) => deps.workflowHosts.get(id)?.transferForegroundForReplacement()),
    ])
  }
  /** The cut's step for one child: the run it runs now gets its
   *  continuation row, then the runtime's planned interrupt. A child that no
   *  longer runs, or whose row of this handoff names the run it runs now, is
   *  the cut's already. Returns whether it interrupted the run. */
  async function cutChild(sessionId: string, handoffId: string): Promise<boolean> {
    const control = liveChildRun(eventStore, sessionId)
    if (control === undefined) return false
    const row = await readPlannedSessionContinuationAsync(deps.projectionReader, sessionId)
    if (row?.handoffId === handoffId && row.runId === control.child.runId) return false
    await interruptChildForReplacement({ projectionReader: deps.projectionReader, writer: eventWriter, control, handoffId })
    return true
  }
  /** The cut's step for one chat or workflow: a running turn is cut, and
   *  deterministic work accepted at its save point is carried without a turn.
   *  The work gets its continuation row before the runtime interrupts it. A
   *  turn that turned out to have ended loses the row again, unless the
   *  session held this handoff's row before the step, which is the cut's own
   *  interrupt and still stands, or `mayRetire` no longer holds: a step of
   *  the cut that finishes after the stop began never retires, because the
   *  stop may have interrupted that turn already. Returns whether it
   *  interrupted a running turn. */
  async function cutSession(sessionId: string, handoffId: string, mayRetire: () => boolean): Promise<boolean> {
    const entry = deps.sessionStore.get(sessionId)
    if (!entry || entry.kind !== "chat") return false
    const operations = entry.kind === "chat"
      ? await pendingRetainedOperationContinuations({
          reader: eventStore,
          projectionReader: deps.projectionReader,
          manager: deps.manager,
          sessionId,
          conversationId: entry.conversationId,
        })
      : []
    // A chat's runner answers whether its turn runs, by the one test its
    // interrupt cuts by, and never the session's published activity: that
    // reads idle once the turn's logical end is reported, while the loop can
    // still run a further request, such as the reply nudge after a silent
    // background launch. A step that skipped such a turn would leave it to
    // the stop's ordinary interrupt, with no row for a successor to resume.
    const turnRuns = entry.runner !== null
      && (entry.kind === "chat" ? entry.runner.holdsRunningTurn() : turnInFlight(entry))
    if (!turnRuns && operations.length === 0) return false
    const held = (await readPlannedSessionContinuationAsync(deps.projectionReader, sessionId))?.handoffId === handoffId
    await authorizePlannedSessionContinuation({
      reader: deps.projectionReader,
      writer: eventWriter,
      continuation: {
        target: { sessionId, kind: entry.kind },
        handoffId,
        ...(operations.length > 0 ? { operations } : {}),
      },
    })
    if (!turnRuns) return true
    if (await deps.sessionStore.interruptForReplacement(sessionId)) return true
    if (operations.length === 0 && !held && mayRetire()) await retirePlannedSessionContinuation({ reader: deps.projectionReader, writer: eventWriter, sessionId })
    return false
  }
  /** The cut's step for one hosted workflow: the workflow gets its
   *  continuation row, then the runtime cuts its running agents. A workflow
   *  with no agent to cut loses the row again only when no successor
   *  continues it: a person or an agent paused every started agent, or its
   *  committed control is terminal or paused. A running workflow holds no
   *  worker while it decides or prepares its next attempt, and it keeps the
   *  row, because the successor is then its only continuation. The row also
   *  stays when the workflow held this handoff's row before the step, which
   *  is the cut's own interrupt, or when `mayRetire` no longer holds, as
   *  `cutSession` keeps a chat's. Returns whether it interrupted an agent. */
  async function cutWorkflow(workflowId: string, handoffId: string, mayRetire: () => boolean): Promise<boolean> {
    const host = deps.workflowHosts.get(workflowId)
    if (!host) return false
    const held = (await readPlannedSessionContinuationAsync(deps.projectionReader, workflowId))?.handoffId === handoffId
    await authorizePlannedSessionContinuation({ reader: deps.projectionReader, writer: eventWriter, continuation: {
      target: { kind: "workflow", workflowId }, handoffId,
    } })
    if (await host.interruptForReplacement()) return true
    if (!held && mayRetire() && await workflowRests(workflowId, host)) await retirePlannedSessionContinuation({ reader: deps.projectionReader, writer: eventWriter, sessionId: workflowId })
    return false
  }
  async function workflowRests(workflowId: string, host: WorkflowRunner): Promise<boolean> {
    if (host.interruption() !== undefined) return true
    const status = (await readWorkflowStatees([workflowId], deps.projectionReader)).statuses.get(workflowId)
    return status === "completed" || status === "failed" || status === "paused"
  }
  /** The stop's share of a planned replacement's cut: the cut's own steps,
   *  in the same lanes, for every child and session the cut has not reached
   *  or whose work was admitted after the cut, such as a message from
   *  another surface, a queued message, a workflow that advanced, or a child
   *  that started. So an agent of a workflow parks as the cut parks it, each
   *  interrupt is the planned cut, which no surface shows, and a person's
   *  interrupt during a step waits for it
   *  and then wins. A session whose lane holds a step already, such as a
   *  step of the cut still running, is left to that step, because two steps
   *  would each interrupt it and a step of the cut may never settle; the
   *  stop still ends its running turn as the cut ends it
   *  (`stopInterruption`). The stop goes on only once every step it ran has
   *  settled. */
  async function cutWorkAfterCut(handoffId: string): Promise<void> {
    const unreached = (sessionIds: readonly string[]): readonly string[] => sessionIds.filter((sessionId) => !deps.continuationLanes.busy(sessionId))
    await cutInLanes(unreached, handoffId, () => true)
  }
  /** How the stop ends each session's running turn, read once the stop's
   *  steps have settled (PI-REMOTE-012). A turn that the handoff owns ends
   *  as the cut ends it, with the planned record that no surface shows,
   *  because the successor resumes it: a session that holds the handoff's
   *  row, or one whose lane still holds a step of the cut, which writes that
   *  row, such as a cut that had not settled at the cut limit. Every other
   *  turn, and every turn of a stop that no replacement planned, takes the
   *  ordinary runtime interrupt, which every surface shows with its Resume,
   *  since no successor continues it. */
  async function stopInterruption(handoffId: string | undefined): Promise<(sessionId: string) => RuntimeInterruption> {
    if (handoffId === undefined) return () => "runtime"
    // A failed read must not skip the ordered teardown after it. A turn the
    // cut reached still ends as the cut ends it, and a turn it did not reach
    // takes the runtime interrupt, which keeps its Resume.
    const rows = await plannedContinuationsFor(deps.projectionReader, handoffId).catch((error: unknown) => {
      log.warn("the replacement's continuation rows could not be read; each turn the cut has not reached stops with the runtime interrupt", { handoffId, error: errorMessage(error) })
      return []
    })
    const held = new Set(rows.map((row) => continuationTargetId(row.target)))
    return (sessionId) => held.has(sessionId) || deps.continuationLanes.busy(sessionId) ? "replacement" : "runtime"
  }
  /** The continuation and handover rows the handoff holds here for the
   *  successor, counted once the stop has settled. A failed read must not
   *  mask the stop's own failures. It gives no count, and never a wrong
   *  count: with no count, the successor keeps the project named and reads
   *  its rows itself. */
  async function countSuccessorRows(handoffId: string): Promise<SuccessorRows | undefined> {
    try {
      const [continuations, handovers] = await Promise.all([plannedContinuationsFor(deps.projectionReader, handoffId), commandHandoversForAsync(deps.projectionReader, handoffId)])
      return { continuations: continuations.length, handovers: handovers.length }
    } catch (error) {
      log.warn("the replacement's successor rows could not be counted; the successor keeps the project named and reads its rows itself", { handoffId, error: errorMessage(error) })
      return undefined
    }
  }
  /** Ordered teardown for every session actor this supervisor owns. Marking
   *  closing invalidates in-flight startups, and each retained settlement joins
   *  the store and auth lifecycle promises supplied by the composition owner.
   *  After a planned replacement's cut has begun, the cut's steps run first
   *  for what it has not cut, and the continuation and handover rows the
   *  handoff then holds here are counted once everything has settled. From
   *  the stop's first step on, every host that closes, and the keeper that
   *  closes once every host has closed with its runner, closes for the
   *  replacement and hands its running commands over. A stop that a client holds the project through
   *  is a runtime restart: each tab that client shows attaches its session
   *  again, to the next generation or the next service, so the stop keeps a
   *  blank chat for it. A stop that no client holds the
   *  project through, such as the project's sleep, is the close of every
   *  tab: it discards a blank chat as a tab's close does, and it removes each
   *  paused empty chat, which no tab closes (PI-INTERACTION-075, ARCH-RUNTIME-024). Whether a replacement
   *  planned the stop decides only how the stop ends the turns its handoff
   *  owns (`stopInterruption`). The one record of the stop names that
   *  decision and what it removed. */
  async function disposeAll(): Promise<void> {
    const clientsHold = deps.clientsHold()
    await loggedOperation({ log, operation: "dispose all", level: "info", fields: { actors: actors.size, clientsHold }, summarize: (removed) => ({ removedEmptyChats: removed }) }, async () => {
      // The sessions open here as the stop begins: each actor decides its own.
      const open = new Set([...deps.sessionStore.allIds(), ...actors.keys()])
      disposed = true
      // A stop ends no reply wait: each stays held, and the next runtime
      // registers it again and applies the end rules (ARCH-SESSIONS-032).
      suspendReplyWaits(deps.projectionReader)
      const handoffId = deps.replacementHandoff?.()
      if (handoffId !== undefined) {
        deps.onReplacementStop?.()
        await cutWorkAfterCut(handoffId).catch((error: unknown) => {
          log.warn("work the replacement's cut did not reach could not be cut; it stops interrupted for a person to resume", { handoffId, error: errorMessage(error) })
        })
      }
      const disposition = clientsHold ? "restart" : "close"
      const opened = [...actors]
      const closing = opened.map(([, actor]) => actor)
      for (const actor of closing) actor.markClosing(disposition)
      // Shutdown shelves turns; it never speaks the Escape verb. The user
      // interrupt path records a durable "Interrupted by user." marker as
      // confirmation of intent, and a runtime that is merely stopping must
      // not forge that record. The session store's settlement below aborts
      // each workflow with the same interruption.
      const stopBy = await stopInterruption(handoffId)
      for (const [sessionId, actor] of opened) actor.prepareForShutdown(stopBy(sessionId))
      // A startup that fails is a settled startup: only the close settlements
      // below carry an unsafe outcome worth reporting.
      await Promise.allSettled(closing.map((actor) => actor.settleStartup()))
      // Startup may materialize durable metadata after the first preemptive mark.
      // Re-capture disposition while store entries are still resident, then drain.
      for (const actor of closing) actor.markClosing(disposition)
      await Promise.all(closing.map(actor => actor.joinOrderedWork()))
      const actorSettlements = await Promise.allSettled(closing.map((actor) => actor.closeSettled()))
      const removed = clientsHold ? [] : await removePausedEmptyChats(open)
      const settlements = await Promise.allSettled([
        ...(deps.transcriptCache ? [] : [transcriptCache.dispose()]),
        deps.lifecycle.settleSessionStore(stopBy),
      ])
      // The keeper closes once every host has closed with its runner, so no
      // host's adoption can still take a command the keeper hands over or ends.
      const keeperSettlement = await Promise.allSettled([deps.keeper?.close()])
      const authSettlement = await Promise.allSettled([deps.lifecycle.settleAuthAdmission()])
      if (handoffId !== undefined) successorRowsAfterStop = await countSuccessorRows(handoffId)
      actors.clear()
      const failures = [...actorSettlements, ...settlements, ...keeperSettlement, ...authSettlement].flatMap((settlement) => settlement.status === "rejected" ? [settlement.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, "runtime supervisor disposal failed")
      return removed
    })
  }
  /** The paused empty chats that no tab will close: an earlier stop that a
   *  client held, a recovery, or the close of a tab while the executor
   *  recovered from an exit paused each one. The catalog metadata names the
   *  candidates, a paused chat with the label every new chat has, so only a
   *  candidate is read further, by the rule that decides every empty chat
   *  (`isEmptyChat`). A chat open here is its actor's to decide. A candidate
   *  that fails is recorded and left to the next such stop, and the others
   *  go on. Returns the chats it removed. */
  async function removePausedEmptyChats(open: ReadonlySet<string>): Promise<readonly string[]> {
    const listing = await deps.manager.listMetadata().catch((error: unknown) => {
      log.warn("paused empty chats could not be listed; the next stop that no client holds the project through removes them", { error: errorMessage(error) })
      return undefined
    })
    const candidates = listing?.sessions.filter((row) =>
      row.kind === "chat" && row.lifecycleState === "inactive" && row.label === "New Chat" && !open.has(row.id)) ?? []
    const removed: string[] = []
    for (const { id } of candidates) {
      try {
        if (!await isEmptyChat(await deps.manager.read(id), deps.projectionReader)) continue
        await executeChildSessionDeletion(await deps.manager.admitDeletion(id))
        removed.push(id)
      } catch (error) {
        log.warn("a paused empty chat could not be removed; the next stop that no client holds the project through tries again", { sessionId: id, error: errorMessage(error) })
      }
    }
    return removed
  }
  return { claimComposerReturns: (sessionId, submissionIds) => claimComposerReturns({ reader: deps.projectionReader, writer: eventWriter }, sessionId, submissionIds), reconcileChildSessionCompletions, undoChanges: request => ensureActor(request.sessionId).dispatch({ kind: "session.changes.undo", request }), openSessionRuntime, adoptBlankChat, forkSession, activateSession, releaseSession, hideSession, ensureChatRunner, sessionKind, sendChat, acceptRetainedOperation, closeChat, discardTransientChat, deleteSession, renameSession, reorderSession, dismissNotice, interruptSession, resumeChat, releaseForegroundBash, terminateBackgroundWork, answerQuestion, cancelQuestion, compactChat, reviewChat, requestChatContext, recallQueuedMessage, runtimeState, ownedSessionIds: () => [...actors.keys()], awaitAcceptedWork, warmChatRunner, interruptForReplacement, replacementSuccessorRows: () => successorRowsAfterStop, disposeAll }
}
