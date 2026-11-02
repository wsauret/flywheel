import type { StreamingToolTextOp, ValueEdit } from "../infra/output/output-block-delta.js"
import type { FrontendOutputBlock, FrontendToolStreamingText } from "./app-service-types.js"
import type { RuntimeSessionCursorIdentity, RuntimeUiPatchPayload } from "./runtime-ui-protocol-types.js"

interface StreamingToolTextById {
  readonly [toolUseId: string]: FrontendToolStreamingText
}
/** The canonical output view held by the transcript store. Live patches are
 *  incremental `OutputDelta`s; bounded `outputWindow`/`outputRange` calls provide
 *  recovery windows. */
export interface OutputView {
  readonly blocks: readonly FrontendOutputBlock[]
  readonly streamingToolText: Readonly<StreamingToolTextById>
}

/** One change to the block at `index`. `edit` changes a block the clients
 *  already hold by the edits from the copy last shipped to the current one; a
 *  client finds the block by `blockId`, because a read can place it ahead of
 *  the published index. */
export type OutputBlockDelta =
  | { readonly kind: "insert"; readonly index: number; readonly blockId: string; readonly block: FrontendOutputBlock }
  | { readonly kind: "upsert"; readonly index: number; readonly blockId: string; readonly block: FrontendOutputBlock }
  | { readonly kind: "edit"; readonly index: number; readonly blockId: string; readonly edits: readonly ValueEdit[] }
  | { readonly kind: "append-content"; readonly index: number; readonly blockId: string; readonly contentOffset: number; readonly text: string }

/** Ordered output changes for one session. `streamingToolTextOps` changes
 *  the live tool-text entries, one tool at a time, by what each gained since
 *  the version last shipped. No delta carries the whole map.
 *  `streamingOutputChars` is present only when the count changed. */
interface StructuralOutputDelta {
  readonly visibleMessageCount: number
  readonly blocks: readonly OutputBlockDelta[]
  readonly truncateTo?: number
  readonly streamingToolTextOps?: readonly StreamingToolTextOp[]
  readonly streamingOutputChars?: number
}

/** A change of streaming state alone, with no block coordinates: streaming
 *  tool text, the streamed character count, or both. */
export type OutputDelta = StructuralOutputDelta | ({
  readonly blocks: readonly never[]
  readonly visibleMessageCount?: never
  readonly truncateTo?: never
} & (
  | { readonly streamingToolTextOps: readonly StreamingToolTextOp[]; readonly streamingOutputChars?: number }
  | { readonly streamingToolTextOps?: never; readonly streamingOutputChars: number }
))

/** The output payloads, ordered against the app-service `output` cursor. */
export type OutputPatchPayload = { readonly kind: "output.delta"; readonly delta: OutputDelta }
/** The `output` cursor identity for one session. Both the publisher (mint side)
 *  and the TUI cache (classify side) name the stream through this, so neither
 *  can mistype the domain string the classifier checks identity against. */
export function outputCursor(sessionId: string): RuntimeSessionCursorIdentity & { readonly domain: "output" } {
  return { scope: "session", domain: "output", sessionId }
}

/** Narrow a protocol payload to the output domain. The single broadcast path
 *  fans every patch to every listener; the live output projector applies only
 *  its own domain and ignores the rest, exactly as the session cache does. */
export function isOutputPayload(payload: RuntimeUiPatchPayload): payload is OutputPatchPayload {
  return payload.kind === "output.delta"
}
