import { batch, untrack } from "solid-js"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import type { BackoffOptions } from "../../infra/backoff.js"
import { probe, probeGauge, probeToolRenderPhase } from "../../infra/render-probe.js"
import { Log } from "../../infra/log.js"
import { blockIdentity } from "../../protocol/block-identity.js"
import type { AttachedRuntimeClient, FrontendOutputBlock } from "../../protocol/app-service-types.js"
import type { OutputView } from "../../protocol/output-protocol-types.js"
import { createTranscriptStore, type BlockReplacement, type TranscriptChange, type TranscriptStore, type TranscriptView } from "../../protocol/client/transcript-store.js"
import type { HydratedOutputBlockBody } from "../../protocol/transcript-protocol-types.js"
import { estimateAppendedBlockRows, estimateFrontendOutputBlockRows, heightEstimatesFromBlocks } from "../hooks/output-height-estimates.js"
import { RESIDENT_BLOCK_BUDGET } from "../output-window/output-window-scroll.js"
import type { LoadDirection, LoadPageResult, OutputTranscriptCache, TranscriptFreshness, TranscriptSnapshot, TranscriptStatus } from "./output-transcript-cache-types.js"
import { transcriptIdentitySample } from "../../protocol/client/transcript-delta.js"
import { adoptedBlocks, type ChatSubmissionWindow } from "../../protocol/client/chat-submissions.js"
import { createResidency, type ResidentLanes } from "../../protocol/client/residency.js"

type StreamingText = OutputView["streamingToolText"]
type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type MutableSnapshot = Omit<Mutable<TranscriptSnapshot>, "blocks" | "window" | "status"> & { blocks: FrontendOutputBlock[]; window: Mutable<TranscriptSnapshot["window"]>; status: TranscriptStatus }
interface TranscriptSnapshots { [sessionId: string]: TranscriptSnapshot }
interface StreamingTextBySession { [sessionId: string]: StreamingText }
interface FreshnessBySession { [sessionId: string]: TranscriptFreshness }
interface DisclosureByKey { [key: string]: boolean }
interface CountBySession { [sessionId: string]: number }
const log = Log.create({ service: "output-transcript-cache" })

/** Cache budget: at least this many sessions and every session the catalog
 *  lists as active. Inactive sessions become eligible after the TTL. Active
 *  sessions and every mounted transcript surface are exempt from the TTL. */
const MAX_SESSIONS = 30
const IDLE_TTL_MS = 20 * 60 * 1000
/** Bytes one range read may carry, whatever its block count. */
const PAGE_MAX_BYTES = 384 * 1024
/** Output frame batching (matches the OpenTUI render cadence): a frame's
 *  worth of store changes lands in one Solid batch, one downstream
 *  notification wave, instead of one propagation per delta per session. */
const FRAME_MS = 16

/** A resident session: the shared store that holds its window and the
 *  presentation stamps this client derives from what the store reports. */
interface Resident {
  reader?: import("../../protocol/client/transcript-store.js").TranscriptReader
  readonly store: TranscriptStore
  unsubscribe: () => void
  /** Identity of the resident block-index space; see TranscriptSnapshot.generation. */
  generation: number
  /** Pending non-structural slot rewrites since the last frame flush. */
  replaced: BlockReplacement[]
  /** A delta landed since the last flush, whatever its shape. */
  hadDeltas: boolean
  /** The store asked for a recovery read that has not landed yet. */
  recovering: boolean
  /** The next flush re-reads the whole window (a read landed or indices moved). */
  repave: boolean
  streamingChanged: boolean
  statusChanged: boolean
  /** Blocks a read or delta delivered since the last flush, for delivery confirmation. */
  adopted: FrontendOutputBlock[]
  /** Per-block row estimate point updates (absolute blockIndex -> rows), drained
   *  by the height-index seeding effect. */
  estimateUpdates: Map<number, number>
  recentUpdates: { kind: TranscriptChange["kind"]; reason?: string; structural?: boolean; replacements?: readonly number[]; replacementCount?: number; start: number | null; count: number; total: number; publishedBefore: number | null; publishedAfter: number | null; publishedOriginBefore: number | null; publishedOriginAfter: number | null; publication: "pending" | "deferred" | "repave" | "slots" | "metadata" }[]
  lastFlushReason?: "immediate" | "timer" | "overdue"
}

