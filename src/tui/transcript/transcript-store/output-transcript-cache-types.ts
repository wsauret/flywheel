import type { FrontendOutputBlock } from "../../../protocol/app-service-types.js"
import type { MutationEvidenceReader } from "../../../protocol/client/mutation-evidence.js"
import type { SessionNotice } from "../../../infra/session-notice.js"
import type { RuntimeTranscriptWindow } from "../../../protocol/transcript-protocol-types.js"
import type { OutputView } from "../../../protocol/output-protocol-types.js"
import type { OutputHeightEstimate } from "./output-height-estimates.js"
import type { BlockDisclosureChannel } from "../../context/transcript/block-disclosure.js"

/** The resident-block budget: how many timeline blocks the TUI will hold
 *  mounted-or-resident for one session. One number, two enforcement
 *  mechanisms. A session whose TOTAL block count fits the budget mounts whole
 *  once to measure every height and hydrates to the head (then virtualizes to
 *  the viewport); a larger session virtualizes immediately, pages on demand,
 *  and far-page eviction sheds residency back under the same budget - so the
 *  two policies can never fight over one session. Sized ~3x the largest
 *  observed real session (~350 blocks; events fold heavily into blocks) at
 *  ~1ms measure cost per block. The over-budget path is insurance against the
 *  condensation policy changing, not an expected path. */
export const RESIDENT_BLOCK_BUDGET = 1000

/** Which edge of the loaded window a page request extends. `older` walks toward
 *  block 0, `newer` toward the tail. */
export type LoadDirection = "older" | "newer"
export type LoadPageResult = "loaded" | "skipped"

/** Per-session navigation status, including loading progress, recoverable range
 *  failures, and unrecoverable output-history degradation. */
export type TranscriptStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "partial" }
  | { readonly kind: "complete" }
  | { readonly kind: "unavailable"; readonly notice: SessionNotice; readonly diagnostic: string }
  | { readonly kind: "recovery-failed"; readonly message: string; readonly updatedAt: number }

type OutputTranscriptSource =
  | { readonly kind: "loading" }
  | { readonly kind: "live" }
  | { readonly kind: "historical"; readonly consistencyToken: string }

/** The client-side transcript window: the server's block-window metadata plus
 *  the TUI-owned row estimate. Rows are a layout concern the client measures
 *  and refines locally (the height index); the server never estimates them. */
interface TranscriptWindow extends RuntimeTranscriptWindow {
  readonly estimatedRows: number
}

/** The reactive per-session window the Solid store holds and `visibleRange()`
 *  reads. Block-level render projections (agent group ids, pending blocks,
 *  timeline) are deliberately absent: the cache owns navigation metadata only;
 *  OutputWindow derives those window-scoped over `blocks`.
 *
 *  A single read is snapshot-consistent: `visibleRange()` and `historyMetadata()`
 *  always report the same snapshot, so spacer math never mixes old blocks with
 *  new counts. While a reseed is repaving the entry the cache returns the
 *  `loading` status with no blocks rather than a stale window. */
export interface TranscriptSnapshot {
  readonly status: TranscriptStatus
  readonly source: OutputTranscriptSource
  /** Total blocks in the derived history. */
  readonly totalBlocks: number
  readonly window: TranscriptWindow
  readonly heightEstimates: readonly OutputHeightEstimate[]
  readonly blocks: readonly FrontendOutputBlock[]
  /** Monotone stamp bumped by every non-delta write (seed, splice, children
   *  hydration). Solid's reconcile can preserve a block's identity while
   *  mutating its fields, so identity checks alone cannot prove a resident
   *  prefix unchanged; consumers that cache derivations over the block list
   *  (the window projection prefix cache) must also key on this stamp. The
   *  16ms delta path never bumps it - deltas replace block objects, which the
   *  identity scan sees. */
  readonly seedEpoch: number
  /** Identity of the resident block-index space. Stable across continuous
   *  writes: live deltas, page splices, and reseeds whose merge proved
   *  block-for-block continuity with the resident window (a refreshed
   *  consistencyToken over the same content keeps it). Bumped only when the
   *  content is repaved without continuity: a fresh open, an unavailable
   *  seed, a non-mergeable reseed, or a merge that moves surviving identities.
   *  Measured row coordinates key on this. The surface retains reading intent
   *  and resolves its identity anchor in the new coordinate space. */
  readonly generation: number
  /** Highest absolute block index hydrated from derived history (-1 = none).
   *  Rows at or below it render historical (collapsed-by-default bodies);
   *  rows past it were appended live and render live. Live-sourced windows
   *  are always -1. */
  readonly historicalThroughIndex: number
}

export interface TranscriptFreshness {
  readonly revision: number
  readonly updatedAt: number
  readonly source: "live" | "range" | "status"
}

/** What the scroll controller drives on the shown transcript as the viewport
 *  moves: the message count it follows, the tail read, the delta path's row
 *  estimates, and far-page eviction. */
export interface TranscriptViewportPaging {
  /** Authoritative absolute count of user-visible messages. Reactive and
   * independent of the resident block window. */
  visibleMessageCount(): number
  /** Replace the resident reader window with the live tail. An empty window
   *  that leaves the viewport short reads the tail this way too. */
  jumpToLatest(): Promise<void>
  /** Drain the incremental delta path's per-block row-estimate point updates
   *  (absolute blockIndex -> rows) for the height index. Non-reactive. */
  takeEstimateUpdates(): readonly (readonly [number, number])[]
  /** Far-page eviction: drop resident blocks before `blockIndex` once the
   *  scroll controller's viewport-protected range clears them; absolute
   *  indices are untouched and the older-page path re-fetches on demand. */
  evictBefore(blockIndex: number): void
}

