import type { BackoffOptions } from "../../infra/backoff.js"
import { errorMessage } from "../../infra/error-message.js"
import { isAgentInFlight } from "../../infra/output-blocks.js"
import { blockEntryKeys, blockIdentity } from "../block-identity.js"
import { buildBlockIndex, applyOutputDelta, foldAgentGroupBlock, rewritesSlotsOnly, outputDeltaRejectionEvidence, type MutableOutputView, type OutputDeltaRejection } from "../client/transcript-delta.js"
import type { FrontendOutputBlock, FrontendToolEntry, FrontendToolStreamingText } from "../app-service-types.js"
import { isOutputPayload, outputCursor, type OutputDelta } from "../output-protocol-types.js"
import type { HydratedOutputBlockBody, OutputRangeAnchor, TranscriptUnavailable } from "../transcript-protocol-types.js"
import type { RuntimePosition } from "../runtime-ui-protocol-types.js"
import { createCursorIntake, isLaneBreak, type CursorIntake } from "../client/cursor-intake.js"
import type { RuntimeConnection } from "./connection.js"
import { bodyId, boundedWindow, coversResidentSpan, detachedDelta, EMPTY_TRANSCRIPT_VIEW, historicalThrough, pageSplice, protectedCut, readerAccepts, recoveryAnchor, retainPayloads, rewrittenWindow, unchangedOwner, foldHydratedGroups, totalAfterDelta, transcriptRangeRequest, windowFromRead, type ReadWindow } from "./transcript-store-paging.js"
import { readTranscriptGroupChildren } from "./transcript-group-children.js"
import { createMutationEvidenceReader, type MutationEvidenceReader } from "./mutation-evidence.js"
import { retainTranscriptEvidence } from "./transcript-evidence-lifetime.js"
import { readTranscriptWindow } from "./transcript-window-read.js"
import { createTranscriptSettlementRecovery } from "./transcript-settlement-recovery.js"

/** One session's rendered transcript: a resident window over an absolute block
 *  sequence, advanced by live deltas and repaired from bounded reads. Every
 *  client holds its transcript through this store; a client owns only how it
 *  presents the view (its toolkit's reactive projection, row grouping, paging
 *  gestures), never what the window holds or how it recovers.
 *
 *  The delta application itself is Flywheel's. Its rules are not obvious and
 *  they are not incidental: a redelivered insert refreshes in place because
 *  identity rather than index is the idempotency key; an upsert that would
 *  overwrite a different resident identity is a coordinate disagreement rather
 *  than an edit; an agent group folds its children instead of replacing them,
 *  because the wire ships only a bounded tail of them. Restating that here
 *  would mean maintaining a second, quietly diverging opinion about what a
 *  delta means. So this owns the window and the recovery, and borrows the
 *  meaning of a delta from the runtime that mints them. */

export interface TranscriptView {
  /** Highest output cursor whose covered bytes are installed in this attached
   *  resident tail. Null means the current window cannot prove live coverage. */
  readonly appliedOutputPosition: RuntimePosition | null
  readonly blocks: readonly FrontendOutputBlock[]
  readonly streamingToolText: { readonly [toolUseId: string]: FrontendToolStreamingText }
  /** Full bodies fetched on demand, keyed by block id.
   *
   *  The wire truncates a tool body to a preview and states the loss in
   *  `diffOmission` / `contentOmittedLines` / `invocationBodyOmittedBytes`.
   *  A view that renders the preview and ignores those values tells the reader
   *  a 20-line excerpt is the whole change, which for a diff is the difference
   *  between reviewing a change and being shown a flattering part of one. */
  readonly bodies: { readonly [blockId: string]: HydratedOutputBlockBody }
  /** Children fetched for an agent group, by group block id. */
  readonly groups: { readonly [groupBlockId: string]: { readonly children: readonly FrontendToolEntry[]; readonly total: number } }
  /** Children reads in flight or failed, by group block id, so a client can
   *  show a group as loading or say why its rows did not arrive. */
  readonly groupRequests: { readonly [groupBlockId: string]: GroupRequestState }
  /** Absolute index of `blocks[0]`, or null when nothing is resident. */
  readonly startBlockIndex: number | null
  readonly totalBlocks: number
  readonly visibleMessageCount: number
  /** The session's streamed character count. Like `visibleMessageCount`, it
   *  follows the live end while the window is detached from it. */
  readonly streamingOutputChars: number
  readonly hasBefore: boolean
  /** Whether the resident window still reaches the live end of the transcript.
   *  Paging far enough back detaches it, because the window is bounded. */
  readonly atTail: boolean
  /** Set while detached and the transcript holds output past the window's end:
   *  output the runtime produced since, or the live end the bound trimmed. It is
   *  the one signal a client reads to page newer or offer a way back, since a
   *  detached window's `totalBlocks` does not follow live output. */
  readonly hasNewer: boolean
  /** The token of the latest read this window descends from: range-snapshot
   *  provenance, never coordinate authority. Null for a live (runner-held)
   *  window. */
  readonly consistencyToken: string | null
  /** Highest absolute index hydrated from derived history, or -1. Rows at or
   *  below it are settled history a client may render collapsed; rows past it
   *  arrived live. A live window is -1 throughout. */
  readonly historicalThroughIndex: number
}