function recoveryFailed(store: TranscriptStore): boolean {
  return store.status === "recovery-failed"
}

// Monotone identity for repaved block spaces; see TranscriptSnapshot.generation.
// Process-wide so a session whose cache entry was evicted and rebuilt can never
// collide with the generation a surviving layout slot remembers. 0 is reserved
// for the loading sentinel.
let generationCounter = 0
// A fresh entry per write: the Solid store proxies stored objects, so a shared
// constant would alias every loading session and a slot write into one
// session's block list would land in all of them.
function blankEntry(): TranscriptSnapshot {
  return { status: { kind: "loading" }, source: { kind: "loading" }, generation: 0, totalBlocks: 0, window: { startBlockIndex: null, endBlockIndex: null, hasBefore: false, hasAfter: false, estimatedRows: 0, contentBytes: 0 }, heightEstimates: [], blocks: [], seedEpoch: 0, historicalThroughIndex: -1 }
}
/** The shared read for a loading entry: stable loading source, no blocks. Read only. */
const loadingSnapshot: TranscriptSnapshot = blankEntry()

/** The terminal's transcript residency: one shared `TranscriptStore` per
 *  resident session, and the Solid projections the output window renders. The
 *  store owns the window, its paging, hydration, and recovery, and says what
 *  changed; the shared residency owns which sessions stay resident under the
 *  terminal's limits; this owns the reactive snapshot (row estimates,
 *  coordinate generation, seed epoch, freshness), disclosure intent, and the
 *  16 ms frame that coalesces a streaming burst into one notification wave.
 *  The terminal reads every resident on each lane, so its residency has no
 *  dormancy. */