/** One session's transcript as OutputWindow renders it, bound to the shown
 *  session by `OutputTranscriptCache.bindSession`. The paging and lifecycle calls
 *  the render boundary must not make (open, loadPage, retain) are absent. As a
 *  `BlockDisclosureChannel` it reads and writes the session's block-identity-keyed
 *  disclosure map, which stays stable across prepends, generation bumps, and row
 *  virtualization. */
export interface OutputTranscriptView extends BlockDisclosureChannel, TranscriptViewportPaging {
  /** Publish visible block identities before the shared store chooses residency. */
  protectReader(reader: import("../../../protocol/client/transcript-view.js").TranscriptReader): void
  /** The resident session's passive evidence reader. Reactive; never opens a session. */
  mutationEvidence(): MutationEvidenceReader | undefined
  /** Record a failed projection with the resident store and rendered window metadata. Rethrows the same error. */
  reportProjectionFailure(error: unknown): never
  /** The generation-consistent hydrated window. Reactive. */
  visibleRange(): TranscriptSnapshot | undefined
  /** Low-cardinality freshness marker for render-boundary diagnostics. Reactive. */
  freshness(): TranscriptFreshness | undefined
  /** Replace the resident window with the bounded range around one transcript entry. */
  loadAround(entryId: string): Promise<void>
  /** Lazily fetch the full diffs/content of a wire-truncated historical
   *  diff-bearing block (tool artifact or review notice) and merge it into
   *  the resident window. Single-flight per block; fire-and-forget. */
  hydrateBlockBody(blockId: string): void
}

/** Which sessions stay resident, and when their tails are read. */
export interface TranscriptResidency {
  /** Retain one mounted transcript surface. Each caller owns an independent,
   * idempotent release handle, so nested viewers cannot evict the foreground
   * or one another when they close. */
  retain(sessionId: string): { release(): void }
  /** Make a session resident, reading its tail if it was not. */
  ensure(sessionId: string): void
  /** Make a session resident and resolve once its first tail read settled
   *  (the whole window for an under-budget session). Idempotent for a
   *  resident session. */
  open(sessionId: string): Promise<void>
  /** Read the tail again even for a resident session. Active sessions use
   *  this to follow newly derived output from the runtime. */
  refresh(sessionId: string): Promise<void>
  /** Publish the known-empty initial window for a session this client just
   * created while its first authoritative tail read remains in flight. */
  startKnownEmpty(sessionId: string): void
  /** Snapshot the bounded set of sessions with resident transcript entries. */
  residentSessionIds(): readonly string[]
  /** Whether the resident window is current on this lane, or its read failed. Reactive. */
  isCurrent(sessionId: string): boolean
}

/** Paging a resident session's window from outside its view: the foreground
 *  pager and background hydration. */
export interface TranscriptPaging {
  /** Page one bounded outputRange toward an edge and splice it in. Concurrent
   *  duplicate loads for the same range coalesce to a single RPC. */
  loadPage(sessionId: string, direction: LoadDirection): Promise<LoadPageResult>
  /** Historical metadata (consistencyToken + totals + window) at the SAME token as
   *  visibleRange(), so spacer math never mixes old blocks with new counts. */
  historyMetadata(sessionId: string): { readonly consistencyToken: string | null; readonly totalBlocks: number; readonly window: TranscriptWindow } | undefined
}

/** Reading any resident session's transcript, and the disclosure intent a
 *  terminal hands to the build that replaces it. */
interface TranscriptReads {
  /** The render boundary's view of whichever session `sessionId` names when
   *  each call runs. While it names no session, reads answer nothing and
   *  writes do nothing, except `reportProjectionFailure`, which still logs
   *  and rethrows the error. */
  bindSession(sessionId: () => string | undefined): OutputTranscriptView
  /** The composed live view (the one block list + its streaming tool text), or
   *  undefined when the session has no resident entry. Reactive. */
  view(sessionId: string): OutputView | undefined
  /** The generation-consistent hydrated window (status + generation + totals +
   *  window + blocks) for the session, or undefined if never opened. Reactive:
   *  tracks the disposable Solid store. */
  visibleRange(sessionId: string): TranscriptSnapshot | undefined
  /** The characters the session's current phase has streamed, or undefined
   *  until its first read lands. Reactive on its own, apart from `view()`:
   *  the count moves several times per second while a session streams, and
   *  only a status line reads it. A hidden resident's count stays current. */
  streamingOutputChars(sessionId: string): number | undefined
  /** Every disclosure intent written for one session, by key. The map is
   *  block-identity-keyed and leaves with its session's eviction. */
  disclosures(sessionId: string): { readonly [key: string]: boolean }
  setDisclosure(sessionId: string, key: string, expanded: boolean): void
}

/** The terminal's transcript residency over the shared client store: one
 *  `TranscriptStore` per resident session, projected into the Solid snapshots
 *  the output window renders. Each caller takes the part for its job. */
export interface OutputTranscriptCache extends TranscriptResidency, TranscriptPaging, TranscriptReads {}

/** The window reflects real transcript state: seeded from a read or live
 *  deltas, not the loading sentinel. */
export function snapshotSeeded(snapshot: TranscriptSnapshot | undefined): boolean {
  const kind = snapshot?.status.kind
  return kind === "complete" || kind === "partial"
}