type GroupRequestState = { readonly kind: "loading" } | { readonly kind: "failed"; readonly message: string }

export type TranscriptStatus = "idle" | "loading" | "ready" | "unavailable" | "recovery-failed"

/** One block slot the non-structural delta path rewrote, so a client's
 *  reactive projection can update that slot alone. `appendedText` is the new
 *  suffix for a pure append and empty otherwise. */
export interface BlockReplacement {
  readonly localIndex: number
  readonly prior: FrontendOutputBlock | undefined
  readonly next: FrontendOutputBlock
  readonly appendedText: string
}

/** What one store change did, so a listener can react in proportion: rewrite
 *  the slots a delta touched, or re-read the whole window after a read
 *  installed, merged, paged, or trimmed it. */
export type TranscriptChange =
  | {
    readonly kind: "deltas"
    readonly replaced: readonly BlockReplacement[]
    /** Resident indices moved through truncation, displacement, or a head trim,
     *  so slot-wise updates are not safe and the window is re-read whole. */
    readonly structural: boolean
    readonly streamingChanged: boolean
  }
  | {
    readonly kind: "window"
    /** `install` and `around` repave the coordinate space; `merge` proved
     *  continuity with the resident window; `older`, `newer`, and `drop` keep
     *  the coordinate space and move one edge. */
    readonly reason: "install" | "merge" | "older" | "newer" | "around" | "drop"
    /** The blocks the read and its drained live patches delivered, for a client
     *  that confirms delivery. */
    readonly adopted: readonly FrontendOutputBlock[]
  }
  | { readonly kind: "status" }
  | { readonly kind: "body"; readonly blockId: string }
  | { readonly kind: "group"; readonly groupBlockId: string }

export interface TranscriptStore {
  /** Passive evidence resource, published separately from the output block window. */
  readonly mutationEvidence: MutationEvidenceReader
  readonly view: TranscriptView
  /** Counts the reads that replaced the resident window outright: the
   *  `install` and `around` window changes. A merge, a page, a trim, or a
   *  delta keeps it. A client that remembers how it presented the window
   *  starts that memory again when this changes, since a replacement can
   *  share block ids with the window it replaced. */
  readonly windowGeneration: number
  /** The latest opaque barrier covered by this client's own fresh tail adoption. */
  readonly settledOutputRecovery: string | undefined
  /** Requests bounded recovery for missing public output or an opaque barrier.
   * Repeated requirements coalesce; an older read cannot prove an opaque barrier. */
  recoverSettlement(requirement: string | RuntimePosition): void
  readonly status: TranscriptStatus
  /** The window has complete, read-seeded coverage on this lane, including
   * detached history. Failed or incomplete recovery holds dependent actions. */
  readonly windowCurrent: boolean
  /** Why the transcript is unavailable or could not be recovered, while
   *  `status` says which. */
  readonly unavailable: TranscriptUnavailable | undefined
  /** Fetch one block's full body without delaying window reads. Overlapping
   *  reads of the same owner share one promise; held bodies are not re-read. */
  hydrateBody(blockId: string): Promise<void>
  /** Drops every fetched body, for a client that bounds what its hidden
   *  sessions keep. A row the person opened reads its body again when shown. */
  releaseBodies(): void
  /** Fetches the tool rows inside one agent group. A group arrives carrying a
   *  count and, past a size, none of the children it counted. */
  hydrateGroup(groupBlockId: string): Promise<void>
  /** Return to the live end after paging back far enough to detach. */
  jumpToLatest(): Promise<void>
  /** Refresh the live end for a following reader, or recover the protected
   * visible span in current coordinates for a reader in history. */
  refresh(): Promise<void>
  /** Answers the identity of the block a chat entry produced, as a search hit
   *  names it, so the view can mark it. A block already in the resident window
   *  answers at once: no read, and the window and its generation stay.
   *  Otherwise the resident window is replaced with the one centred on that
   *  block. A window that reaches the live end is
   *  installed as the tail; one that does not is a page of history, with the
   *  live end noted as newer. An entry the runtime cannot place lands on the
   *  tail and answers nothing. */
  openAround(entryId: string): Promise<string | undefined>
  /** Page backwards. Overlapping calls return the same promise. It resolves
   *  true when an older window merged and false when nothing changed. */
  loadOlder(): Promise<boolean>
  /** Page forwards from a window that left the tail. Same contract as
   *  `loadOlder`; a window that reaches the live end reattaches to it. */
  loadNewer(): Promise<boolean>
  /** Drop resident blocks before an absolute index. Absolute indices stand,
   *  `hasBefore` flips so paging back re-fetches on demand: a client with a
   *  viewport keeps residency near what the reader sees. */
  dropBefore(blockIndex: number): void
  onChange(listener: (change: TranscriptChange) => void): () => void
  dispose(): void
}

export interface TranscriptReader {
  readonly following: boolean
  readonly blockIds: readonly string[]
}

