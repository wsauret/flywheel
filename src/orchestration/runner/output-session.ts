import { probe, probeToolRenderPhase } from "../../infra/render-probe.js"
import { RuntimeEventProjector } from "../../infra/output/runtime-event-projector.js"
import { OutputProjector } from "../../infra/output/output-projector.js"
import type { AnyBlock, MessageSender, QuestionEntry, SystemMessageOptions, UserMessageBlock, UserMessageImage } from "../../infra/output-blocks.js"
import type { RuntimeEvent } from "../../infra/runtime-event-types.js"
import type { OutputProjectionEvent } from "../../infra/output/output-projection-events.js"
import type { SessionEntryBasePatch } from "../session-store/types.js"
interface QuestionAnswers {
  readonly [question: string]: string
}
interface OutputSessionView {
  readonly blocks: readonly AnyBlock[]
  readonly visibleMessageCountSuffix: number
  readonly streamPhase: SessionEntryBasePatch["streamPhase"]
  readonly streamingOutputChars: number
  readonly streamingToolText: SessionEntryBasePatch["streamingToolText"]
}


export type OutputSessionOptions = {
  updateEntry: (patch: SessionEntryBasePatch) => void
  priorBlocks?: readonly AnyBlock[]
  sessionId?: string
} & (
  /** Either the caller supplies the projector, or this session builds one - and
   *  building one needs the owning session's execution directory (ARCH-DIRECTORIES-007) so
   *  rendered paths resolve the way the live run did. */
  | { projector: OutputProjector; executionCwd?: undefined }
  | { projector?: undefined; executionCwd: string }
)

export interface OutputSession {
  /** `timestamp` is when the event happened, and it defaults to now. The
   *  projection keys each final assistant block by it, so an event applied
   *  later than it happened must give it, or two messages applied in one
   *  millisecond share one block. */
  dispatchRuntimeEvent(event: RuntimeEvent, timestamp?: number): void
  applyProjectionEvent(event: OutputProjectionEvent): void
  beginTurn(): void
  pushUserMessage(message: string, timestamp: number, options?: { entryId?: string; queued?: boolean; injected?: boolean; submissionIds?: readonly string[]; dispatchIds?: readonly string[]; images?: readonly UserMessageImage[]; from?: MessageSender }): void
  /** Seed prior display blocks ahead of live output. Chat seeds at runner
   *  attach (one synchronous frame with the store's authority handoff);
   *  workflow/headless sessions seed at construction via `priorBlocks`. */
  seedBlocks(blocks: readonly AnyBlock[]): void
  hasQueued(): boolean
  /** Marks matching queued rows sent, or all queued rows without a filter. */
  drainQueued(identity?: Pick<UserMessageBlock, "submissionIds" | "dispatchIds">): string[]
  /** Removes the queued row that names one of `dispatchIds`, and returns
   *  the operation that puts it back in its place; null when no queued row
   *  names them. */
  withdrawQueued(dispatchIds: readonly string[]): (() => void) | null
  pushSystemMessage(message: string, timestamp: number, options?: SystemMessageOptions): void
  pushDivider(label: string, timestamp: number): void
  pushQuestion(toolUseId: string, questions: QuestionEntry[], timestamp: number): void
  answerQuestion(toolUseId: string, answers: QuestionAnswers): void
  cancelQuestion(toolUseId: string): void
  getBlocks(): readonly AnyBlock[]
  endTurn(finalStatus?: "completed" | "paused" | "teardown"): void
  /** Live model phase (null when idle/parked) - the same state the Idle
   *  footer renders. Teardown paths read it to tell "a turn was actually in
   *  flight" apart from an idle park, which the run lifecycle cannot: it
   *  holds a turn window open across parks so ESC can cancel them. */
  readonly streamPhase: SessionEntryBasePatch["streamPhase"]
  readonly sessionId: string | null
  flush(): void
  dispose(): void
}