export function createOutputTranscriptCache(deps: {
  appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane" | "watchOutput">
  includeThinkingContent?: () => boolean
  now?: () => number
  maxSessions?: number
  /** The sessions the catalog lists as active. They all stay resident for any
   *  idle time. Only capacity removes one, and every inactive session is
   *  evicted before any of them. */
  activeSessions?: () => ReadonlySet<string>
  recoveryBackoff?: BackoffOptions
  /** Confirms adopted runtime blocks against the resident window. Hidden
   *  sessions confirm delivery before their deferred presentation. */
  onBlocksAdopted?: (sessionId: string, blocks: readonly FrontendOutputBlock[], window: ChatSubmissionWindow) => void
  onTranscriptChange?: (sessionId: string, change: TranscriptChange) => void
}): OutputTranscriptCache {
  const now = deps.now ?? (() => Date.now())
  const includeThinkingContent = deps.includeThinkingContent ?? (() => true)
  const maxSessions = deps.maxSessions ?? MAX_SESSIONS
  const activeSessions = deps.activeSessions ?? (() => new Set<string>())
  const [cache, setCache] = createStore<TranscriptSnapshots>({})
  // Live streaming tool-input text, beside the block list. It is the only live
  // datum that is not a block, so it rides its own reactive store rather than
  // bloating the snapshot; view() composes the two for the renderer.
  const [streamingCache, setStreamingCache] = createStore<StreamingTextBySession>({})
  const [freshness, setFreshness] = createStore<FreshnessBySession>({})
  const [disclosed, setDisclosed] = createStore<DisclosureByKey>({})
  const [visibleCounts, setVisibleCounts] = createStore<CountBySession>({})
  const [streamedChars, setStreamedChars] = createStore<CountBySession>({})

  // Mounted surfaces own independent retention handles, so foreground and
  // nested viewers remain resident together. Active sessions are open tabs
  // the user can return to at any time, so the idle limit never applies to
  // them: only capacity removes one, after every inactive one.
  const residents = createResidency<Resident>({ capacity: maxSessions, idleMs: IDLE_TTL_MS, pinned: activeSessions, now, lanes: deps.appService, dormancy: false, onEvict: (resident, id) => release(id, resident) })
  // Residents with live deltas applied to their store but not yet presented:
  // nothing reads a session's presentation until a surface retains it, so a
  // hidden streaming session costs its store appends and nothing per frame.
  // It repaves from its window when it comes to the foreground.
  const deferred = new Set<string>()
  let seedEpoch = 0
  let frameTimer: ReturnType<typeof setTimeout> | undefined
  let lastFlushAt = 0
  const dirty = new Set<string>()

  function markFresh(id: string, source: TranscriptFreshness["source"]): void {
    const prior = freshness[id]
    setFreshness(id, { revision: (prior?.revision ?? 0) + 1, updatedAt: now(), source })
  }

  const childStateKey = (sessionId: string, blockId: string): string => `${sessionId}\n${blockId}`

  /** The snapshot a store view projects to: bodies and fetched children folded
   *  into their blocks, the status the renderer distinguishes, and the row
   *  estimates this client measures. */
  function snapshotFrom(id: string, resident: Resident, view: TranscriptView, store: TranscriptStore): TranscriptSnapshot {
    const blocks = view.blocks.map((block) => presentBlock(block, view))
    const start = view.startBlockIndex
    const end = start === null ? null : start + blocks.length - 1
    // The store owns whether output lies past the window. A detached window's
    // total stops at the last read, so deriving it from the total would show
    // the end of a window as the end of the transcript.
    const hasAfter = view.hasNewer
    const heightEstimates = heightEstimatesFromBlocks(blocks, start ?? 0, false)
    const window = { startBlockIndex: start, endBlockIndex: end, hasBefore: view.hasBefore, hasAfter, contentBytes: 0, estimatedRows: heightEstimates.reduce((sum, estimate) => sum + estimate.rows, 0) }
    return {
      status: statusFrom(id, store, window.hasBefore || hasAfter),
      source: view.consistencyToken === null ? { kind: "live" } : { kind: "historical", consistencyToken: view.consistencyToken },
      generation: resident.generation,
      totalBlocks: view.totalBlocks,
      window,
      heightEstimates,
      blocks,
      seedEpoch: ++seedEpoch,
      historicalThroughIndex: view.historicalThroughIndex,
    }
  }

  function statusFrom(id: string, store: TranscriptStore, partial: boolean): TranscriptStatus {
    const detail = store.unavailable
    if (store.status === "unavailable" && detail) {
      const timestamp = now()
      return {
        kind: "unavailable",
        diagnostic: detail.diagnostic,
        notice: { id: `output-unavailable:${id}`, scope: "output", presentation: "transcript.unavailable", severity: "error", title: detail.title, message: detail.message, startedAt: timestamp, updatedAt: timestamp },
      }
    }
    if (store.status === "recovery-failed") return { kind: "recovery-failed", message: detail?.message ?? "Could not read this session's transcript.", updatedAt: now() }
    if (store.status === "idle" || store.status === "loading") return { kind: "loading" }
    return { kind: partial ? "partial" : "complete" }
  }

  /** A block as this client shows it: a fetched body replaces the wire's
   *  preview and its omission markers; fetched children replace the bounded
   *  tail a group arrived with, the live tail kept on top. */
  function presentBlock(block: FrontendOutputBlock, view: TranscriptView): FrontendOutputBlock {
    if (block.kind === "agentGroup") {
      const hydrated = view.groups[block.id]
      if (hydrated === undefined) return block
      return { ...block, children: [...hydrated.children], totalToolCount: hydrated.total }
    }
    if (block.kind === "userMessage") {
      const body = view.bodies[block.id]
      const presented = body === undefined ? block : { ...block, images: body.images }
      return presented
    }
    if (block.kind !== "tool" && block.kind !== "system") return block
    const body = view.bodies[block.id]
    return body === undefined ? block : withBody(block, body)
  }

  function withBody(block: Extract<FrontendOutputBlock, { kind: "tool" | "system" }>, body: HydratedOutputBlockBody): FrontendOutputBlock {
    if (block.kind === "system") {
      const { diffOmission: _noticeOmission, ...shell } = block
      return { ...shell, ...(body.mutationEvidence !== undefined ? { mutationEvidence: body.mutationEvidence } : {}) }
    }
    const { invocationBodyOmittedBytes: _invocationOmitted, diffOmission: _diffOmission, contentOmittedLines: _contentOmitted, proposedDiff: _proposal, ...shell } = block
    return {
      ...shell,
      ...(body.invocationBody !== undefined ? { invocationBody: body.invocationBody } : {}),
      ...(body.diff !== undefined ? { diff: body.diff } : {}),
      ...(body.content !== undefined ? { content: body.content } : {}),
      ...(body.filetype !== undefined ? { filetype: body.filetype } : {}),
      ...(body.mutationEvidence !== undefined ? { mutationEvidence: body.mutationEvidence } : {}),
      ...(body.mutationEvidence === undefined && body.proposedDiff !== undefined ? { proposedDiff: body.proposedDiff } : {}),
    }
  }

  /** Store changes are noted per session and applied per frame. A read or a
   *  structural delta means the whole window is re-read; slot rewrites from a
   *  streaming burst update their slots and move the row estimates in place. */
  function onStoreChange(id: string, change: TranscriptChange): void {
    deps.onTranscriptChange?.(id, change)
    const resident = residents.get(id)
    if (!resident) return
    const view = resident.store.view
    const publishedBefore = untrack(() => ({ count: cache[id]?.blocks.length ?? null, origin: cache[id]?.window.startBlockIndex ?? null }))
    const update: Resident["recentUpdates"][number] = {
      kind: change.kind,
      ...(change.kind === "window" ? { reason: change.reason } : {}),
      ...(change.kind === "deltas" ? { structural: change.structural, replacementCount: change.replaced.length, replacements: change.replaced.slice(0, 8).map((item) => item.localIndex) } : {}),
      start: view.startBlockIndex,
      count: view.blocks.length,
      total: view.totalBlocks,
      publishedBefore: publishedBefore.count,
      publishedOriginBefore: publishedBefore.origin,
      publishedAfter: publishedBefore.count,
      publishedOriginAfter: publishedBefore.origin,
      publication: "pending",
    }
    resident.recentUpdates.push(update)
    if (resident.recentUpdates.length > 32) resident.recentUpdates.shift()
    probe("output-intake")
    if (change.kind === "deltas" && !residents.retained(id)) {
      const adopted = adoptedBlocks(change)
      if (adopted.length > 0) deps.onBlocksAdopted?.(id, adopted, view)
      update.publication = "deferred"
      resident.hadDeltas = true
      resident.repave = true
      if (change.streamingChanged) resident.streamingChanged = true
      // The streamed count drives a status line that stays on screen while
      // the transcript is hidden, such as a background tab's spinner seed, so
      // it lands now; only the block presentation waits for a retain.
      publishStreamedChars(id, resident.store)
      deferred.add(id)
      return
    }
    let immediate = false
    const adopted = adoptedBlocks(change)
    resident.adopted.push(...adopted)
    for (const block of adopted) if (block.kind === "tool" && block.status !== "pending" && block.status !== "streaming") probeToolRenderPhase(block.id, "intake")
    switch (change.kind) {
      case "deltas":
        resident.hadDeltas = true
        if (change.structural) resident.repave = true
        else resident.replaced.push(...change.replaced)
        if (change.streamingChanged) resident.streamingChanged = true
        for (const { next } of change.replaced) if (next.kind === "userMessage") immediate = true
        if (change.structural) immediate = true
        break
      case "window":
        // Protected recovery uses "merge" even after a rebase. Surviving ids,
        // not that operation name, establish whether measured coordinates moved.
        if (change.reason === "install" || change.reason === "around" || untrack(() => {
          const prior = cache[id]
          const beforeStart = prior?.window.startBlockIndex
          const afterStart = view.startBlockIndex
          if (!prior || beforeStart === undefined || beforeStart === null || afterStart === null) return false
          const coordinates = new Map(view.blocks.map((block, index) => [blockIdentity(block), index + afterStart]))
          return prior.blocks.some((block, index) => {
            const next = coordinates.get(blockIdentity(block))
            return next !== undefined && next !== index + beforeStart
          })
        })) resident.generation = ++generationCounter
        if (resident.recovering) { resident.recovering = false; probe("output.recovery") }
        resident.repave = true
        resident.streamingChanged = true
        immediate = true
        break
      // Reads and status moves are human-frequency and land at once; only a
      // streaming burst is paced by the frame.
      case "status":
        resident.statusChanged = true
        immediate = true
        break
      case "body":
      case "group":
        resident.repave = true
        immediate = true
        break
    }
    dirty.add(id)
    if (immediate) flush("immediate", change.kind === "deltas")
    else scheduleFlush()
  }

  function scheduleFlush(): void {
    const elapsed = now() - lastFlushAt
    if (frameTimer !== undefined) { if (elapsed >= FRAME_MS) flush("overdue"); return }
    if (elapsed >= FRAME_MS) { flush("immediate"); return }
    frameTimer = setTimeout(() => flush("timer"), FRAME_MS - elapsed)
  }

  /** `frame` says the flush paces a streaming burst; a read landing or a
   *  status change is applied at once without starting the next frame's
   *  clock, so the first delta after it still applies immediately. A frame's
   *  clock starts when its flush ends: the reactive work a flush triggers
   *  runs inside it, and a clock that started before a slow flush let every
   *  delta that queued behind it flush alone, so a backlog never merged into
   *  one frame. */
  function flush(reason: "immediate" | "timer" | "overdue", frame = true): void {
    if (frameTimer !== undefined) { clearTimeout(frameTimer); frameTimer = undefined }
    if (dirty.size === 0) return
    probe(`output.flush.${reason}`)
    const ids = [...dirty]
    dirty.clear()
    batch(() => {
      for (const id of ids) {
        const resident = residents.get(id)
        if (resident) {
          resident.lastFlushReason = reason
          project(id, resident)
        }
      }
    })
    if (frame) lastFlushAt = now()
    probeGauge("output-queue-depth", dirty.size)
  }

  /** The count stays unknown until the store first adopts an authoritative
   *  window, which makes it `ready`. A loading or failure notice before that
   *  would publish the empty view's 0, and the spinner would spend its
   *  unknown-to-known seed on it and then ramp up from 0 to the real count.
   *  Once known, the count follows the view through later recoveries. */
  function publishStreamedChars(id: string, store: Resident["store"]): void {
    const known = streamedChars[id]
    if (known === undefined && store.status !== "ready") return
    if (known !== store.view.streamingOutputChars) setStreamedChars(id, store.view.streamingOutputChars)
  }

  function project(id: string, resident: Resident): void {
    const { store } = resident
    const view = store.view
    const publication = resident.repave ? "repave" : resident.replaced.length > 0 ? "slots" : "metadata"
    const beforeEmpty = untrack(() => {
      const snapshot = cache[id]
      return residents.retained(id) && snapshot !== undefined && snapshot.blocks.length > 0 && view.blocks.length === 0 ? snapshotEvidence(snapshot) : undefined
    })
    const adopted = resident.adopted
    if (visibleCounts[id] !== view.visibleMessageCount) setVisibleCounts(id, view.visibleMessageCount)
    publishStreamedChars(id, store)
    resident.adopted = []
    if (resident.hadDeltas) { resident.hadDeltas = false; probe("output-applied") }
    if (resident.repave) {
      resident.repave = false
      resident.replaced = []
      resident.estimateUpdates.clear()
      setCache(id, reconcile(snapshotFrom(id, resident, view, store)))
      resident.streamingChanged = false
      setStreamingCache(id, reconcile(view.streamingToolText))
      resident.statusChanged = false
      markFresh(id, view.consistencyToken === null && store.status === "ready" ? "live" : "range")
      hydrateInvocationBodies(id, view)
    } else if (resident.replaced.length > 0) {
      const replaced = resident.replaced
      resident.replaced = []
      const snap = cache[id]
      if (snap === undefined) return
      const start = view.startBlockIndex ?? 0
      let estimatedRowsDelta = 0
      setCache(id, produce((snapshot) => {
        // SAFETY: Solid's produce draft is mutable even though the snapshot is
        // readonly at the store boundary; this single cast exposes the writable
        // block list and window fields for one coherent slot-wise update.
        // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: Solid produce exposes a mutable draft through a readonly store type
        const draft = snapshot as MutableSnapshot
        const blocks = draft.blocks
        for (const { localIndex, prior, next, appendedText } of replaced) {
          const shown = presentBlock(next, view)
          const priorRows = prior ? estimateFrontendOutputBlockRows(prior, false) : 0
          const nextRows = prior && appendedText.length > 0 ? estimateAppendedBlockRows(prior, next, appendedText, false) : estimateFrontendOutputBlockRows(shown, false)
          estimatedRowsDelta += nextRows - priorRows
          resident.estimateUpdates.set(start + localIndex, nextRows)
          blocks[localIndex] = shown
        }
        // A window that accepts deltas reaches the tail, so the resident end
        // is the transcript's end after the slots it appended.
        draft.totalBlocks = Math.max(draft.totalBlocks, view.totalBlocks)
        const end = blocks.length === 0 ? null : start + blocks.length - 1
        draft.window.startBlockIndex = blocks.length === 0 ? null : start
        draft.window.endBlockIndex = end
        draft.window.hasAfter = view.hasNewer
        draft.window.estimatedRows = Math.max(0, draft.window.estimatedRows + estimatedRowsDelta)
        const statusKind = draft.window.hasBefore || draft.window.hasAfter ? "partial" : "complete"
        if (draft.status.kind !== statusKind && (draft.status.kind === "partial" || draft.status.kind === "complete")) draft.status = { kind: statusKind }
      }))
      if (resident.streamingChanged) {
        resident.streamingChanged = false
        setStreamingCache(id, reconcile(view.streamingToolText))
      }
      if (resident.statusChanged) { resident.statusChanged = false; syncStatus(id, resident) }
      markFresh(id, "live")
    } else {
      if (resident.streamingChanged) {
        resident.streamingChanged = false
        setStreamingCache(id, reconcile(view.streamingToolText))
      }
      if (resident.statusChanged) { resident.statusChanged = false; syncStatus(id, resident) }
    }
    for (const block of adopted) if (block.kind === "tool" && block.status !== "pending" && block.status !== "streaming") probeToolRenderPhase(block.id, "application")
    const published = untrack(() => ({ count: cache[id]?.blocks.length ?? null, origin: cache[id]?.window.startBlockIndex ?? null }))
    for (const update of resident.recentUpdates) {
      if (update.publication !== "pending") continue
      update.publication = publication
      update.publishedAfter = published.count
      update.publishedOriginAfter = published.origin
    }
    if (beforeEmpty && published.count === 0) {
      untrack(() => log.info("retained transcript became empty", {
        sessionId: id, publication, lastFlushReason: resident.lastFlushReason,
        before: beforeEmpty, after: cache[id] && snapshotEvidence(cache[id]),
        source: sourceEvidence(view, store),
        recentUpdates: resident.recentUpdates.map((update) => ({ ...update })),
      }))
    }
    if (adopted.length > 0) deps.onBlocksAdopted?.(id, adopted, view)
  }

  function snapshotEvidence(snapshot: TranscriptSnapshot) {
    return {
      start: snapshot.window.startBlockIndex, end: snapshot.window.endBlockIndex,
      count: snapshot.blocks.length, total: snapshot.totalBlocks,
      generation: snapshot.generation, seedEpoch: snapshot.seedEpoch,
      status: snapshot.status.kind, source: snapshot.source.kind,
      hasBefore: snapshot.window.hasBefore, hasAfter: snapshot.window.hasAfter,
      samples: transcriptIdentitySample(snapshot.blocks, snapshot.window.startBlockIndex),
    }
  }

  function sourceEvidence(view: TranscriptView, store: TranscriptStore) {
    return {
      start: view.startBlockIndex, end: view.startBlockIndex === null ? null : view.startBlockIndex + view.blocks.length - 1,
      count: view.blocks.length, total: view.totalBlocks, status: store.status,
      appliedOutputPosition: view.appliedOutputPosition, visibleMessageCount: view.visibleMessageCount,
      atTail: view.atTail, hasBefore: view.hasBefore, hasNewer: view.hasNewer,
      consistencyToken: view.consistencyToken,
      samples: transcriptIdentitySample(view.blocks, view.startBlockIndex),
    }
  }

  function syncStatus(id: string, resident: Resident): void {
    const snap = cache[id]
    if (!snap) return
    markFresh(id, "status")
    const status = statusFrom(id, resident.store, snap.window.hasBefore || snap.window.hasAfter)
    if (status.kind === snap.status.kind && status.kind !== "recovery-failed" && status.kind !== "unavailable") return
    setCache(id, reconcile({ ...snap, status }))
  }

  /** The terminal shows command bodies inline, so a wire-truncated invocation
   *  body is fetched as soon as its block is resident. */
  function hydrateInvocationBodies(id: string, view: TranscriptView): void {
    if (view.consistencyToken === null) return
    for (const block of view.blocks) {
      if (block.kind === "tool" && block.invocationBodyOmittedBytes !== undefined && view.bodies[block.id] === undefined) void residents.get(id)?.store.hydrateBody(block.id)
    }
  }

  function release(id: string, resident: Resident): void {
    resident.unsubscribe()
    resident.store.dispose()
    dirty.delete(id)
    deferred.delete(id)
    setCache(produce((state) => { Reflect.deleteProperty(state, id) }))
    setStreamingCache(produce((state) => { Reflect.deleteProperty(state, id) }))
    setFreshness(produce((state) => { Reflect.deleteProperty(state, id) }))
    setVisibleCounts(produce((state) => { Reflect.deleteProperty(state, id) }))
    setStreamedChars(produce((state) => { Reflect.deleteProperty(state, id) }))
    // Disclosure is user intent, so it survives reseeds and generation bumps;
    // it leaves the cache only when its session does.
    setDisclosed(produce((state) => {
      for (const key of Object.keys(state)) if (key.startsWith(`${id}\n`)) Reflect.deleteProperty(state, key)
    }))
  }

  function ensureResident(id: string, knownEmpty = false): Resident {
    // Publish the snapshot only after its resident reader is installed.
    return batch(() => residents.use(id, (lanes) => createResident(id, knownEmpty, lanes)))
  }

  function createResident(id: string, knownEmpty: boolean, lanes: ResidentLanes): Resident {
    setCache(id, reconcile(blankEntry()))
    const store = createTranscriptStore({
      connection: { query: deps.appService.query, watchOutput: deps.appService.watchOutput, subscribe: lanes.subscribe, onLane: lanes.onLane },
      sessionId: id,
      reader: () => residents.get(id)?.reader,
      knownEmpty,
      pageBlocks: RESIDENT_BLOCK_BUDGET,
      pageBytes: PAGE_MAX_BYTES,
      maxResidentBlocks: RESIDENT_BLOCK_BUDGET,
      includeThinkingContent,
      ...(deps.recoveryBackoff ? { recoveryBackoff: deps.recoveryBackoff } : {}),
      onDiagnostic: (message, detail) => {
        const current = residents.get(id)
        if (message === "transcript delta diverged from the resident window") {
          untrack(() => log.info(message, {
            sessionId: id, detail,
            snapshot: cache[id] && snapshotEvidence(cache[id]),
            source: current && sourceEvidence(current.store.view, current.store),
            lastFlushReason: current?.lastFlushReason, pendingRepave: current?.repave,
            recentUpdates: current?.recentUpdates.map((update) => ({ ...update })),
          }))
        } else log.info(message, { sessionId: id, detail })
        if (message !== "transcript recovering") return
        if (current) current.recovering = true
        probe("output.recovery.request")
        if (typeof detail === "object" && detail !== null && "reason" in detail && detail.reason === "gap_unclosed") probe("output.gap")
      },
    })
    const created: Resident = { store, unsubscribe: () => {}, generation: ++generationCounter, replaced: [], hadDeltas: false, recovering: false, repave: knownEmpty, streamingChanged: false, statusChanged: false, adopted: [], estimateUpdates: new Map(), recentUpdates: [] }
    created.unsubscribe = store.onChange((change) => onStoreChange(id, change))
    // A store born ready emits nothing, so its first window publishes here.
    if (knownEmpty) project(id, created)
    return created
  }

  function loadPage(id: string, direction: LoadDirection): Promise<LoadPageResult> {
    const existing = residents.get(id)
    if (!existing) return Promise.resolve("skipped")
    const page = direction === "older" ? existing.store.loadOlder() : existing.store.loadNewer()
    return page.then((loaded) => (loaded ? "loaded" : "skipped"))
  }

  const snapshotOf = (id: string): TranscriptSnapshot | undefined => {
    const entry = cache[id]
    if (!entry) return undefined
    return entry.status.kind === "loading" ? loadingSnapshot : entry
  }

  function reportProjectionFailure(id: string, error: unknown): never {
    untrack(() => {
      const resident = residents.get(id)
      const source = resident?.store.view
      const snapshot = cache[id]
      // Reads the raw array: a store proxy answers a tracked index from its signal,
      // which can hide the slot the stored array actually holds.
      const missing = (stored: readonly FrontendOutputBlock[]) => {
        const blocks = unwrap(stored)
        const holes: number[] = []
        const undefinedSlots: number[] = []
        for (let index = 0; index < blocks.length; index++) {
          if (!(index in blocks)) {
            if (holes.length < 8) holes.push(index)
          } else if (blocks[index] === undefined && undefinedSlots.length < 8) undefinedSlots.push(index)
        }
        return { holes, undefinedSlots }
      }
      log.error("transcript projection failed", {
        sessionId: id, error,
        generation: resident?.generation, seedEpoch: snapshot?.seedEpoch,
        storeStatus: resident?.store.status, snapshotStatus: snapshot?.status.kind,
        lastFlushReason: resident?.lastFlushReason, pendingRepave: resident?.repave,
        source: source && { start: source.startBlockIndex, count: source.blocks.length, total: source.totalBlocks, ...missing(source.blocks) },
        snapshot: snapshot && { start: snapshot.window.startBlockIndex, end: snapshot.window.endBlockIndex, count: snapshot.blocks.length, total: snapshot.totalBlocks, ...missing(snapshot.blocks) },
        recentUpdates: resident?.recentUpdates,
      })
    })
    throw error
  }

  return {
    protectReader: (id, reader) => { const resident = residents.get(id); if (resident) resident.reader = reader },
    isCurrent: (id) => {
      void freshness[id]?.revision
      return residents.get(id)?.store.windowCurrent ?? false
    },
    mutationEvidence: (id) => {
      const snapshot = cache[id]
      return snapshot === undefined ? undefined : residents.get(id)?.store.mutationEvidence
    },
    reportProjectionFailure,
    startKnownEmpty: (id) => { ensureResident(id, true) },
    open: async (id) => {
      const { store } = ensureResident(id)
      await store.open()
      // A first read that exhausted its retries is the caller's to report as
      // well as the pane's: the shell toasts the cause.
      if (recoveryFailed(store)) throw new Error(store.unavailable?.diagnostic ?? "Could not read this session's transcript.")
    },
    refresh: (id) => ensureResident(id).store.refresh(),
    residentSessionIds: () => residents.ids(),
    recoverOutputCursor: (id) => { void residents.get(id)?.store.refresh() },
    loadPage,
    loadAround: (id, entryId) => residents.get(id) ? ensureResident(id).store.openAround(entryId).then(() => undefined) : Promise.resolve(),
    // An empty window that leaves the viewport short is read again from the tail.
    hydrateAnchor: (id) => residents.get(id) ? ensureResident(id).store.jumpToLatest() : Promise.resolve(),
    jumpToLatest: (id) => residents.get(id) ? ensureResident(id).store.jumpToLatest() : Promise.resolve(),
    hydrateBlockBody: (id, blockId) => {
      const existing = residents.get(id)
      if (!existing) return Promise.resolve()
      const block = existing.store.view.blocks.find((candidate) => (candidate.kind === "tool" || candidate.kind === "system" || candidate.kind === "userMessage") && blockIdentity(candidate) === blockId)
      return block !== undefined && "id" in block ? existing.store.hydrateBody(block.id) : Promise.resolve()
    },
    takeEstimateUpdates: (id) => {
      const existing = residents.get(id)
      if (!existing || existing.estimateUpdates.size === 0) return []
      const updates = [...existing.estimateUpdates.entries()]
      existing.estimateUpdates.clear()
      return updates
    },
    evictBefore: (id, blockIndex) => { residents.get(id)?.store.dropBefore(blockIndex) },

    retain: (id) => {
      const handle = residents.retain(id)
      if (deferred.delete(id)) {
        dirty.add(id)
        flush("immediate", false)
      }
      return handle
    },
    visibleRange: snapshotOf,
    visibleMessageCount: (id) => visibleCounts[id] ?? residents.get(id)?.store.view.visibleMessageCount ?? 0,
    streamingOutputChars: (id) => streamedChars[id],
    freshness: (id) => freshness[id],
    historyMetadata: (id) => {
      const consistent = snapshotOf(id)
      if (!consistent) return undefined
      return { consistencyToken: consistent.source.kind === "historical" ? consistent.source.consistencyToken : null, totalBlocks: consistent.totalBlocks, window: consistent.window }
    },
    setDisclosure: (id, key, expanded) => setDisclosed(childStateKey(id, key), expanded),
    disclosure: (id, key) => disclosed[childStateKey(id, key)],
    disclosures: (id) => {
      const prefix = childStateKey(id, "")
      return Object.fromEntries(Object.entries(disclosed).flatMap(([key, expanded]) => key.startsWith(prefix) ? [[key.slice(prefix.length), expanded]] : []))
    },
    // The live OutputView for a session = the one block list and its streaming
    // tool text, composed from their stores.
    view: (id) => {
      const snap = cache[id]
      return snap === undefined ? undefined : { blocks: snap.blocks, streamingToolText: streamingCache[id] ?? {} }
    },
    ensure: (id) => { ensureResident(id) },
  }
}

