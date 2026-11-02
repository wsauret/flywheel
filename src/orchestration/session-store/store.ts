import { errorMessage } from "../../infra/error-message.js"
import { EventReaderService, EventStoreWriterService, type EventStoreRuntime } from "../../infra/event-store-effect.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"
import type { AnyBlock } from "../../infra/output-blocks.js"
import { isVisibleMessageBlock } from "../../infra/output-blocks.js"
import { probeLoopUnit } from "../../infra/event-loop-lag.js"
import { EMPTY_OUTPUT_CHANGE_BATCH, NO_CHANGED_TOOLS, mergeOutputChangeBatches, type OutputChangeBatch } from "../../infra/output/output-block-delta.js"
import type { AgentInputAnswers } from "../../protocol/question-protocol-types.js"
import type { ChatRunner } from "../chat/runner-types.js"
import type {
  ConversationSessionEntry,
  SessionRuntimeOptions,
  SessionEntry,
  SessionStore,
} from "./types.js"
import { appendSessionOrder, orderedSessionIds, removeSessionOrder, reorderSessionIds, sameSessionOrder } from "./order.js"
import { entryRuntimeDefaults } from "./entry-defaults.js"
import { createSessionEntryPatcher } from "./entry-patcher.js"
import { currentAccumulatedActiveMs, recordSessionDuration } from "./duration.js"
import { turnInFlight } from "./view.js"
import type { ControlInterruption, RuntimeInterruption } from "../session/conversation/turn-end-record.js"
import type { WorkflowDeliveryAddress } from "../session/conversation/addressed-workflow-messages.js"
import { liveSessionControl } from "../session/live-session-control.js"

/** The identity of a chat's one startup failure notice. */
const STARTUP_FAILURE_BLOCK_ID = "startup-failure"
const isStartupFailure = (block: AnyBlock): boolean => block.kind === "system" && block.id === STARTUP_FAILURE_BLOCK_ID

type ActiveSessionEntry = SessionEntry & { runner: NonNullable<SessionEntry["runner"]> }
function hasRunner(entry: SessionEntry): entry is ActiveSessionEntry {
  return entry.runner !== null
}
const log = Log.create({ service: "session-store" })

