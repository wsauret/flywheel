import type { FrontendEvent, FrontendOutputBlock, FrontendToolEntry, FrontendToolStreamingText } from "../../../../src/protocol/app-service-types.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import type { RuntimeUiPatch } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import type { RuntimeConnection } from "../../../../src/protocol/client/connection.js"
import type { HydratedOutputBlockBody, HydratedOutputGroupChildrenBatch, OutputGroupChildrenCursor, OutputRangeAnchor, TranscriptUnavailable } from "../../../../src/protocol/transcript-protocol-types.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

export const SESSION = "s1"

export function textBlock(id: string, content = id): FrontendOutputBlock {
  return { kind: "text", id, content, timestamp: 0 }
}

export const blocks = (start: number, count: number) => Array.from({ length: count }, (_, i) => textBlock(`b${start + i}`))

export function toolBlock(status: "streaming" | "completed", content?: string): FrontendToolEntry {
  return {
    kind: "tool", id: "call-1", name: "bash",
    presentation: { name: "Bash", detail: "printf output" },
    timestamp: 0, status, ...(content === undefined ? {} : { content }),
  }
}

type RangeSpec = { blocks: FrontendOutputBlock[]; startBlockIndex: number; hasBefore?: boolean; hasAfter?: boolean }
export interface WindowSpec {
  blocks: FrontendOutputBlock[]
  startBlockIndex: number
  totalBlocks: number
  visibleMessageCount?: number
  hasBefore?: boolean
  hasAfter?: boolean
  snapshotPosition?: number
  streamingToolText?: { readonly [toolUseId: string]: FrontendToolStreamingText }
  streamingOutputChars?: number
  membership?: readonly { readonly blockId: string; readonly index: number | null }[]
  unavailable?: TranscriptUnavailable
}

/** Scripted reads and a synchronous event lane expose reads racing live deltas. */
export function fakeConnection(script: {
  windows?: Array<WindowSpec | Promise<WindowSpec>>
  ranges?: Array<RangeSpec | Promise<RangeSpec>>
  body?: HydratedOutputBlockBody | ((blockId: string) => Promise<HydratedOutputBlockBody>)
  group?: (groupBlockIds: readonly string[]) => Promise<HydratedOutputGroupChildrenBatch>
  /** Whether the first lane is open when the store is made. */
  laneOpen?: boolean
  /** Failures the first window reads reject with, in order, before the
   *  scripted windows answer. */
  windowFailures?: unknown[]
}) {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const lanes = fakeLanes({ open: script.laneOpen ?? true })
  const anchors: string[] = []
  const windowAnchors: unknown[] = []
  const groupCursors: Array<OutputGroupChildrenCursor | undefined> = []
  let windowCalls = 0
  let rangeCalls = 0
  // The watches and reads in the order the store made them.
  const calls: string[] = []
  const query = runtimeQuery({
    outputBlockBody: async (read) => {
      if (script.body === undefined) throw new Error("no body scripted")
      return typeof script.body === "function" ? await script.body(read.request.blockId) : script.body
    },
    outputGroupChildren: async (read) => {
      groupCursors.push(read.request.cursor)
      if (script.group === undefined) throw new Error("no group scripted")
      return await script.group(read.request.groupBlockIds)
    },
    outputWindow: async (read) => {
      calls.push("read outputWindow")
      const failure = script.windowFailures?.shift()
      if (failure !== undefined) { windowCalls += 1; throw failure }
      const spec = await script.windows?.[Math.min(windowCalls++, (script.windows?.length ?? 1) - 1)]
      if (!spec) throw new Error("no window scripted")
      // The served anchor is the requested one, as the runtime echoes it,
      // unless the script says the window is the tail.
      const requested = read.request.range.anchor
      windowAnchors.push(requested)
      const anchor: OutputRangeAnchor = requested.kind === "residentSpan" || requested.kind === "around" && spec.hasAfter ? requested : { kind: "tail" }
      if (spec.unavailable) return {
        snapshotPosition: spec.snapshotPosition ?? 100, totalBlocks: spec.totalBlocks, visibleMessageCount: 0,
        range: { kind: "unavailable", consistencyToken: null, anchor, unavailable: spec.unavailable,
          window: { startBlockIndex: null, endBlockIndex: null, hasBefore: false, hasAfter: false, contentBytes: 0 } },
      }
      return {
        snapshotPosition: spec.snapshotPosition ?? 100,
        totalBlocks: spec.totalBlocks,
        visibleMessageCount: spec.visibleMessageCount ?? spec.totalBlocks,
        range: {
          kind: "ok", consistencyToken: "t", anchor,
          window: {
            startBlockIndex: spec.startBlockIndex,
            endBlockIndex: spec.startBlockIndex + spec.blocks.length - 1,
            hasBefore: spec.hasBefore ?? false, hasAfter: spec.hasAfter ?? false, contentBytes: 0,
          },
          blocks: spec.blocks, streamingToolText: spec.streamingToolText ?? {}, streamingOutputChars: spec.streamingOutputChars ?? 0,
          ...(spec.membership === undefined ? {} : { membership: spec.membership }),
        },
      }
    },
    outputRange: async (read) => {
      const response = script.ranges?.[rangeCalls++]
      const requested = read.request.anchor
      anchors.push("blockId" in requested ? requested.blockId : "(none)")
      const spec = await response
      if (!spec) throw new Error("no range scripted")
      return {
        kind: "ok", consistencyToken: "t", anchor: { kind: "beforeBlock", blockId: "x" },
        window: {
          startBlockIndex: spec.startBlockIndex,
          endBlockIndex: spec.startBlockIndex + spec.blocks.length - 1,
          hasBefore: spec.hasBefore ?? false, hasAfter: spec.hasAfter ?? true, contentBytes: 0,
        },
        blocks: spec.blocks, streamingToolText: {}, streamingOutputChars: 0,
      }
    },
  })
  const connection: Pick<RuntimeConnection, "query" | "subscribe" | "onLane" | "watchOutput"> = {
    watchOutput(sessionId: string) {
      calls.push(`watch ${sessionId}`)
      const release = lanes.watchOutput(sessionId)
      return () => {
        calls.push(`release ${sessionId}`)
        release()
      }
    },
    query,
    subscribe(listener: (event: FrontendEvent) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onLane: lanes.onLane,
  }
  const emit = (event: FrontendEvent) => { for (const listener of listeners) listener(event) }
  return {
    connection,
    emit,
    /** Publishes as the runtime does: an output delta reaches the
     *  connection only while a receiver watches its session. */
    publish(event: FrontendEvent) {
      const { patch } = event.type === "patch" ? event : { patch: undefined }
      if (patch?.payload.kind === "output.delta" && patch.cursor.scope === "session" && !lanes.watching(patch.cursor.sessionId)) return
      emit(event)
    },
    lanes,
    /** The lane breaks and the next one opens, as a reattach does. */
    reconnect() {
      lanes.end()
      emit(LANE_BREAK)
      lanes.open()
    },
    get windowCalls() { return windowCalls },
    calls,
    anchors,
    windowAnchors,
    groupCursors,
  }
}

export function deltaPatch(position: number, prevPosition: number, index: number, block: FrontendOutputBlock): RuntimeUiPatch {
  return {
    cursor: outputCursor(SESSION), position, prevPosition,
    payload: { kind: "output.delta", delta: { visibleMessageCount: index + 1, blocks: [{ kind: "insert", index, blockId: blockIdentity(block), block }] } },
  }
}

export const settle = () => new Promise<void>((resolve) => { setImmediate(resolve) })
