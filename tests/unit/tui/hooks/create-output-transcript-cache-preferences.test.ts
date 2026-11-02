import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createOutputTranscriptCache } from "../../../../src/tui/transcript-store/create-output-transcript-cache.js"
import { fakeRuntimeClient, windowTotal, rangeOk, textBlock } from "./_output-transcript-cache-fixtures.js"

describe("createOutputTranscriptCache content preferences", () => {
  it("uses the current thinking preference for the next tail and page requests", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      const [showThinking, setShowThinking] = createSignal(false)
      const cache = createOutputTranscriptCache({
        appService: fake.client,
        now: () => 1000,
        includeThinkingContent: showThinking,
      })

      const opening = cache.open("s1")
      fake.settleTotal(0, windowTotal({ startBlockIndex: 99, endBlockIndex: 99, hasBefore: true, hasAfter: false }))
      await Promise.resolve()
      expect(fake.rangeCalls()[0]?.request.includeThinkingContent).toBe(false)
      fake.settleRange(0, rangeOk([textBlock("b99", "tail")], { startBlockIndex: 99, endBlockIndex: 99, hasBefore: true, hasAfter: false }))
      await opening

      setShowThinking(true)
      const paging = cache.loadPage("s1", "older")
      expect(fake.rangeCalls().at(-1)?.request.includeThinkingContent).toBe(true)
      fake.settleRange(fake.rangeCalls().length - 1, rangeOk([textBlock("b98", "older")], { startBlockIndex: 98, endBlockIndex: 98, hasBefore: true, hasAfter: true }))
      await paging
      dispose()
    })
  })
})