export function createSessionStore(runtime: EventStoreRuntime, projectionReader: AsyncEventStateReadSurface): SessionStore {
  const entries = new Map<string, SessionEntry>()
  let order: string[] = []
  const eventWriter = runtime.runSync(EventStoreWriterService)
  const eventReader = runtime.runSync(EventReaderService)
  const member = (id: string) => liveSessionControl(eventReader, id)?.member
  const terminating = new Map<string, Promise<void>>()
  const listeners = new Set<(changed: ReadonlySet<string> | undefined) => void>()
  const revisions = new Map<string, number>()
  // Every protocol projection sweeps this list on every coalesced notify, and
  // membership changes rarely, so the order is folded once per change.
  let orderedIds: readonly string[] | undefined
  const blockSetters = new Map<string, (blocks: readonly AnyBlock[]) => void>()
  const outputChangeQueues = new Map<string, OutputChangeBatch>()

  function activeEntry(sessionId: string): ActiveSessionEntry | null {
    const entry = entries.get(sessionId)
    if (!entry || terminating.has(sessionId) || !hasRunner(entry)) return null
    return entry
  }

  function createBlocksAccessor(sessionId: string, initial: readonly AnyBlock[]) {
    let blocks = initial
    blockSetters.set(sessionId, (next: readonly AnyBlock[]) => { blocks = next })
    return () => blocks
  }

  // Coalesced, not synchronous: every subscriber (the app-service protocol
  // projections) diffs by per-session revision, so one deferred flush per
  // burst is lossless - and streaming mutates the store several times per
  // chunk, so a synchronous broadcast would run every projection per mutation
  // on the worker's dispatch thread. The flag resets before the flush so a
  // listener that mutates the store schedules the next flush, not a re-entry.
  // The flush names the sessions that changed, so a subscriber folds those
  // alone: with dozens of sessions streaming, every burst used to cost each
  // subscriber a pass over every session. A membership or order change names
  // nothing and every subscriber sweeps.
  let notifyScheduled = false
  let changedSinceNotify: Set<string> | undefined = new Set()
  function scheduleNotify(): void {
    if (notifyScheduled) return
    notifyScheduled = true
    queueMicrotask(() => {
      notifyScheduled = false
      const changed = changedSinceNotify
      changedSinceNotify = new Set()
      for (const listener of listeners) listener(changed)
    })
  }

  function notifyListeners(): void {
    changedSinceNotify = undefined
    scheduleNotify()
  }

  function notifyChange(sessionId: string): void {
    revisions.set(sessionId, (revisions.get(sessionId) ?? 0) + 1)
    changedSinceNotify?.add(sessionId)
    scheduleNotify()
  }

  function queueOutputChanges(sessionId: string, changeBatch: OutputChangeBatch): void {
    const sequenceStart = entries.get(sessionId)?.outputSequenceStart ?? 0
    const absoluteBatch = sequenceStart === 0 || changeBatch.fullResync
      ? changeBatch
      : { ...changeBatch, changes: changeBatch.changes.map((change) => ({ ...change, index: change.index + sequenceStart })) }
    const queued = outputChangeQueues.get(sessionId)
    outputChangeQueues.set(sessionId, queued ? mergeOutputChangeBatches(queued, absoluteBatch) : absoluteBatch)
  }

  function drainOutputChanges(sessionId: string): OutputChangeBatch {
    const queued = outputChangeQueues.get(sessionId)
    outputChangeQueues.delete(sessionId)
    return queued ?? EMPTY_OUTPUT_CHANGE_BATCH
  }

  const durationWrites = new Map<string, Promise<void>>()
  /** Publishes the session's duration. It is bookkeeping, so a failed read
   *  or write is recorded and never rejects: neither a live update nor the
   *  disposal of the session's runner may fail on it. */
  function publishDuration(sessionId: string, duration: number): Promise<void> {
    const record = () => recordSessionDuration(projectionReader, eventWriter, sessionId, duration)
    // Serialize the read, append, and prune together. A writer-lane flush cannot
    // join a publication that is still awaiting its initial read.
    const pending = durationWrites.get(sessionId)
    const publication = pending ? pending.then(record, record) : record()
    durationWrites.set(sessionId, publication)
    const release = () => {
      if (durationWrites.get(sessionId) === publication) durationWrites.delete(sessionId)
    }
    void publication.then(release, release)
    return publication.catch((error: unknown) => { recordBackgroundFailure(log, "record session duration", { sessionId }, error) })
  }

  const { updateEntry, updateChatEntry } = createSessionEntryPatcher({
    entries,
    blockSetters,
    queueOutputChanges,
    notifyChange,
    recordDuration: (sessionId, duration) => { void publishDuration(sessionId, duration) },
  })

  function openSessionRuntime(opts: SessionRuntimeOptions): string {
    const base = {
      runner: null,
      conversationId: opts.conversationId,
      description: opts.description ?? "New Chat",
      ...(opts.shortDescription !== undefined ? { shortDescription: opts.shortDescription } : {}),
      ...entryRuntimeDefaults(createBlocksAccessor(opts.sessionId, opts.priorBlocks ?? []), opts.startedAt ?? Date.now(), opts.accumulatedActiveMs ?? 0),
      outputSequenceStart: opts.outputSequenceStart ?? 0,
      visibleMessageCountPrefix: opts.visibleMessageCountPrefix ?? 0,
      tokens: opts.initialTokens ?? 0,
      cost: opts.initialCost ?? 0,
      billedCost: opts.initialBilledCost ?? 0,
      contextPercent: opts.contextPercent ?? 0,
      providerConversationId: opts.providerConversationId,
      seedContext: opts.seedContext,
    }
    const entry: ConversationSessionEntry = opts.kind === "workflow-agent"
      ? { ...base, kind: "workflow-agent", workflowId: opts.workflowId, operations: null }
      : { ...base, kind: opts.kind ?? "chat" }
    entries.set(opts.sessionId, entry)
    order = appendSessionOrder(order, opts.sessionId)
    orderedIds = undefined
    notifyChange(opts.sessionId)
    return opts.sessionId
  }

  function attachChatRunner(sessionId: string, runner: ChatRunner): boolean {
    const shell = entries.get(sessionId)
    if (!shell || terminating.has(sessionId)) return false
    // A runner that starts answers the notice that an earlier start failed.
    if (shell.outputBlocks().some(isStartupFailure)) updateChatEntry(sessionId, { outputBlocks: shell.outputBlocks().filter(block => !isStartupFailure(block)), visibleMessageCountSuffix: shell.visibleMessageCountSuffix })
    const entry = entries.get(sessionId)
    if (!entry) return false
    // Display handoff and authority flip in one synchronous frame: the runner's
    // builder is seeded with exactly the blocks the shell holds right now, so a
    // pre-runner append can never fall between an earlier startup snapshot and
    // the runner's first sync (which replaces the store's array wholesale).
    runner.seedDisplayBlocks(entry.outputBlocks())
    entries.set(sessionId, { ...entry, runner, runnerState: "idle", activityStartedAt: Date.now() })
    notifyChange(sessionId)
    return true
  }

  function replaceChatDisplaySeed(
    sessionId: string,
    blocks: readonly AnyBlock[],
    blockCount: number,
    visibleMessageCountPrefix: number,
    visibleMessageCountSuffix: number,
  ): boolean {
    const entry = entries.get(sessionId)
    if (!entry || terminating.has(sessionId)) return false
    // The durable tail never holds the notice, so a refresh that dropped it
    // would remove the row and the next failed start would add it again.
    const notice = entry.outputBlocks().find(isStartupFailure)
    updateChatEntry(sessionId, {
      outputBlocks: notice === undefined ? blocks : [...blocks, notice],
      visibleMessageCountSuffix,
      outputSequenceStart: Math.max(0, blockCount - blocks.length),
      visibleMessageCountPrefix,
    })
    return true
  }

  function appendPreRunnerOutput(sessionId: string, block: AnyBlock): boolean {
    const entry = entries.get(sessionId)
    if (!entry || terminating.has(sessionId)) return false
    const blocks = entry.outputBlocks()
    updateChatEntry(sessionId, {
      outputBlocks: [...blocks, block],
      visibleMessageCountSuffix: entry.visibleMessageCountSuffix + (isVisibleMessageBlock(block) ? 1 : 0),
      outputChanges: {
        changes: [{ kind: "upsert", index: blocks.length, block }],
        fullResync: false,
        changedTools: NO_CHANGED_TOOLS,
      },
    })
    // Minted at the write site like every other block writer: the app-service
    // output projection only publishes drained changes, so a bare box write
    // would never reach the client until a later recovery resync.
    return true
  }

  function showStartupFailure(sessionId: string, message: string): boolean {
    const entry = entries.get(sessionId)
    if (!entry || terminating.has(sessionId)) return false
    const blocks = entry.outputBlocks()
    const shown = blocks.findIndex(isStartupFailure)
    const current = blocks[shown]
    if (current?.kind === "system" && current.message === message) return true
    const index = shown === -1 ? blocks.length : shown
    const block: AnyBlock = { kind: "system", id: STARTUP_FAILURE_BLOCK_ID, message, level: "error", timestamp: Date.now() }
    updateChatEntry(sessionId, {
      outputBlocks: blocks.toSpliced(index, 1, block),
      visibleMessageCountSuffix: entry.visibleMessageCountSuffix,
      outputChanges: { changes: [{ kind: "upsert", index, block }], fullResync: false, changedTools: NO_CHANGED_TOOLS },
    })
    return true
  }

  function get(sessionId: string): SessionEntry | undefined {
    return entries.get(sessionId)
  }

  function has(sessionId: string): boolean {
    return entries.has(sessionId)
  }

  function isRunning(sessionId: string): boolean {
    return ((entries.get(sessionId)?.runner ?? null) !== null || member(sessionId) !== undefined) && !terminating.has(sessionId)
  }

  async function abort(sessionId: string): Promise<boolean> {
    const entry = activeEntry(sessionId)
    if (!entry) return false
    await entry.runner.abort()
    const completion = terminating.get(sessionId)
    if (completion) await completion
    return true
  }

  function prepareForShutdown(sessionId: string, by: RuntimeInterruption): void {
    const entry = activeEntry(sessionId)
    entry?.runner.prepareForShutdown(by)
  }

  function interrupt(sessionId: string, by: ControlInterruption, _address?: WorkflowDeliveryAddress): boolean {
    const entry = activeEntry(sessionId)
    return entry?.runner.interrupt() ?? member(sessionId)?.interrupt(by) ?? false
  }

  async function interruptForReplacement(sessionId: string): Promise<boolean> {
    return await activeEntry(sessionId)?.runner.interruptForReplacement() ?? false
  }

  async function transferForegroundForReplacement(sessionId: string): Promise<void> {
    await activeEntry(sessionId)?.runner.transferForegroundForReplacement()
    await member(sessionId)?.transferForegroundForReplacement()
  }

  function releaseForegroundBash(sessionId: string, toolUseId: string): boolean {
    return activeEntry(sessionId)?.runner.releaseForegroundBash(toolUseId) ?? member(sessionId)?.releaseForegroundBash(toolUseId) ?? false
  }

  function terminateBackgroundWork(sessionId: string, toolUseId: string): void {
    activeEntry(sessionId)?.runner.terminateBackgroundWork(toolUseId)
    member(sessionId)?.terminateBackgroundWork(toolUseId)
  }

  async function doDispose(sessionId: string, propagateFailure = false): Promise<void> {
    const entry = entries.get(sessionId)
    if (!entry) return
    const runner = entry.runner
    try {
      await publishDuration(sessionId, currentAccumulatedActiveMs(entry))
      if (runner) await runner.dispose()
    } catch (err) {
      if (err instanceof Error) {
        log.warn("session disposal failed", { sessionId, error: errorMessage(err) })
        if (propagateFailure) throw err
      } else {
        const message = errorMessage(err)
        log.warn("session disposal failed", { sessionId, error: message })
        if (propagateFailure) throw new Error(message, { cause: err })
      }
    } finally {
      entries.delete(sessionId)
      order = removeSessionOrder(order, sessionId)
      orderedIds = undefined
      blockSetters.delete(sessionId)
      revisions.delete(sessionId)
      outputChangeQueues.delete(sessionId)
      notifyListeners()
    }
  }

  async function remove(sessionId: string): Promise<void> {
    const pending = terminating.get(sessionId)
    if (pending) {
      await pending
      return
    }
    const entry = entries.get(sessionId)
    if (!entry) return
    const promise = doDispose(sessionId)
    terminating.set(sessionId, promise)
    try { await promise } finally { if (terminating.get(sessionId) === promise) terminating.delete(sessionId) }
  }

  // Only a chat asks the person (PI-AGENT-024), so only a chat runner takes
  // an answer.
  function answerQuestion(sessionId: string, toolUseId: string, answers: AgentInputAnswers): boolean {
    const entry = activeEntry(sessionId)
    if (entry?.kind !== "chat") return false
    entry.runner.answerQuestion(toolUseId, answers)
    return true
  }

  function cancelQuestion(sessionId: string, toolUseId: string): boolean {
    const entry = activeEntry(sessionId)
    if (entry?.kind !== "chat") return false
    entry.runner.cancelQuestion(toolUseId)
    return true
  }

  async function compactConversation(sessionId: string): Promise<boolean> {
    return activeEntry(sessionId)?.runner.compact() ?? member(sessionId)?.compact() ?? false
  }

  function learnFromSession(sessionId: string): boolean {
    return activeEntry(sessionId)?.runner.learn?.() ?? false
  }


  function runningCount(): number {
    return [...entries].filter(([id, entry]) => entry.runner && !terminating.has(id)).length
  }

  function allIds(): string[] {
    orderedIds ??= orderedSessionIds(order, [...entries.keys()])
    return [...orderedIds]
  }

  function reorder(sessionId: string, beforeSessionId: string | null): boolean {
    if (!entries.has(sessionId) || (beforeSessionId !== null && !entries.has(beforeSessionId))) return false
    const current = allIds()
    const next = reorderSessionIds(current, sessionId, beforeSessionId)
    if (!next) return false
    if (sameSessionOrder(current, next)) return true
    order = next
    orderedIds = undefined
    notifyListeners()
    return true
  }

  async function refreshDeps(sessionIds?: readonly string[]): Promise<void> {
    const ids = (sessionIds ?? [...entries.keys()]).filter((id) => !terminating.has(id))
    const results = await Promise.allSettled(ids.map(async (id) => {
      const entry = entries.get(id)
      if (entry?.runner?.refreshDeps) await entry.runner.refreshDeps()
    }))
    const failures = results.flatMap((result, index) => result.status === "rejected" ? [{ sessionId: ids[index], reason: result.reason }] : [])
    if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), `Failed to refresh runtime dependencies for sessions: ${failures.map((failure) => failure.sessionId).join(", ")}`)
  }

  async function disposeAll(): Promise<void> {
    const ids = [...entries.keys()]
    const activeIds = ids.filter((id) => !terminating.has(id))
    const failures: unknown[] = []

    for (const id of activeIds) {
      const entry = entries.get(id)
      if (!entry?.runner) continue
      try {
        if (turnInFlight(entry)) await entry.runner.abort()
      } catch (error) {
        failures.push(error)
      }
    }

    const finishing = await Promise.allSettled(new Set(terminating.values()))
    failures.push(...finishing.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(({ reason }) => reason))
    const disposed = await Promise.allSettled([...entries.keys()].map((id) => doDispose(id, true)))
    failures.push(...disposed.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(({ reason }) => reason))
    entries.clear()
    order = []
    orderedIds = undefined
    blockSetters.clear()
    revisions.clear()
    outputChangeQueues.clear()
    notifyListeners()

    for (const failure of failures) log.error("session disposal failed", { error: errorMessage(failure) })
    if (failures.length > 0) throw new AggregateError(failures, "Session disposeAll failed")
  }

  function revision(sessionId: string): number {
    return revisions.get(sessionId) ?? 0
  }

  function onChange(listener: (changed: ReadonlySet<string> | undefined) => void, label = "unlabeled"): () => void {
    // The probe is the enforcement point for the session-fairness rule: a
    // subscriber may fold only what changed, so a fold that blows the loop
    // budget WARNs with this label instead of surfacing as an anonymous stall.
    const probed = (changed: ReadonlySet<string> | undefined): void => probeLoopUnit("store-subscriber", label, () => listener(changed))
    listeners.add(probed)
    return () => { listeners.delete(probed) }
  }

  return { openSessionRuntime, replaceChatDisplaySeed, attachChatRunner, appendPreRunnerOutput, showStartupFailure, get, has, isRunning, allIds, abort, prepareForShutdown, interruptForReplacement, transferForegroundForReplacement, interrupt, releaseForegroundBash, terminateBackgroundWork, remove, answerQuestion, cancelQuestion, compactConversation, learnFromSession, reorder, updateEntry, updateChatEntry, runningCount, revision, drainOutputChanges, disposeAll, onChange, refreshDeps }
}
