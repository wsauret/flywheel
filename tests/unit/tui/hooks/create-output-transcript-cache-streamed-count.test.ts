import { describe, expect, it } from "bun:test"
import { createEffect, createMemo, createRoot } from "solid-js"
import { createOutputTranscriptCache } from "../../../../src/tui/transcript-store/create-output-transcript-cache.js"
import type { StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { createSpinnerStatus, type SpinnerStatusSource } from "../../../../src/tui/hooks/create-spinner-status.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { content, fakeRuntimeClient, flushRecovery, liveView, rangeOk, textBlock } from "./_output-transcript-cache-fixtures.js"

const run = (scenario: (dispose: () => void) => Promise<void>): Promise<void> => createRoot(async (dispose) => { try { await scenario(dispose) } finally { dispose() } })

// The streamed character count reaches only the spinner, through its own
// accessor: it stays unknown until a read lands, and a hidden resident keeps it
// current while its blocks wait.
describe("createOutputTranscriptCache streamed character count", () => {
  it("keeps a hidden resident's streamed count current apart from its deferred view", async () => {
    await run(async () => {
      let clock = 1000
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => clock })
      expect(cache.streamingOutputChars("s1")).toBeUndefined()
      const shown = cache.retain("s1")
      await fake.live(cache, "s1", liveView([textBlock("a", "he")]))
      shown.release()
      let viewRuns = 0
      const viewed = createMemo(() => { viewRuns++; return cache.view("s1") })
      createEffect(() => { viewed() })
      await Promise.resolve()
      const runsBefore = viewRuns
      clock += 100
      fake.liveDelta("s1", { blocks: [], streamingOutputChars: 40 })
      expect(cache.streamingOutputChars("s1")).toBe(40)
      fake.liveDelta("s1", { visibleMessageCount: 1, blocks: [{ kind: "append-content", index: 0, blockId: "text:a", contentOffset: 2, text: "llo" }], streamingOutputChars: 43 })
      expect(cache.streamingOutputChars("s1")).toBe(43)
      expect(cache.visibleRange("s1")!.blocks.map(content)).toEqual(["he"])
      expect(viewRuns).toBe(runsBefore)
      cache.retain("s1")
      expect(cache.visibleRange("s1")!.blocks.map(content)).toEqual(["hello"])
    })
  })

  it("keeps the streamed count unknown while a session opened before its lane loads, so the spinner seeds the full count", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const lanes = fakeLanes({ open: false })
      const cache = createOutputTranscriptCache({ appService: { ...fake.client, ...lanes.client } })
      const status: StatusView = {
        activity: "generating", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected",
        activeSubagentCount: 0, waitingOnBackgroundWork: false, replyWaits: [], activeBackgroundCommands: [],
        activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null,
      }
      const source: SpinnerStatusSource = {
        status: () => status,
        streamingOutputChars: () => cache.streamingOutputChars("s1"),
        sessionId: () => "s1",
        agentState: () => "active",
        waitingOnBackgroundWork: () => false,
        parentSessionId: () => undefined,
        compactionStartedAt: () => null,
        notice: () => null,
      }
      const spinner = createSpinnerStatus({ source, terminalWidth: () => 120, tick: () => 0 })
      cache.retain("s1")
      const opening = cache.open("s1")
      await Promise.resolve()
      expect(cache.visibleRange("s1")?.status.kind).toBe("loading")
      expect(cache.streamingOutputChars("s1")).toBeUndefined()
      lanes.open()
      const tail = { ...rangeOk([textBlock("b0", "hi")]), streamingOutputChars: 4_000 }
      // The open and the lane opening each start a read. The count stays
      // unknown until the store adopts a window.
      for (let read = 0; read < 2; read++) {
        await flushRecovery()
        fake.settleTotal(read, 1)
        await Promise.resolve()
        expect(cache.streamingOutputChars("s1")).toBeUndefined()
        fake.settleRange(read, tail)
      }
      await opening
      await Promise.resolve()
      expect(cache.streamingOutputChars("s1")).toBe(4_000)
      expect(spinner.status()!.segments.map((segment) => segment.text)).toContain("↓ 1.0k tokens")
    })
  })

  it("publishes a known-empty count of 0 once its read lands", async () => {
    await run(async () => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client })
      const opening = cache.open("s1")
      expect(cache.streamingOutputChars("s1")).toBeUndefined()
      fake.settleTotal(0, 0)
      fake.settleRange(0, rangeOk([], { startBlockIndex: null, endBlockIndex: null }))
      await opening
      expect(cache.streamingOutputChars("s1")).toBe(0)
    })
  })
})
