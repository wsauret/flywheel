import type { MutationEvidence } from "../../infra/substrate/mutation-evidence.js"
import type { ProvisionalDiff, UserMessageImage } from "../../infra/substrate/events/output-blocks.js"
import type { FrontendOutputBlock, FrontendToolEntry, FrontendToolStreamingText } from "../runtime/app-service-types.js"
import type { RuntimePosition } from "../runtime/runtime-ui-protocol-types.js"

export interface RuntimeTranscriptWindow {
  readonly startBlockIndex: number | null
  readonly endBlockIndex: number | null
  readonly hasBefore: boolean
  readonly hasAfter: boolean
  readonly contentBytes: number
}

export interface TranscriptUnavailable {
  readonly title: string
  readonly message: string
  readonly diagnostic: string
}



export type OutputRangeAnchor =
  | { readonly kind: "tail" }
  | { readonly kind: "beforeBlock"; readonly blockId: string }
  | { readonly kind: "afterBlock"; readonly blockId: string }
  /** The window centred on the block a chat entry produced, named by the
   *  entry id a search hit carries (a tool use id for a tool result); an
   *  entry with no block resolves to the tail, and the served anchor says so. */
  | { readonly kind: "around"; readonly entryId: string }
  /** Exact visible identities, in display order, and nearest prior neighbours
   * to use only when every protected identity has retired. */
  | { readonly kind: "residentSpan"; readonly blockIds: readonly string[]; readonly candidates: readonly string[] }

export interface OutputRangeRequest {
  readonly anchor: OutputRangeAnchor
  readonly maxBlocks: number
  readonly maxBytes: number
  readonly includeThinkingContent?: boolean
}

export interface OutputWindowRequest {
  readonly range: OutputRangeRequest
}

export interface OutputWindowSnapshot {
  readonly snapshotPosition: RuntimePosition
  readonly totalBlocks: number
  readonly visibleMessageCount: number
  readonly range: HydratedOutputRange
}

export interface OutputGroupChildrenCursor {
  readonly groupBlockId: string
  /** Index of the next complete projected child row in this group. */
  readonly childIndex: number
}

export interface OutputGroupChildrenRequest {
  readonly groupBlockIds: readonly string[]
  readonly maxBytes: number
  readonly cursor?: OutputGroupChildrenCursor
}

export interface HydratedOutputGroupChildren {
  readonly groupBlockId: string
  /** Total presentable children across all pages for this group. */
  readonly totalChildren: number
  readonly contentBytes: number
  readonly children: readonly FrontendToolEntry[]
}

export interface HydratedOutputGroupChildrenBatch {
  readonly groups: readonly HydratedOutputGroupChildren[]
  readonly contentBytes: number
  readonly nextCursor?: OutputGroupChildrenCursor
}

export interface OutputBlockBodyRequest {
  readonly blockId: string
}

/** Full body of one derived body-bearing block. Invocation source disclosure is
 * automatic and independent from user-controlled result disclosure. */
export interface HydratedOutputBlockBody {
  readonly blockId: string
  /** A user-message identity retired before this read; refresh the transcript window. */
  readonly missing?: true
  readonly invocationBody?: { readonly content: string; readonly filetype: string; readonly presentation?: "disclosure" }
  readonly diff?: string
  readonly content?: string
  readonly filetype?: string
  /** Bounded evidence summary; read file pages and byte windows through the evidence queries. */
  readonly mutationEvidence?: MutationEvidence
  readonly proposedDiff?: ProvisionalDiff
  /** Saved image bytes, base64, in the user message's attachment order. */
  readonly images?: readonly UserMessageImage[]
}

export type HydratedOutputRange = HydratedOutputRangeOk | OutputRangeUnavailable
interface StreamingToolTextById {
  readonly [toolUseId: string]: FrontendToolStreamingText
}

