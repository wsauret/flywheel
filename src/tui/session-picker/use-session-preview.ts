import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import type { AttachedRuntimeClient, FrontendOutputBlock, FrontendToolStreamingText } from "../../protocol/app-service-types.js"
import type { HydratedOutputRange, OutputRangeRequest, TranscriptUnavailable, OutputRangeAnchor } from "../../protocol/transcript-protocol-types.js"
import { blockIdentity } from "../../protocol/block-identity.js"
import { coversResidentSpan } from "../../protocol/client/transcript-store-paging.js"

const PREVIEW_DEBOUNCE_MS = 150
const PREVIEW_MAX_BYTES = 256 * 1024
interface PreviewStreamingToolText {
  [toolUseId: string]: FrontendToolStreamingText
}

const EMPTY_STREAMING_TOOL_TEXT: Readonly<PreviewStreamingToolText> = {}

type SessionPreviewStatus = "idle" | "loading" | "ready" | "unavailable"
export type SessionPreviewAppService = Pick<AttachedRuntimeClient, "onLane"> & {
  readonly query: (query: { readonly type: "outputRange"; readonly sessionId: string; readonly request: OutputRangeRequest }) => Promise<HydratedOutputRange>
}
export type SessionPreviewReader = Extract<OutputRangeAnchor, { kind: "residentSpan" }>

export interface SessionPreviewState {
  readonly status: SessionPreviewStatus
  readonly sessionId?: string
  readonly blocks: readonly FrontendOutputBlock[]
  readonly streamingToolText: Readonly<PreviewStreamingToolText>
  readonly unavailable?: TranscriptUnavailable
}

export function useSessionPreview(
  selectedId: Accessor<string | undefined>,
  paneHeight: Accessor<number>,
  appService: SessionPreviewAppService,
  debounceMs = PREVIEW_DEBOUNCE_MS,
  reader?: Accessor<SessionPreviewReader | undefined>,
): Accessor<SessionPreviewState> {
  const [preview, setPreview] = createSignal<SessionPreviewState>({ status: "idle", blocks: [], streamingToolText: EMPTY_STREAMING_TOOL_TEXT })
  let token = 0
  const subject = createMemo(selectedId)

  createEffect(on(subject, (sessionId) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    setPreview({ status: sessionId ? "loading" : "idle", sessionId, blocks: [], streamingToolText: EMPTY_STREAMING_TOOL_TEXT })

    onCleanup(() => {
      if (timer) clearTimeout(timer)
      token += 1
    })
    if (!sessionId) return

    onCleanup(appService.onLane(() => untrack(() => {
      const requestToken = ++token
      if (timer) clearTimeout(timer)
      setPreview(current => ({ ...current, status: "loading", unavailable: undefined }))
      timer = setTimeout(() => {
        timer = undefined
        const current = untrack(preview)
        const anchor: OutputRangeAnchor = current.blocks.length === 0 ? { kind: "tail" }
          : untrack(() => reader?.()) ?? { kind: "residentSpan", blockIds: current.blocks.map(blockIdentity), candidates: [] }
        const request = { anchor, maxBlocks: previewRows(untrack(paneHeight)), maxBytes: PREVIEW_MAX_BYTES }
        void appService.query({ type: "outputRange", sessionId, request }).then((range) => {
          if (token !== requestToken) return
          const currentAnchor = anchor.kind === "residentSpan" ? untrack(() => reader?.()) ?? anchor : anchor
          if (range.kind === "unavailable" || (currentAnchor.kind === "residentSpan" && !coversResidentSpan(range, currentAnchor))) {
            setPreview(held => ({ ...held, status: "unavailable", unavailable: range.kind === "unavailable" ? range.unavailable : undefined }))
            return
          }
          setPreview({ status: "ready", sessionId, blocks: range.blocks, streamingToolText: range.streamingToolText })
        }).catch(() => {
          if (token !== requestToken) return
          setPreview(held => ({ ...held, status: "unavailable" }))
        })
      }, debounceMs)
    })))
  }))

  return preview
}

function previewRows(height: number): number {
  return Math.max(1, Math.floor(Number.isFinite(height) ? height : 1))
}
