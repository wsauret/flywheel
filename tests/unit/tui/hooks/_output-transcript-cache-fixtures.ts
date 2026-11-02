import type { AttachedRuntimeClient, FrontendEvent, FrontendOutputBlock, FrontendToolEntry } from "../../../../src/protocol/app-service-types.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { threadHistoryRangeIndices } from "../../../../src/orchestration/session/conversation/branch-history-pagination.js"
import type {
  HydratedOutputGroupChildrenBatch,
  HydratedOutputGroupChildren,
  HydratedOutputRange,
  OutputGroupChildrenRequest,
  RuntimeTranscriptWindow,
  OutputRangeRequest,
  OutputWindowRequest,
  OutputWindowSnapshot,
} from "../../../../src/protocol/transcript-protocol-types.js"
import { outputCursor, type OutputDelta, type OutputView } from "../../../../src/protocol/output-protocol-types.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

/** Drain the whole microtask chain behind a recovery (gap -> recoverWindow ->
 *  openTail -> seed -> receiver adopt/replay) by yielding one macrotask. */
export function flushRecovery(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Zero-delay deterministic retry schedule for recovery-failure tests. */
export const INSTANT_BACKOFF = { baseMs: 0, maxMs: 0, factor: 1, random: () => 0 }

export function textBlock(id: string, text: string): FrontendOutputBlock {
  return { kind: "text", id, content: text, timestamp: 1 }
}

export function userMessageBlock(id: string, text: string, pending = false): FrontendOutputBlock {
  return { kind: "userMessage", id, content: text, timestamp: 1, pending, injected: false }
}

export function toolEntry(id: string, path = id): FrontendToolEntry {
  return { kind: "tool", id, name: "read", presentation: { name: "Read", detail: path }, status: "completed", timestamp: 1 }
}

const GEN = "g1"

export function gen(token = GEN): string {
  return token
}

export function window(over: Partial<RuntimeTranscriptWindow> = {}): RuntimeTranscriptWindow {
  return { startBlockIndex: 0, endBlockIndex: 0, hasBefore: false, hasAfter: false, contentBytes: 17, ...over }
}

export function rangeOk(blocks: FrontendOutputBlock[], over: Partial<RuntimeTranscriptWindow> = {}, consistencyToken = gen()): Extract<HydratedOutputRange, { readonly kind: "ok" }> {
  return {
    kind: "ok",
    consistencyToken,
    anchor: { kind: "tail" },
    window: window(over),
    blocks,
    streamingToolText: {}, streamingOutputChars: 0,
  }
}

export function rangeUnavailable(): HydratedOutputRange {
  return {
    kind: "unavailable",
    consistencyToken: null,
    anchor: { kind: "tail" },
    window: window({ startBlockIndex: null, endBlockIndex: null, contentBytes: 0 }),
    unavailable: {
      title: "Session output cannot be repaired",
      message: "This session was saved with an older Flywheel output format, and the data needed to rebuild it is no longer available.",
      diagnostic: "raw schema diagnostic",
    },
  }
}

export function windowTotal(_over: Partial<RuntimeTranscriptWindow> = {}, _consistencyToken: string | null = gen(), totalBlocks = 100): number {
  return totalBlocks
}

export function liveView(blocks: FrontendOutputBlock[], streamingToolText: OutputView["streamingToolText"] = {}): OutputView {
  return { blocks, streamingToolText }
}

export function groupChildren(groupBlockId: string, children: FrontendToolEntry[]): HydratedOutputGroupChildren {
  return {
    groupBlockId,
    totalChildren: children.length,
    contentBytes: children.reduce((sum, child) => sum + child.presentation.detail.length + 64, 0),
    children,
  }
}

/** A live OutputView as an ordered delta. `truncate` (default) reseeds the whole
 *  list via `truncateTo: 0`; pass false for an append that continues a held epoch
 *  (the gap-replay tests). */
function liveDelta(v: OutputView, truncate = true): OutputDelta {
  return {
    visibleMessageCount: v.blocks.length,
    blocks: v.blocks.map((block, index) => ({ kind: "upsert", index, blockId: blockIdentity(block), block })),
    ...(truncate ? { truncateTo: 0 } : {}),
    streamingToolTextOps: Object.entries(v.streamingToolText).map(([toolUseId, entry]) => ({ kind: "set" as const, toolUseId, entry })),
  }
}

function outputWindowSnapshot(snapshotPosition: number, blocks: readonly FrontendOutputBlock[], request: OutputWindowRequest): OutputWindowSnapshot {
  // The runtime's own anchor rule, so this double cannot drift from it: a
  // hand-rolled slice once served the head for a vanished after-block anchor
  // where the runtime served nothing, and hid a blank-transcript recovery.
  const indices = new Map(blocks.map((block, index) => [blockIdentity(block), index]))
  const page = threadHistoryRangeIndices({ blockCount: blocks.length, indexOf: (id) => indices.get(id) ?? -1, indexOfEntry: () => -1 }, request.range.anchor, request.range.maxBlocks)
  const selected = page.indices.map((index) => {
    const block = blocks[index]
    if (!block) throw new Error(`Missing fixture block ${index}`)
    return block
  })
  const first = page.indices[0]
  const last = page.indices.at(-1)
  const indexWindow = window({
    startBlockIndex: first ?? null,
    endBlockIndex: last ?? null,
    hasBefore: first !== undefined && first > 0,
    hasAfter: last !== undefined && last < blocks.length - 1,
    contentBytes: selected.reduce((sum, block) => sum + content(block).length + 64, 0),
  })
  return {
    snapshotPosition,
    totalBlocks: blocks.length,
    visibleMessageCount: blocks.length,
    range: {
      kind: "ok",
      consistencyToken: gen(),
      anchor: page.anchor,
      window: indexWindow,
      blocks: selected,
      streamingToolText: {}, streamingOutputChars: 0,
      ...(page.membership === undefined ? {} : { membership: page.membership }),
    },
  }
}

/** The unified app-service stand-in for the single transcript store: deferred
 * total/range responses for pull navigation, plus a real patch sequencer and
 * per-session output window for ordered intake. */
interface InitialOutputBlocks {
  [sessionId: string]: FrontendOutputBlock[]
}

export function fakeRuntimeClient(initial: InitialOutputBlocks = {}) {
  const totalCalls: { settle: (v: number) => void }[] = []
  const rangeCalls: { sessionId: string; request: OutputRangeRequest; settle: (v: HydratedOutputRange) => void }[] = []
  const groupChildrenCalls: { sessionId: string; request: OutputGroupChildrenRequest; settle: (v: HydratedOutputGroupChildrenBatch) => void }[] = []
  const sequencer = createRuntimeUiPatchSequencer()
  const details = new Map(Object.entries(initial))
  let listener: ((event: FrontendEvent) => void) | null = null
  let lastPatch: (FrontendEvent & { type: "patch" }) | null = null
  let outputWindowCalls = 0
  const outputWindowRequests: { sessionId: string; request: OutputWindowRequest }[] = []
  let failOutputWindowTimes = 0

  const query = runtimeQuery({
    outputRange: (queryRequest) => {
      const d = deferred<HydratedOutputRange>()
      rangeCalls.push({ sessionId: queryRequest.sessionId, request: queryRequest.request, settle: d.resolve })
      return d.promise
    },
    outputGroupChildren: (queryRequest) => {
      const d = deferred<HydratedOutputGroupChildrenBatch>()
      groupChildrenCalls.push({ sessionId: queryRequest.sessionId, request: queryRequest.request, settle: d.resolve })
      return d.promise
    },
    outputWindow: async (queryRequest): Promise<OutputWindowSnapshot> => {
        outputWindowCalls += 1
        outputWindowRequests.push({ sessionId: queryRequest.sessionId, request: queryRequest.request })
        const snapshotPosition = sequencer.snapshotPosition({ kind: "cursor", cursor: outputCursor(queryRequest.sessionId) })
        if (failOutputWindowTimes > 0) {
          failOutputWindowTimes -= 1
          await Promise.resolve()
          throw new Error("outputWindow failed")
        }
        const blocks = details.get(queryRequest.sessionId)
        if (blocks !== undefined) return outputWindowSnapshot(snapshotPosition, blocks, queryRequest.request)
        const total = deferred<number>()
        totalCalls.push({ settle: total.resolve })
        const range = client.query({ type: "outputRange", sessionId: queryRequest.sessionId, request: queryRequest.request.range })
        const totalBlocks = await total.promise
        return { snapshotPosition, totalBlocks, visibleMessageCount: totalBlocks, range: await range }
    },
  })
  const lanes = fakeLanes()
  const client: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane" | "watchOutput"> = {
    query,
    subscribe: (l: (event: FrontendEvent) => void) => {
      listener = l
      return () => { listener = null }
    },
    ...lanes.client,
  }

  return {
    client,
    totalCalls: () => totalCalls,
    rangeCalls: () => rangeCalls,
    groupChildrenCalls: () => groupChildrenCalls,
    settleTotal: (i: number, v: number) => totalCalls[i]!.settle(v),
    settleRange: (i: number, v: HydratedOutputRange) => rangeCalls[i]!.settle(v),
    settleGroupChildren: (i: number, v: HydratedOutputGroupChildrenBatch) => groupChildrenCalls[i]!.settle(v),
    setOutputWindow: (sessionId: string, blocks: FrontendOutputBlock[]) => { details.set(sessionId, blocks) },
    outputWindowCalls: () => outputWindowCalls,
    outputWindowRequests: () => outputWindowRequests,
    failOutputWindow: (times = 1) => { failOutputWindowTimes = times },
    // Item 20: the intake only accepts deltas for a session this client actually
    // opened -- production always runs `.open()` to completion well before a
    // runner's first live delta can arrive (the foreground-mount effect calls
    // it before dispatch, and an LLM round-trip vastly outlasts an effect
    // flush). Awaiting the open before publishing reproduces that ordering
    // instead of racing the two -- a fire-and-forget open can resolve AFTER
    // the delta applies and clobber fresher content with a stale bootstrap
    // snapshot. The bootstrap open resolves via a synchronous empty window
    // (a brand-new session's durable state) rather than the deferred
    // index/range calls; if the caller hadn't already seeded `details`, it's
    // removed again once the open settles, so a LATER recovery for the same
    // session still exercises the deferred, manually-settled path callers
    // rely on for gap/refresh racing tests.
    live: async (cache: { open(id: string): Promise<void> }, sessionId: string, v: OutputView) => {
      const hadDetails = details.has(sessionId)
      if (!hadDetails) details.set(sessionId, [])
      await cache.open(sessionId)
      if (!hadDetails) details.delete(sessionId)
      lastPatch = { type: "patch", patch: sequencer.publish({ cursor: outputCursor(sessionId), payload: { kind: "output.delta", delta: liveDelta(v) } }) }
      listener?.(lastPatch)
    },
    liveDelta: (sessionId: string, d: OutputDelta) => {
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: outputCursor(sessionId), payload: { kind: "output.delta", delta: d } }) })
    },
    redeliverLastPatch: () => { if (lastPatch) listener?.(lastPatch) },
    /** Publish a runtime.invalidate on the session's output cursor (rebase by
     *  default: the server announced a new absolute coordinate baseline). */
    invalidate: (sessionId: string, reason: "overflow" | "rebase" = "rebase") => {
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: outputCursor(sessionId), payload: { kind: "runtime.invalidate", reason } }) })
    },
    invalidateAll: () => {
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: { scope: "workspace", domain: "runtime" }, payload: { kind: "runtime.invalidate", reason: "overflow" } }) })
    },
    /** Publish a delta skipping a position, forcing a gap on the receiver. */
    skipThenLive: (sessionId: string, v: OutputView) => {
      sequencer.publish({ cursor: outputCursor(sessionId), payload: { kind: "output.delta", delta: liveDelta(liveView([])) } })
      listener?.({ type: "patch", patch: sequencer.publish({ cursor: outputCursor(sessionId), payload: { kind: "output.delta", delta: liveDelta(v, false) } }) })
    },
    /** Mint two gap deltas (each skipping a position) BEFORE delivering either, so
     *  both reference the same held epoch. Deliver gap1 then gap2. */
    skipTwiceFromHeld: (sessionId: string, v1: OutputView, v2: OutputView) => {
      const cursor = outputCursor(sessionId)
      sequencer.publish({ cursor, payload: { kind: "output.delta", delta: liveDelta(liveView([])) } })
      const gap1 = sequencer.publish({ cursor, payload: { kind: "output.delta", delta: liveDelta(v1, false) } })
      sequencer.publish({ cursor, payload: { kind: "output.delta", delta: liveDelta(liveView([])) } })
      const gap2 = sequencer.publish({ cursor, payload: { kind: "output.delta", delta: liveDelta(v2, false) } })
      listener?.({ type: "patch", patch: gap1 })
      listener?.({ type: "patch", patch: gap2 })
    },
    reconnect: () => {
      lanes.end()
      listener?.(LANE_BREAK)
      lanes.open()
    },
    /** Deliver append-content deltas for one session in a single burst, the
     *  streaming shape that trips the pending-patch-count overflow cap. */
    burstAppend: (sessionId: string, count: number, blockId: string) => {
      for (let i = 0; i < count; i++) {
        listener?.({
          type: "patch",
          patch: sequencer.publish({
            cursor: outputCursor(sessionId),
            payload: { kind: "output.delta", delta: { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId, contentOffset: i, text: "x" }] } },
          }),
        })
      }
    },
  }
}

