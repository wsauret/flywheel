import type { FrontendOutputBlock, FrontendToolEntry, FrontendToolStreamingText } from "../app-service-types.js"
import type { HydratedOutputBlockBody } from "../transcript-protocol-types.js"
import type { RuntimePosition } from "../runtime-ui-protocol-types.js"

/** The transcript contract a client reads: the resident window the store
 *  publishes, the slots a delta rewrote, and the reader position the client
 *  reports back. The store and its paging, evidence, and render helpers all
 *  share it, so it sits below them. */

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

export interface TranscriptReader {
  readonly following: boolean
  readonly blockIds: readonly string[]
}