export interface TranscriptStoreOptions {
  /** Read the client's visible identities before choosing residency or recovery.
   * The client owns this input; the store owns the resulting contiguous window. */
  readonly reader?: () => TranscriptReader | undefined
  /** `watchOutput` is required: the runtime sends a session's live output
   *  only to a connection that watches it, so a store that read without
   *  watching would show a transcript that never moves. */
  readonly connection: Pick<RuntimeConnection, "query" | "subscribe" | "onLane" | "watchOutput">
  readonly sessionId: string
  /** How many blocks a page asks for. Kept modest: the first paint should be
   *  fast, and older pages arrive on demand. */
  readonly pageBlocks?: number
  readonly pageBytes?: number
  readonly maxResidentBlocks?: number
  /** Whether reads ask for thinking content bytes. Read per request, so a
   *  setting flipped mid-session shapes the next read. */
  readonly includeThinkingContent?: () => boolean
  /** Bounded retry for the reads that recover the window; exhaustion is the
   *  `recovery-failed` status. */
  readonly recoveryBackoff?: BackoffOptions
  readonly recoveryMaxAttempts?: number
  readonly onDiagnostic?: (message: string, detail?: unknown) => void
  /** The session was just created, so its transcript is empty: the view starts
   *  ready, and the first tail read still seeds the held live output. */
  readonly knownEmpty?: boolean
}

const DEFAULT_PAGE_BLOCKS = 120
const DEFAULT_PAGE_BYTES = 512 * 1024
/** Bounds the resident window, not just each individual read. */
const DEFAULT_MAX_RESIDENT_BLOCKS = 600
const DEFAULT_RECOVERY_BACKOFF: BackoffOptions = { baseMs: 250, maxMs: 4_000, factor: 2 }
const DEFAULT_RECOVERY_MAX_ATTEMPTS = 4

/** The identity of the block among `blocks` that a chat entry produced. */
function holding(blocks: readonly FrontendOutputBlock[], entryId: string): string | undefined {
  const block = blocks.find((candidate) => blockEntryKeys(blockIdentity(candidate)).includes(entryId))
  return block === undefined ? undefined : blockIdentity(block)
}