export function content(block: FrontendOutputBlock | undefined): string {
  return block?.kind === "text" || block?.kind === "userMessage" ? block.content : ""
}

/** The common preamble: open a session and settle its tail index + tail range to
 *  a single block (b99) with older history still available. Used by most tests
 *  that need a `partial` session before exercising paging/staleness. */
export async function seedTail(cache: { open(id: string): Promise<void> }, fake: ReturnType<typeof fakeRuntimeClient>, id: string): Promise<void> {
  const opening = cache.open(id)
  fake.settleTotal(fake.totalCalls().length - 1, windowTotal({ startBlockIndex: 99, hasBefore: true }))
  await Promise.resolve()
  fake.settleRange(fake.rangeCalls().length - 1, rangeOk([textBlock("b99", "tail")], { startBlockIndex: 99, hasBefore: true }))
  await opening
}

/** Open a session to a single `complete` block (no older, no newer): the fully
 *  loaded transcript the eviction/pin tests reopen across sessions. */
export async function seedComplete(cache: { open(id: string): Promise<void> }, fake: ReturnType<typeof fakeRuntimeClient>, id: string): Promise<void> {
  const opening = cache.open(id)
  fake.settleTotal(fake.totalCalls().length - 1, windowTotal({ hasBefore: false, hasAfter: false }, gen(), 1))
  await Promise.resolve()
  fake.settleRange(fake.rangeCalls().length - 1, rangeOk([textBlock("b0", id)], { hasBefore: false, hasAfter: false }))
  await opening
}

/** Count findIndex scans on Array.prototype during a span, to prove the live intake
 *  resolves an append target via its blockId->index map rather than an O(n) scan. */
export function countFindIndexScans() {
  const original = Array.prototype.findIndex
  let count = 0
  Array.prototype.findIndex = function (this: unknown[], ...args: Parameters<typeof original>) {
    count += 1
    return original.apply(this, args)
  }
  return { stop: () => { Array.prototype.findIndex = original; return count } }
}