interface HydratedOutputRangeOk {
  readonly kind: "ok"
  readonly consistencyToken: string
  readonly anchor: OutputRangeAnchor
  readonly window: RuntimeTranscriptWindow
  readonly blocks: readonly FrontendOutputBlock[]
  readonly streamingToolText: StreamingToolTextById
  /** The session's streamed character count as the read served it; zero for
   *  a session no runner holds. */
  readonly streamingOutputChars: number
  /** Exact membership at this range's snapshot, including absent identities.
   * Omission from `blocks` alone never establishes removal. */
  readonly membership?: readonly { readonly blockId: string; readonly index: number | null }[]
}

interface OutputRangeUnavailable {
  readonly kind: "unavailable"
  readonly consistencyToken: null
  readonly anchor: OutputRangeAnchor
  readonly window: RuntimeTranscriptWindow
  readonly unavailable: TranscriptUnavailable
}

/** One place in a transcript where the words a person searched for occur. */
export interface TranscriptSearchHit {
  readonly sessionId: string
  readonly sessionTitle?: string
  /** What the hit names for the `around` anchor: the chat entry, or the tool
   *  use for a tool result, which is the block the transcript lands on. */
  readonly entryId: string
  readonly role: "user" | "assistant" | "tool" | "summary"
  /** The matching words in context, matches bracketed. */
  readonly snippet: string
}

export interface TranscriptSearchRequest {
  readonly query: string
  /** One session, or every session of the project when absent. */
  readonly sessionId?: string
  /** 1-based. */
  readonly page: number
}

export interface TranscriptSearchResult {
  readonly hits: readonly TranscriptSearchHit[]
  readonly total: number
  readonly page: number
  readonly pageSize: number
}

/** A find of every occurrence of a text or a pattern in one session's
 *  transcript, in document order, from `fromBlockIndex` on: 0 finds in the
 *  whole transcript. A client that follows live output keeps its earlier
 *  matches and asks again from the `openFromBlockIndex` of its last result. */
export interface TranscriptFindRequest {
  readonly pattern: string
  readonly regex: boolean
  readonly matchCase: boolean
  /** Thinking blocks are searched only while the client shows them. */
  readonly includeThinking: boolean
  readonly fromBlockIndex: number
}

/** One occurrence: the block that holds it and its ordinal among the
 *  occurrences of that block. */
export interface TranscriptFindMatch {
  readonly blockId: string
  readonly blockIndex: number
  readonly occurrence: number
}

export interface TranscriptFindResult {
  /** The matches of the blocks from the request's `fromBlockIndex` on, at
   *  most `TRANSCRIPT_FIND_LIMIT`. */
  readonly matches: readonly TranscriptFindMatch[]
  /** More matches exist past the last one returned. */
  readonly more: boolean
  /** The first block whose matches can still change: the first block that
   *  is still in flight, or else the last block the find read. Every block
   *  before it is settled. */
  readonly openFromBlockIndex: number
  readonly blockCount: number
}

/** A search for the root chats of the project whose messages best match some keywords. */
export interface ChatSearchRequest {
  readonly query: string
  /** Chats that never rank, such as those a client already shows for the query. */
  readonly exclude: readonly string[]
}

/** One root chat that a chat search found. */
export interface FoundChat {
  readonly sessionId: string
  /** The time of the chat's newest entry, in milliseconds since the epoch. */
  readonly lastActivityAt?: number
  /** The chat entry of the best matching message, for the `around` anchor. */
  readonly entryId: string
  /** The words of the chat's best matching message in context, matches bracketed. */
  readonly snippet: string
  /** The start of the current state of the chat's newest checkpoint, or of its newest final message without one. */
  readonly excerpt?: { readonly source: "checkpoint" | "final"; readonly text: string }
}

export interface ChatSearchResult {
  /** Best first. */
  readonly chats: readonly FoundChat[]
}

/** A person's search for a project file to mention in a message. */
export interface ProjectFilesRequest {
  readonly query: string
  readonly limit: number
}

export interface ProjectFileEntry {
  /** Project-relative, forward slashes, no trailing slash. */
  readonly path: string
  readonly directory: boolean
}

export interface ProjectFilesResult {
  /** Best match first. A bare query lists the project's top level,
   *  directories before files. */
  readonly entries: readonly ProjectFileEntry[]
  readonly total: number
}