export function createTranscriptStore(options: TranscriptStoreOptions): TranscriptStore {
  const mutationEvidence = createMutationEvidenceReader(options)
  const pageBlocks = options.pageBlocks ?? DEFAULT_PAGE_BLOCKS
  const pageBytes = options.pageBytes ?? DEFAULT_PAGE_BYTES
  const maxResident = options.maxResidentBlocks ?? DEFAULT_MAX_RESIDENT_BLOCKS
  const recoveryBackoff = options.recoveryBackoff ?? DEFAULT_RECOVERY_BACKOFF
  const recoveryMaxAttempts = options.recoveryMaxAttempts ?? DEFAULT_RECOVERY_MAX_ATTEMPTS
  const cursor = outputCursor(options.sessionId)
  const listeners = new Set<(change: TranscriptChange) => void>()
  let seedingAdopted: FrontendOutputBlock[] | undefined

  let view: TranscriptView = EMPTY_TRANSCRIPT_VIEW
  let windowGeneration = 0
  let status: TranscriptStatus = options.knownEmpty ? "ready" : "idle"
  let unavailable: TranscriptUnavailable | undefined
  let blockIndex = new Map<string, number>()
  let disposed = false
  // Serializes the reads that replace resident state. Two tail reads racing
  // would each seed the cursor from a different position, and the loser would
  // leave the intake anchored to a window that is no longer resident.
  let work: Promise<void> = Promise.resolve()
  let queued = 0
  // The latest lane this store read on, and the next lane's opening, which a
  // read lost with its lane waits for.
  let lane = 0
  let laneOpened = Promise.withResolvers<void>()
  let rejoinPending = false
  let rejoinAgain = false
  let rejoinIntent: "merge" | "latest" | "repave" = "merge"
  // Overlapping calls in one direction share one read.
  const pendingPages = new Map<"older" | "newer", Promise<boolean>>()
  const pendingBodies = new Map<string, { owner: FrontendOutputBlock; promise: Promise<void> }>()
  const pageToward = (direction: "older" | "newer"): Promise<boolean> => {
    const pending = pendingPages.get(direction)
    if (pending !== undefined) return pending
    let loaded = false
    const operation = enqueue(async () => { loaded = await loadPage(direction) }).then(() => loaded).finally(() => {
      if (pendingPages.get(direction) === operation) pendingPages.delete(direction)
    })
    pendingPages.set(direction, operation)
    return operation
  }

  const emit = (change: TranscriptChange): void => {
    if (change.kind === "deltas" && seedingAdopted !== undefined) {
      for (const { next } of change.replaced) seedingAdopted.push(next)
      return
    }
    for (const listener of listeners) listener(change)
  }

  /** Runs one read-and-write operation after every earlier one. An operation
   *  that finds the store idle starts at once, so its read is on the wire
   *  before the caller's next line; a failure ends the operation, never the
   *  chain. */
  function enqueue(operation: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await operation()
      } catch {
        // Each operation reports its own failure through the diagnostic sink.
      } finally {
        queued -= 1
      }
    }
    queued += 1
    work = queued === 1 ? run() : work.then(run)
    return work
  }

  const rangeRequest = (anchor: OutputRangeAnchor) => transcriptRangeRequest(anchor, pageBlocks, pageBytes, options.includeThinkingContent)

  const settlement = createTranscriptSettlementRecovery({
    disposed: () => disposed,
    atTail: () => view.atTail,
    appliedOutputPosition: () => view.appliedOutputPosition,
    enqueue,
    anchor: () => recoveryAnchor(view, blockIndex, options.reader?.(), false),
    accepts: (tail) => readerAccepts(tail, view, blockIndex, options.reader?.(), false),
    reset: () => {
      intake.reset()
      view = { ...view, appliedOutputPosition: null }
    },
    read: readWindow,
    install,
    merge,
    changed: () => emit({ kind: "status" }),
  })

  const intake: CursorIntake = createCursorIntake({
    cursor,
    onApply: (patch) => { if (isOutputPayload(patch.payload)) applyDelta(patch.payload.delta, patch.position, patch.prevPosition) },
    onRecover: (request) => {
      // An unseeded hold past its deadline asks for the read a pending rejoin
      // already makes, and that read's seed drains what the intake kept.
      // Reading again instead would keep the pane loading for as long as each
      // read outlasts the deadline while the session streams. A seeded hold
      // means an earlier queued read seeded the intake and its gap may predate
      // the rejoin read, so that one still repairs.
      if (request.reason === "gap_unclosed" && rejoinPending && intake.heldPosition === null) return
      options.onDiagnostic?.("transcript recovering", { reason: request.reason, policy: request.policy, invalidation: request.invalidation })
      // Only a rebase moves the block coordinates. Every other recovery repairs
      // missed frames over the same coordinates.
      void rejoin(request.invalidation === "rebase" ? "repave" : "repair")
    },
  })

  function setStatus(next: TranscriptStatus, detail?: TranscriptUnavailable): void {
    if (status === next && unavailable === detail) return
    status = next
    unavailable = detail
    emit({ kind: "status" })
  }

  /** Every block write commits one bounded window and its owned payloads.
   *  Older paging retains the requested prefix; all tail writes retain the
   *  suffix. Answers how many head blocks the bound dropped, which moves every
   *  resident index. A delta that only rewrote slots passes its `rewrites`, and
   *  commits without the whole-window pass while each rewrite keeps its slot's
   *  identity: at the residency bound that pass is most of what a streaming
   *  delta costs, and a client applies deltas for every session it keeps. */
  function commitWindow(next: TranscriptView, keep: "newest" | "oldest" = "newest", preparedIndex?: Map<string, number>, rewrites?: readonly BlockReplacement[], protect = true): number {
    const previous = view
    const rewritten = rewrites && rewrittenWindow(next, view, blockIndex, rewrites)
    if (rewritten) { view = rewritten; retainTranscriptEvidence(mutationEvidence, previous, view, rewrites); return 0 }
    const reader = protect ? options.reader?.() : undefined
    const bounded = boundedWindow(next, view, blockIndex, maxResident, keep, reader?.following === false ? reader.blockIds : [])
    // While detached the window shows no live output, so each crossing is the
    // first thing to read when a pane stops following its session.
    if (bounded.view.atTail !== view.atTail) options.onDiagnostic?.(`transcript window ${bounded.view.atTail ? "rejoined" : "detached from"} the live end`, { start: bounded.view.startBlockIndex, count: bounded.view.blocks.length, total: bounded.view.totalBlocks, hasNewer: bounded.view.hasNewer, keep })
    view = bounded.view
    blockIndex = view.blocks === next.blocks && preparedIndex ? preparedIndex : buildBlockIndex(view.blocks)
    retainTranscriptEvidence(mutationEvidence, previous, view)
    return bounded.droppedHead
  }

  function applyDelta(input: OutputDelta, position: RuntimePosition, previousPosition: RuntimePosition): void {
    let delta = input
    const visibleMessageCount = delta.visibleMessageCount ?? view.visibleMessageCount
    const streamingOutputChars = delta.streamingOutputChars ?? view.streamingOutputChars
    if (!view.atTail || options.reader?.()?.following === false) {
      const retained = detachedDelta(delta, view, blockIndex)
      if (!retained) { void rejoin("repave"); return }
      if (!view.atTail) {
        view = { ...view, hasNewer: true, visibleMessageCount, streamingOutputChars }
        if (retained.blocks.length === 0 && !retained.streamingToolTextOps?.length) { emit({ kind: "status" }); return }
        delta = retained
      }
    }
    const draft: MutableOutputView = { blocks: [...view.blocks], streamingToolText: view.streamingToolText }
    // A structural delta mutates the index in place as it is walked, so it
    // works on a copy that is adopted only once the whole delta applied.
    // Otherwise a rejected delta leaves the index describing a block list that
    // was never installed, and the next delta is resolved against that
    // fiction. A delta that only rewrites slots never writes the index.
    const slotsOnly = rewritesSlotsOnly(delta)
    const draftIndex = slotsOnly ? blockIndex : new Map(blockIndex)
    // Replaced only when a group folds. Most deltas fold none, and a view that
    // minted a fresh map on each of them told every reader the groups changed
    // on every token.
    let groups = view.groups
    const replaced: BlockReplacement[] = []
    let displaced = false
    let rejection: OutputDeltaRejection | undefined
    const applied = applyOutputDelta(draft, delta, draftIndex, view.startBlockIndex ?? 0, (localIndex, prior, next, appendedText) => {
      groups = foldHydratedGroups(groups, next)
      replaced.push({ localIndex, prior, next, appendedText })
      // The hook runs after the write. A new slot at length - 1 appended;
      // anywhere earlier displaced a resident or an earlier write in this delta.
      if (prior === undefined && localIndex !== draft.blocks.length - 1) displaced = true
    }, (failure) => { rejection = failure })
    if (!applied) {
      // The delta disagrees with the resident window. Guessing here is what
      // produces a pane that renders confidently and wrongly.
      options.onDiagnostic?.("transcript delta diverged from the resident window", outputDeltaRejectionEvidence(view, delta, position, previousPosition, rejection))
      view = { ...view, appliedOutputPosition: null }
      void rejoin("repave")
      return
    }
    const streamingChanged = draft.streamingToolText !== view.streamingToolText
    const droppedHead = commitWindow({
      appliedOutputPosition: position,
      blocks: draft.blocks,
      streamingToolText: draft.streamingToolText,
      bodies: view.bodies,
      groups,
      groupRequests: view.groupRequests,
      startBlockIndex: view.startBlockIndex ?? (draft.blocks.length > 0 ? 0 : null),
      totalBlocks: totalAfterDelta(view, delta, draft.blocks.length),
      visibleMessageCount,
      streamingOutputChars,
      hasBefore: view.hasBefore,
      atTail: view.atTail,
      hasNewer: view.hasNewer,
      consistencyToken: view.consistencyToken,
      historicalThroughIndex: view.historicalThroughIndex,
    }, "newest", draftIndex, slotsOnly ? replaced : undefined)
    const structural = delta.truncateTo !== undefined || droppedHead > 0 || displaced || draft.blocks.length !== view.blocks.length
    emit({ kind: "deltas", replaced, structural, streamingChanged })
  }

  /** Reads an authoritative window, retrying failures on a bounded backoff.
   *  Answers nothing when the read is exhausted, after saying so: with nothing
   *  resident the failure is all there is to show, and with a window resident
   *  the window stays and the next attach reads again. */
  async function readWindow(anchor: OutputRangeAnchor = { kind: "tail" }, purpose: "window" | "proof" = "window"): Promise<ReadWindow | undefined> {
    const settlementRecovery = anchor.kind === "tail" ? settlement.requestedBarrier : undefined
    const result = await readTranscriptWindow({
      read: () => options.connection.query({ type: "outputWindow", sessionId: options.sessionId, request: { range: rangeRequest(anchor) } }),
      disposed: () => disposed, lane: () => lane,
      waitForLane: async (readLane) => { if (lane === readLane) await laneOpened.promise },
      backoff: recoveryBackoff, maxAttempts: recoveryMaxAttempts, onDiagnostic: options.onDiagnostic,
    })
    if (result === undefined) return undefined
    if ("failure" in result) {
      if (purpose === "window") setStatus("recovery-failed", result.failure)
      return undefined
    }
    const { snapshot } = result
    const range = snapshot.range
    if (range.kind === "unavailable") {
      if (purpose === "window") setStatus("unavailable", range.unavailable)
      return undefined
    }
    if (anchor.kind === "residentSpan" && !coversResidentSpan(range, anchor)) {
      setStatus("recovery-failed", { title: "Transcript could not be recovered", message: "Could not read the visible transcript span.", diagnostic: "Incomplete resident span coverage" })
      return undefined
    }
    return { range, totalBlocks: snapshot.totalBlocks, visibleMessageCount: snapshot.visibleMessageCount, snapshotPosition: snapshot.snapshotPosition, settlementRecovery }
  }

  /** A seed drains synchronously in the adopted coordinates. Publish those
   *  blocks and streaming state with the read, never as slots in the old window. */
  function publishSeededWindow(read: ReadWindow, reason: "install" | "around" | "merge"): void {
    const adopted = [...read.range.blocks]
    seedingAdopted = adopted
    try {
      intake.seed(read.snapshotPosition)
    } finally {
      seedingAdopted = undefined
    }
    if (reason !== "merge") windowGeneration += 1
    emit({ kind: "window", reason, adopted })
    setStatus("ready")
  }

  /** Adopt authoritative coordinates before draining pending deltas. Anchored
   * recovery preserves the presentation generation; explicit navigation does not. */
  function install(tail: ReadWindow, reason: "install" | "around" | "merge" = "install"): void {
    commitWindow(windowFromRead(tail, view, blockIndex), "newest", undefined, undefined, reason === "merge")
    // Seeding after the view is installed, never before: the position and
    // the bytes it describes have to become resident together, or a patch
    // arriving between them applies to a window that is not there yet.
    if (tail.range.anchor.kind === "tail") settlement.recordTailProof(tail.settlementRecovery)
    publishSeededWindow(tail, reason)
  }

  /** Lays the live tail over the resident window, keeping what the tail does
   *  not cover: the pages the reader walked back through, the bodies fetched
   *  for blocks the tail left unchanged, and the group children fetched so
   *  far. The tail is applied as the upserts it amounts to, so the delta rules
   *  decide what an arriving block means to a resident one. Answers false when
   *  the two windows do not meet, which is when nothing here is evidence about
   *  the live end any more. */
  function merge(tail: ReadWindow): boolean {
    const start = view.startBlockIndex
    const freshStart = tail.range.window.startBlockIndex
    if (start === null || freshStart === null) return false
    const end = start + view.blocks.length
    if (freshStart < start || freshStart > end) return false
    const freshEnd = freshStart + tail.range.blocks.length
    const draft: MutableOutputView = { blocks: [...view.blocks], streamingToolText: tail.range.streamingToolText }
    const draftIndex = new Map(blockIndex)
    let groups = view.groups
    const delta: OutputDelta = {
      visibleMessageCount: tail.visibleMessageCount,
      // A live end that ends before the resident one is a repave. Saying so
      // lets the upserts replace the identities the repave changed.
      ...(freshEnd < end ? { truncateTo: freshEnd } : {}),
      blocks: tail.range.blocks.map((block, offset) => ({ kind: "upsert" as const, index: freshStart + offset, blockId: blockIdentity(block), block })),
    }
    const applied = applyOutputDelta(draft, delta, draftIndex, start, (_index, _prior, next) => {
      groups = foldHydratedGroups(groups, next)
    })
    if (!applied) return false
    commitWindow({
      appliedOutputPosition: tail.snapshotPosition,
      blocks: draft.blocks,
      streamingToolText: draft.streamingToolText,
      bodies: view.bodies,
      groups,
      groupRequests: view.groupRequests,
      startBlockIndex: start,
      totalBlocks: tail.totalBlocks,
      visibleMessageCount: tail.visibleMessageCount,
      streamingOutputChars: tail.range.streamingOutputChars,
      hasBefore: freshStart > start ? view.hasBefore : tail.range.window.hasBefore,
      atTail: true,
      hasNewer: false,
      consistencyToken: tail.range.consistencyToken,
      historicalThroughIndex: historicalThrough(tail.range, view.historicalThroughIndex),
    })
    settlement.recordTailProof(tail.settlementRecovery)
    publishSeededWindow(tail, "merge")
    return true
  }

  function retainRejoinIntent(intent: "attach" | "repair" | "merge" | "latest" | "repave"): void {
    if (intent === "repave" || (intent === "latest" && rejoinIntent !== "repave")) rejoinIntent = intent
  }

  /** Recovery follows exact visible identities whenever the reader is not
   * following. Rebase changes coordinates, not subject lifetime. A newer
   * recovery directive or reader destination invalidates a pending read.
   * Explicit latest intent survives queued paging and may replace history. */
  function rejoin(cause: "attach" | "repair" | "latest" | "repave"): Promise<void> {
    retainRejoinIntent(cause)
    if (rejoinPending) {
      if (cause !== "attach") rejoinAgain = true
      return work
    }
    rejoinPending = true
    // Unanchor before the read, not after it. While unseeded the intake holds
    // what arrives instead of applying it to a window that is about to be
    // replaced, and the seed when the tail lands drains the hold in position
    // order. Holding while unseeded has its own liveness, so a read that never
    // answers still ends in recovery rather than silence.
    intake.reset()
    if (view.appliedOutputPosition !== null) view = { ...view, appliedOutputPosition: null }
    return enqueue(async () => {
      try {
        do {
          rejoinAgain = false
          if (disposed) return
          if (view.blocks.length === 0 && status !== "ready") setStatus("loading")
          const intent = rejoinIntent
          rejoinIntent = "merge"
          const anchor = recoveryAnchor(view, blockIndex, options.reader?.(), intent === "latest")
          const tail = await readWindow(anchor)
          if (rejoinAgain) continue
          if (tail !== undefined && !readerAccepts(tail, view, blockIndex, options.reader?.(), intent === "latest")) {
            rejoinAgain = true
            continue
          }
          if (tail === undefined) retainRejoinIntent(intent)
          else if (anchor.kind === "residentSpan") install(tail, "merge")
          else if (intent === "repave" || (intent === "latest" && !view.atTail)) {
            install(tail)
          }
          else if (!view.atTail) {
            view = { ...view, hasNewer: view.hasNewer || tail.totalBlocks > view.totalBlocks, visibleMessageCount: tail.visibleMessageCount, streamingOutputChars: tail.range.streamingOutputChars }
            intake.seed(tail.snapshotPosition)
            emit({ kind: "status" })
          } else if (!merge(tail)) install(tail)
          if (rejoinAgain) intake.reset()
        } while (rejoinAgain)
      } finally {
        rejoinPending = false
      }
    })
  }

  /** One page toward an edge, spliced onto the resident window when it meets
   *  it. The runtime resolves a block anchor against `blockIdentity`, the
   *  kind-prefixed form; a raw id matches nothing and the affordance would
   *  stay offered forever with nothing ever loading. */
  async function loadPage(direction: "older" | "newer"): Promise<boolean> {
    if (disposed) return false
    if (direction === "older" ? !view.hasBefore : view.atTail) return false
    const edge = direction === "older" ? view.blocks[0] : view.blocks.at(-1)
    if (!edge) return false
    const anchorId = blockIdentity(edge)
    try {
      const page = await options.connection.query({
        type: "outputRange",
        sessionId: options.sessionId,
        request: rangeRequest({ kind: direction === "older" ? "beforeBlock" : "afterBlock", blockId: anchorId }),
      })
      if (disposed || page.kind === "unavailable") return false
      const splice = pageSplice(direction, page, view, blockIndex)
      if (splice.kind === "refused") {
        // Saying so beats leaving the affordance offered forever with no explanation.
        options.onDiagnostic?.(splice.reason, { anchor: anchorId })
        // A runtime splice can move this seam while the page is pending.
        // Recover the reader's span before a later page uses new coordinates.
        if (direction === "newer") void rejoin("repave")
        return false
      }
      if (direction === "older") {
        commitWindow({
          ...view,
          blocks: [...splice.blocks, ...view.blocks],
          startBlockIndex: splice.pageStart,
          hasBefore: page.window.hasBefore,
          consistencyToken: page.consistencyToken,
          historicalThroughIndex: historicalThrough(page, view.historicalThroughIndex),
        }, "oldest")
        emit({ kind: "window", reason: "older", adopted: splice.blocks })
        return true
      }
      // A page that reaches the live end reattaches the window to it. This read
      // carries no position, so the window keeps the detached window's null
      // live coverage until the tail read below merges what arrived since and
      // seeds the intake, which holds every patch until then.
      const reachesTail = !page.window.hasAfter
      commitWindow({
        ...view,
        blocks: [...view.blocks, ...splice.blocks],
        totalBlocks: Math.max(view.totalBlocks, splice.pageEnd + 1),
        atTail: reachesTail,
        hasNewer: !reachesTail,
        consistencyToken: page.consistencyToken,
        historicalThroughIndex: historicalThrough(page, view.historicalThroughIndex),
      }, "newest")
      emit({ kind: "window", reason: "newer", adopted: splice.blocks })
      if (reachesTail) void rejoin("attach")
      return true
    } catch (cause) {
      options.onDiagnostic?.(`${direction} transcript page failed`, cause)
      return false
    }
  }

  const unsubscribe = options.connection.subscribe((event) => {
    if (disposed || event.type !== "patch") return
    intake.accept(event.patch)
    // The intake forgot its position with the lane, so the window proves no
    // live coverage until the next lane's tail read seeds it again.
    if (isLaneBreak(event.patch)) {
      if (view.appliedOutputPosition !== null) view = { ...view, appliedOutputPosition: null }
      emit({ kind: "status" })
    }
  })
  let releaseWatch = (): void => {}
  // Nothing reads before a lane opens. Later lanes recover the reading span
  // or live end according to the client's published intent. Each lane's
  // watch is taken before its read, so the output the read does not hold
  // follows it on the lane.
  const stopLanes = options.connection.onLane((next) => {
    const first = lane === 0
    lane = next
    releaseWatch()
    releaseWatch = options.connection.watchOutput(options.sessionId)
    laneOpened.resolve()
    laneOpened = Promise.withResolvers<void>()
    void rejoin(first ? "repave" : "attach")
  })

  return {
    mutationEvidence,
    get settledOutputRecovery() { return settlement.coveredBarrier },
    recoverSettlement: settlement.recover,
    get view() { return view },
    get windowGeneration() { return windowGeneration },
    get status() { return status },
    get windowCurrent() { return status === "ready" && intake.heldPosition !== null },
    get unavailable() { return unavailable },
    loadOlder: () => pageToward("older"),
    loadNewer: () => pageToward("newer"),
    dropBefore(blockIndexToKeep) {
      const start = view.startBlockIndex
      const cut = protectedCut(blockIndexToKeep, start, blockIndex, options.reader?.())
      if (start === null || cut <= start || cut - start >= view.blocks.length) return
      const blocks = view.blocks.slice(cut - start)
      commitWindow({ ...view, blocks, startBlockIndex: cut, hasBefore: true }, "oldest")
      emit({ kind: "window", reason: "drop", adopted: [] })
    },
    hydrateBody(blockId) {
      if (disposed || view.bodies[blockId] !== undefined) return Promise.resolve()
      const pending = pendingBodies.get(blockId)
      if (pending !== undefined && unchangedOwner(view, blockIndex, pending.owner)) return pending.promise
      const block = view.blocks.find((candidate) => bodyId(candidate) === blockId)
      if (!block) return Promise.resolve()
      const request = (async () => {
        // The runtime resolves this through `blockIdentity` and throws when it
        // does not match, so the raw id has to be turned back into the
        // kind-prefixed form the block carries. The same mistake made paging a
        // silent no-op; here it made every hydration throw.
        try {
          const body = await options.connection.query({ type: "outputBlockBody", sessionId: options.sessionId, request: { blockId: blockIdentity(block) } })
          // Live deltas can evict or replace the owner while the RPC is pending.
          if (disposed || !unchangedOwner(view, blockIndex, block)) return
          if (body.missing) {
            await rejoin("attach")
            return
          }
          view = { ...view, bodies: { ...view.bodies, [blockId]: body } }
          emit({ kind: "body", blockId })
        } catch (cause) {
          if (disposed || !unchangedOwner(view, blockIndex, block)) return
          options.onDiagnostic?.("block body read failed", cause)
        }
      })().finally(() => { if (pendingBodies.get(blockId)?.promise === request) pendingBodies.delete(blockId) })
      pendingBodies.set(blockId, { owner: block, promise: request })
      return request
    },
    releaseBodies() {
      mutationEvidence.release()
      const released = Object.keys(view.bodies)
      view = { ...view, bodies: {} }
      for (const blockId of released) emit({ kind: "body", blockId })
    },
    hydrateGroup(groupBlockId) {
      return enqueue(async () => {
        if (disposed || view.groups[groupBlockId] !== undefined) return
        // An agent group and the tool row it came from share one identity, so
        // only the resident kind says whether the group is still shown.
        const residentGroup = () => view.blocks.find((candidate): candidate is Extract<FrontendOutputBlock, { kind: "agentGroup" }> => candidate.kind === "agentGroup" && candidate.id === groupBlockId)
        const block = residentGroup()
        if (!block) return
        view = { ...view, groupRequests: { ...view.groupRequests, [groupBlockId]: { kind: "loading" } } }
        emit({ kind: "group", groupBlockId })
        try {
          const collected = await readTranscriptGroupChildren(
            options.connection, options.sessionId, blockIdentity(block), pageBytes,
            () => !disposed && residentGroup() !== undefined,
          )
          if (!collected) return

          const current = residentGroup()
          if (!current) return
          const folded = foldAgentGroupBlock({ ...current, children: collected.children }, current)
          if (folded.kind !== "agentGroup") return
          // A settled response holds only presentable children: failed agent
          // updates are intentionally absent, so they must not keep a settled
          // group counting rows it will never show. A running group may still
          // be ahead of the read.
          const settledTotal = isAgentInFlight(current.status) ? Math.max(collected.total, current.totalToolCount) : Math.max(collected.total, folded.children.length)
          const next = {
            ...view,
            groups: { ...view.groups, [groupBlockId]: { children: folded.children, total: settledTotal } },
            groupRequests: retainPayloads(view.groupRequests, (id) => id !== groupBlockId),
          }
          const previous = view
          view = next
          retainTranscriptEvidence(mutationEvidence, previous, view)
          emit({ kind: "group", groupBlockId })
        } catch (cause) {
          options.onDiagnostic?.("group children read failed", cause)
          // A group that is no longer shown has no row to show the failure on.
          if (disposed || !residentGroup()) return
          const message = errorMessage(cause)
          view = { ...view, groupRequests: { ...view.groupRequests, [groupBlockId]: { kind: "failed", message } } }
          emit({ kind: "group", groupBlockId })
        }
      })
    },
    jumpToLatest() {
      return rejoin("latest")
    },
    refresh() {
      return rejoin("attach")
    },
    async openAround(entryId) {
      let found: string | undefined
      await enqueue(async () => {
        if (disposed) return
        // A resident block already stands in the window the view measured, so
        // a read would only replace that window and lose its row heights.
        found = holding(view.blocks, entryId)
        if (found !== undefined) return
        try {
          const settlementRecovery = settlement.requestedBarrier
          const snapshot = await options.connection.query({
            type: "outputWindow",
            sessionId: options.sessionId,
            request: { range: rangeRequest({ kind: "around", entryId }) },
          })
          if (disposed || snapshot.range.kind === "unavailable") return
          const range = snapshot.range
          const window = { range, totalBlocks: snapshot.totalBlocks, visibleMessageCount: snapshot.visibleMessageCount, snapshotPosition: snapshot.snapshotPosition, settlementRecovery }
          if (range.anchor.kind === "tail" || !range.window.hasAfter) {
            install(window, range.anchor.kind === "around" ? "around" : "install")
          } else {
            commitWindow({
              appliedOutputPosition: null,
              atTail: false,
              hasNewer: true,
              blocks: range.blocks,
              streamingToolText: range.streamingToolText,
              bodies: view.bodies,
              groups: view.groups,
              groupRequests: view.groupRequests,
              startBlockIndex: range.window.startBlockIndex,
              totalBlocks: snapshot.totalBlocks,
              visibleMessageCount: snapshot.visibleMessageCount,
              streamingOutputChars: range.streamingOutputChars,
              hasBefore: range.window.hasBefore,
              consistencyToken: range.consistencyToken,
              historicalThroughIndex: historicalThrough(range, -1),
            })
            // Seeded at the read's own position even though the window is not
            // the tail: the intake then counts the live end as newer rather
            // than as a gap that would resnapshot away from where the person
            // asked to be.
            publishSeededWindow(window, "around")
          }
          if (range.anchor.kind === "around") found = holding(range.blocks, entryId)
        } catch (cause) {
          options.onDiagnostic?.("transcript window around an entry failed", cause)
        }
      })
      return found
    },
    onChange(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose() {
      disposed = true
      mutationEvidence.dispose()
      settlement.dispose()
      stopLanes()
      releaseWatch()
      laneOpened.resolve()
      unsubscribe()
      intake.reset()
      if (view.appliedOutputPosition !== null) view = { ...view, appliedOutputPosition: null }
      listeners.clear()
    },
  }
}
