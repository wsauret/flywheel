import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import type { HydratedOutputRange, RuntimeTranscriptWindow, OutputRangeRequest } from "../../../../src/protocol/transcript-protocol-types.js"
import type { SessionPreviewAppService, SessionPreviewReader } from "../../../../src/tui/session-picker/use-session-preview.js"
import { hydrateDerivedOutputRange } from "../../../../src/orchestration/app-service/transcript-queries.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"

const { createRoot, createSignal } = await import("solid-js")
const { useSessionPreview } = await import("../../../../src/tui/session-picker/use-session-preview.js")

const waitForPreviewDebounce = (): Promise<void> => Bun.sleep(1)
const flushMicrotasks = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }

interface PendingRangeCall {
  readonly sessionId: string
  readonly request: OutputRangeRequest
  readonly resolve: (range: HydratedOutputRange) => void
  readonly reject: (error: Error) => void
}

function createFakeAppService() {
  const calls: PendingRangeCall[] = []
  const lanes = fakeLanes()
  const client: SessionPreviewAppService = {
    onLane: lanes.onLane,
    query: ({ sessionId, request }) => {
      let resolveCall: (range: HydratedOutputRange) => void = () => {}
      let rejectCall: (error: Error) => void = () => {}
      const promise = new Promise<HydratedOutputRange>((resolve, reject) => { resolveCall = resolve; rejectCall = reject })
      calls.push({ sessionId, request, resolve: resolveCall, reject: rejectCall })
      return promise
    },
  }

  return {
    client,
    calls,
    lanes,
    settle: (index: number, range: HydratedOutputRange) => {
      const call = calls.at(index)
      if (!call) throw new Error(`missing outputRange call ${index}`)
      call.resolve(range)
    },
  }
}

function textBlock(id: string, content: string): FrontendOutputBlock {
  return { kind: "text", id, content, timestamp: 1 }
}

function windowFor(blocks: readonly FrontendOutputBlock[]): RuntimeTranscriptWindow {
  return {
    startBlockIndex: blocks.length > 0 ? 0 : null,
    endBlockIndex: blocks.length > 0 ? blocks.length - 1 : null,
    hasBefore: false,
    hasAfter: false,
    contentBytes: blocks.reduce((total, block) => total + blockContent(block).length, 0),
  }
}

function rangeOk(blocks: readonly FrontendOutputBlock[]): Extract<HydratedOutputRange, { kind: "ok" }> {
  return {
    kind: "ok",
    consistencyToken: "test:v1",
    anchor: { kind: "tail" },
    window: windowFor(blocks),
    blocks,
    streamingToolText: {}, streamingOutputChars: 0,
  }
}

function rangeUnavailable(): HydratedOutputRange {
  return {
    kind: "unavailable",
    consistencyToken: null,
    anchor: { kind: "tail" },
    window: windowFor([]),
    unavailable: {
      title: "Unavailable",
      message: "Preview unavailable",
      diagnostic: "missing snapshot",
    },
  }
}

function blockContent(block: FrontendOutputBlock): string {
  return block.kind === "text" || block.kind === "userMessage" || block.kind === "thinking" ? block.content : ""
}