export function createOutputSession(options: OutputSessionOptions): OutputSession {
  const { updateEntry } = options

  const projector = options.projector !== undefined ? options.projector : new OutputProjector({ executionCwd: options.executionCwd })
  if (options.sessionId) projector.sessionId = options.sessionId
  const eventProjector = new RuntimeEventProjector(projector)

  let disposed = false
  let syncPending = false
  let syncTimer: ReturnType<typeof setTimeout> | undefined
  let lastSyncAt = 0
  const resultSyncs = new Set<string>()
  const MIN_SYNC_INTERVAL_MS = 16
  // The streamed character count feeds only the spinner, which animates toward
  // it in 50 ms ticks, so it is published at a glance cadence while the blocks
  // it counts sync at frame rate: each publication is one status patch to every
  // subscriber, and at frame rate that was a second patch per token for every
  // streaming session. A phase change or a reset publishes the count at once,
  // so the figure a phase ends on is exact.
  const CHARS_SYNC_INTERVAL_MS = 250
  let publishedChars = 0
  let publishedPhase: OutputSessionView["streamPhase"] = null
  let charsPublishedAt = 0

  function currentView(): OutputSessionView {
    const snapshot = projector.snapshot()
    return {
      blocks: snapshot.outputBlocks,
      visibleMessageCountSuffix: snapshot.visibleMessageCountSuffix,
      streamPhase: snapshot.streamPhase,
      streamingOutputChars: snapshot.streamingOutputChars,
      streamingToolText: snapshot.streamingToolText,
    }
  }

  function syncStore(): void {
    syncTimer = undefined
    syncPending = false
    if (disposed) return
    probe("sync")
    lastSyncAt = performance.now()
    const view = currentView()
    const charsDue = view.streamingOutputChars !== publishedChars
      && (view.streamPhase !== publishedPhase || view.streamingOutputChars < publishedChars || lastSyncAt - charsPublishedAt >= CHARS_SYNC_INTERVAL_MS)
    if (charsDue) {
      publishedChars = view.streamingOutputChars
      charsPublishedAt = lastSyncAt
    }
    publishedPhase = view.streamPhase
    // The store is the single source of truth: this mirror is the only output
    // write. outputChanges carries the deltas minted at the write site above
    // (projector.drainChanges()); the output-projection forwards them as-is
    // instead of reconstructing an `output.delta` by diffing snapshots.
    updateEntry({
      outputBlocks: view.blocks,
      visibleMessageCountSuffix: view.visibleMessageCountSuffix,
      streamPhase: view.streamPhase,
      ...(charsDue ? { streamingOutputChars: view.streamingOutputChars } : {}),
      streamingToolText: view.streamingToolText,
      outputChanges: projector.drainChanges(),
    })
    for (const toolUseId of resultSyncs) probeToolRenderPhase(toolUseId, "output-sync")
    resultSyncs.clear()
  }

  function scheduleSync(): void {
    if (disposed) return
    const delay = Math.max(0, MIN_SYNC_INTERVAL_MS - (performance.now() - lastSyncAt))
    if (syncPending) {
      flushOverdueSync()
      return
    }
    syncPending = true
    if (delay === 0) {
      probe("sync.immediate")
      syncStore()
      return
    }
    probe("sync.timer")
    syncTimer = setTimeout(syncStore, delay)
  }

  function flushOverdueSync(): void {
    if (!syncPending || syncTimer === undefined) return
    if (performance.now() - lastSyncAt < MIN_SYNC_INTERVAL_MS) return
    probe("sync.overdue")
    clearTimeout(syncTimer)
    syncTimer = undefined
    syncStore()
  }

  function flushNow(): void {
    if (syncTimer !== undefined) { clearTimeout(syncTimer); syncTimer = undefined }
    syncPending = false
    syncStore()
  }

  projector.onChange = scheduleSync

  // Seed only after onChange is wired. seedBlocks notifies, and the builder's
  // change latch stays armed until a sync reads getBlocks() — a notification
  // fired into a null handler latches it with no consumer to re-arm, silencing
  // every later change until the end-of-turn flush.
  if (options.priorBlocks !== undefined) projector.seedBlocks(options.priorBlocks)

  function beginTurn(): void {
    projector.apply({ type: "begin-turn" })
  }
  function pushUserMessage(message: string, timestamp: number, opts?: { entryId?: string; queued?: boolean; injected?: boolean; submissionIds?: readonly string[]; dispatchIds?: readonly string[]; images?: readonly UserMessageImage[]; from?: MessageSender }): void {
    projector.apply({ type: "push-user-message", text: message, timestamp, entryId: opts?.entryId, pending: opts?.queued ?? false, injected: opts?.injected ?? false, ...(opts?.submissionIds?.length ? { submissionIds: opts.submissionIds } : {}), ...(opts?.dispatchIds?.length ? { dispatchIds: opts.dispatchIds } : {}), ...(opts?.images?.length ? { images: opts.images } : {}), ...(opts?.from ? { from: opts.from } : {}) })
    // The user's own message is the one latency-critical block: bypass the
    // 16ms pacing window (built for streaming bursts) so the echo paints on
    // the very next frame. syncPending false means the apply's onChange
    // already synced synchronously (delay 0 path); flushing again would
    // double-write the store.
    if (syncPending) flushNow()
  }

  function dispatchRuntimeEvent(event: RuntimeEvent, timestamp?: number): void {
    if (disposed) return
    if (event.type === "tool.result.available") resultSyncs.add(event.data.tool_use_id)
    if (event.type === "model.turn.completed") {
      const sid = event.data.session_id
      if (typeof sid === "string") projector.sessionId = sid
    }
    eventProjector.dispatch(event, timestamp)
    if (event.type === "tool.result.available" && syncPending) flushNow()
    else flushOverdueSync()
  }

  return {
    dispatchRuntimeEvent,
    applyProjectionEvent: (event: OutputProjectionEvent) => projector.apply(event),
    beginTurn,
    pushUserMessage,
    seedBlocks: (blocks: readonly AnyBlock[]) => projector.seedBlocks(blocks),
    hasQueued: () => projector.hasQueued(),
    drainQueued: (identity) => projector.drainQueued(identity),
    withdrawQueued: (dispatchIds) => projector.withdrawQueued(dispatchIds),
    pushSystemMessage: (message: string, timestamp: number, messageOptions?: SystemMessageOptions) => projector.apply({ type: "push-system-message", message, timestamp, ...messageOptions }),
    pushDivider: (label: string, timestamp: number) => projector.apply({ type: "push-divider", label, timestamp }),
    pushQuestion: (toolUseId: string, questions: QuestionEntry[], timestamp: number) => projector.apply({ type: "push-question", toolUseId, questions, timestamp }),
    answerQuestion: (toolUseId: string, answers: QuestionAnswers) => projector.apply({ type: "answer-question", toolUseId, answers }),
    cancelQuestion: (toolUseId: string) => projector.apply({ type: "cancel-question", toolUseId }),
    getBlocks: () => projector.getBlocks(),
    endTurn(finalStatus: "completed" | "paused" | "teardown" = "completed") {
      const now = Date.now();
      projector.apply({ type: "end-turn", timestamp: now, finalStatus });
    },
    get streamPhase() { return projector.streamPhase },
    get sessionId() { return projector.sessionId ?? null },
    flush: flushNow,
    dispose(): void {
      if (disposed) return
      disposed = true
      if (syncTimer !== undefined) { clearTimeout(syncTimer); syncTimer = undefined }
      resultSyncs.clear()
      projector.onChange = null
      eventProjector.reset()
    },
  }
}