describe("useSessionPreview", () => {
  it("debounces rapid selection changes and fetches only the last selection", async () => {
    await createRoot(async (dispose) => {
      const [selected, setSelected] = createSignal<string | undefined>("a")
      const fake = createFakeAppService()
      const preview = useSessionPreview(selected, () => 6, fake.client, 0)

      await flushMicrotasks()
      expect(preview().status).toBe("loading")
      setSelected("b")
      await flushMicrotasks()
      await waitForPreviewDebounce()

      expect(fake.calls).toHaveLength(1)
      const call = fake.calls.at(0)
      if (!call) throw new Error("missing outputRange call")
      expect(call.sessionId).toBe("b")
      expect(call.request).toMatchObject({ anchor: { kind: "tail" }, maxBlocks: 6 })
      expect(fake.lanes.listeners).toBe(1)
      dispose()
    })
  })

  it("discards a slow earlier response after a newer selection is scheduled", async () => {
    await createRoot(async (dispose) => {
      const [selected, setSelected] = createSignal<string | undefined>("a")
      const fake = createFakeAppService()
      const preview = useSessionPreview(selected, () => 4, fake.client, 0)

      await flushMicrotasks()
      await waitForPreviewDebounce()
      expect(fake.calls).toHaveLength(1)

      setSelected("b")
      await flushMicrotasks()
      await waitForPreviewDebounce()
      expect(fake.calls).toHaveLength(2)

      fake.settle(1, rangeOk([textBlock("b", "new")]))
      await flushMicrotasks()
      fake.settle(0, rangeOk([textBlock("a", "old")]))
      await flushMicrotasks()

      expect(preview().status).toBe("ready")
      expect(preview().sessionId).toBe("b")
      expect(preview().blocks.map(blockContent)).toEqual(["new"])
      dispose()
    })
  })

  it("clears the previous subject while the next selection is loading", async () => {
    await createRoot(async (dispose) => {
      const [selected, setSelected] = createSignal<string | undefined>("a")
      const fake = createFakeAppService()
      const preview = useSessionPreview(selected, () => 4, fake.client, 0)

      await flushMicrotasks()
      await waitForPreviewDebounce()
      fake.settle(0, rangeOk([textBlock("a", "old")]))
      await flushMicrotasks()
      expect(preview().status).toBe("ready")
      expect(preview().blocks.map(blockContent)).toEqual(["old"])

      setSelected("b")
      await flushMicrotasks()

      expect(preview().status).toBe("loading")
      expect(preview().sessionId).toBe("b")
      expect(preview().blocks).toEqual([])
      dispose()
    })
  })

  it("reads once per lane, never for geometry or equal-id catalog replacements, and holds failed recovery", async () => {
    await createRoot(async (dispose) => {
      const [selected, setSelected] = createSignal({ id: "a" })
      const [height, setHeight] = createSignal(4)
      const fake = createFakeAppService()
      const preview = useSessionPreview(() => selected().id, height, fake.client, 0)
      await flushMicrotasks()
      await waitForPreviewDebounce()
      const streamingToolText = { running: { content: "held process output" } }
      fake.settle(0, { ...rangeOk([textBlock("a", "held")]), streamingToolText })
      await flushMicrotasks()
      setHeight(20)
      setSelected({ id: "a" })
      await waitForPreviewDebounce()
      expect(fake.calls).toHaveLength(1)
      expect(preview().status).toBe("ready")

      fake.lanes.open()
      expect(preview().blocks.map(blockContent)).toEqual(["held"])
      expect(preview().streamingToolText).toEqual(streamingToolText)
      await waitForPreviewDebounce()
      fake.calls.at(1)?.reject(new Error("lane failed"))
      await flushMicrotasks()
      expect(preview().status).toBe("unavailable")
      expect(preview().blocks.map(blockContent)).toEqual(["held"])
      expect(preview().streamingToolText).toEqual(streamingToolText)
      fake.lanes.open()
      await waitForPreviewDebounce()
      fake.settle(2, rangeUnavailable())
      await flushMicrotasks()
      expect(preview().blocks.map(blockContent)).toEqual(["held"])
      expect(preview().streamingToolText).toEqual(streamingToolText)
      dispose()
      expect(fake.lanes.listeners).toBe(0)
    })
  })

  it("waits for a lane when selection changes while detached and ignores a disposed response", async () => {
    await createRoot(async (dispose) => {
      const fake = createFakeAppService()
      const [selected, setSelected] = createSignal("a")
      const preview = useSessionPreview(selected, () => 4, fake.client, 0)
      await flushMicrotasks()
      await waitForPreviewDebounce()
      expect(fake.calls).toHaveLength(1)
      fake.lanes.end()
      setSelected("b")
      await flushMicrotasks()
      await waitForPreviewDebounce()
      expect(fake.calls).toHaveLength(1)
      fake.lanes.open()
      await waitForPreviewDebounce()
      expect(fake.calls).toHaveLength(2)
      expect(fake.calls[1]?.sessionId).toBe("b")
      dispose()
      fake.settle(1, rangeOk([textBlock("late", "disposed")]))
      await flushMicrotasks()
      expect(preview().blocks).toEqual([])
    })
  })

  it("recovers the exact resident identities instead of replacing them with a disjoint new tail", async () => {
    await createRoot(async (dispose) => {
      const fake = createFakeAppService()
      const preview = useSessionPreview(() => "a", () => 2, fake.client, 0)
      await flushMicrotasks()
      await waitForPreviewDebounce()
      const held = [textBlock("old-1", "reading"), textBlock("old-2", "place")]
      fake.settle(0, rangeOk(held))
      await flushMicrotasks()
      fake.lanes.open()
      await waitForPreviewDebounce()
      const call = fake.calls.at(1)
      if (!call) throw new Error("missing recovery")
      expect(call.request.anchor).toEqual({ kind: "residentSpan", blockIds: ["text:old-1", "text:old-2"], candidates: [] })
      const anchor = call.request.anchor
      if (anchor.kind !== "residentSpan") throw new Error("expected protected read")
      fake.settle(1, {
        ...rangeOk(held), anchor,
        window: { ...windowFor(held), startBlockIndex: 100, endBlockIndex: 101, hasAfter: true },
        membership: anchor.blockIds.map((blockId, i) => ({ blockId, index: 100 + i })),
      })
      await flushMicrotasks()
      expect(preview().status).toBe("ready")
      expect(preview().blocks.map(blockContent)).toEqual(["reading", "place"])
      dispose()
    })
  })

  it("holds the current reading when the reader moves outside a pending recovery", async () => {
    await createRoot(async (dispose) => {
      const fake = createFakeAppService()
      const [reader, setReader] = createSignal<SessionPreviewReader>()
      const preview = useSessionPreview(() => "subject", () => 1, fake.client, 0, reader)
      await flushMicrotasks()
      await waitForPreviewDebounce()
      const held = [textBlock("a", "first reading"), textBlock("b", "current reading")]
      fake.settle(0, rangeOk(held))
      await flushMicrotasks()
      setReader({ kind: "residentSpan", blockIds: ["text:a"], candidates: [] })
      fake.lanes.open()
      await waitForPreviewDebounce()
      const call = fake.calls[1]
      if (!call) throw new Error("missing recovery")
      expect(call.request.anchor).toEqual({ kind: "residentSpan", blockIds: ["text:a"], candidates: [] })
      setReader({ kind: "residentSpan", blockIds: ["text:b"], candidates: [] })
      const recovered = await hydrateDerivedOutputRange({ ...indexOutputBlocks(held), consistencyToken: "v1" }, call.request)
      if (recovered.kind !== "ok") throw new Error("expected recovered history")
      expect(recovered.blocks.map(blockContent)).toEqual(["first reading"])
      fake.settle(1, recovered)
      await flushMicrotasks()
      expect(preview().blocks).toBe(held)
      expect(preview().status).toBe("unavailable")
      expect(fake.calls).toHaveLength(2)
      dispose()
    })
  })

  it("maps unavailable output and empty ok ranges to preview states", async () => {
    await createRoot(async (dispose) => {
      const [selected, setSelected] = createSignal<string | undefined>("a")
      const fake = createFakeAppService()
      const preview = useSessionPreview(selected, () => 4, fake.client, 0)

      await flushMicrotasks()
      await waitForPreviewDebounce()
      fake.settle(0, rangeUnavailable())
      await flushMicrotasks()
      expect(preview().status).toBe("unavailable")
      expect(preview().blocks).toEqual([])

      setSelected("b")
      await flushMicrotasks()
      await waitForPreviewDebounce()
      fake.settle(1, rangeOk([]))
      await flushMicrotasks()

      expect(preview().status).toBe("ready")
      expect(preview().sessionId).toBe("b")
      expect(preview().blocks).toEqual([])
      dispose()
    })
  })
})
