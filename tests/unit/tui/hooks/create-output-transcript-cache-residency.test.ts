import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import type { ChatInput } from "../../../../src/infra/chat-input.js"
import { createChatSubmissions } from "../../../../src/protocol/client/chat-submissions.js"
import { createOutputTranscriptCache } from "../../../../src/tui/transcript-store/create-output-transcript-cache.js"
import { content, fakeRuntimeClient, liveView, rangeOk, seedComplete, textBlock } from "./_output-transcript-cache-fixtures.js"
import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import type { OutputView } from "../../../../src/protocol/output-protocol-types.js"

function outputView(cache: ReturnType<typeof createOutputTranscriptCache>, id: string): OutputView {
  const view = cache.view(id)
  if (!view) throw new Error(`no output view for ${id}`)
  return view
}

// Residency policy: mounted surfaces retain their sessions and the open
// inflight doubles as the cursor probe. Splice admission is structural (absolute span
// plus anchor identity), owned by the cache tests; tokens are range-snapshot
// provenance and never gate residency.
describe("createOutputTranscriptCache (residency and fetch dedupe)", () => {
  it("evicts a session only after its owning retention handle releases it", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000, maxSessions: 2 })
      await seedComplete(cache, fake, "s1")
      const s1 = cache.retain("s1")
      await seedComplete(cache, fake, "s2")
      s1.release()
      const s2 = cache.retain("s2")
      await seedComplete(cache, fake, "s3")

      expect(cache.visibleRange("s1")).toBeUndefined()
      expect(cache.visibleRange("s2")).toBeDefined()
      expect(cache.visibleRange("s3")).toBeDefined()
      s2.release()
      dispose()
    })
  })

  it("keeps every active session resident and evicts inactive sessions first", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      let now = 1000
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => now, maxSessions: 2, activeSessions: () => new Set(["s1"]) })
      await seedComplete(cache, fake, "s1")
      await seedComplete(cache, fake, "s2")
      await seedComplete(cache, fake, "s3")

      // Over the floor by one: the inactive s2 leaves before the older but active s1.
      expect(cache.visibleRange("s1")).toBeDefined()
      expect(cache.visibleRange("s2")).toBeUndefined()
      expect(cache.visibleRange("s3")).toBeDefined()
      const before = cache.visibleRange("s1")
      now += 21 * 60 * 1000
      cache.ensure("s3")
      expect(cache.visibleRange("s1")).toBe(before)
      expect(cache.residentSessionIds()).toContain("s1")
      dispose()
    })
  })

  it("raises the residency floor to the active session count", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000, maxSessions: 2, activeSessions: () => new Set(["s1", "s2", "s3"]) })
      await seedComplete(cache, fake, "s1")
      await seedComplete(cache, fake, "s2")
      await seedComplete(cache, fake, "s3")

      expect(cache.residentSessionIds()).toEqual(["s1", "s2", "s3"])
      dispose()
    })
  })

  it("confirms hidden message delivery while deferring presentation until a surface retains it", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      let submitted: ChatInput | undefined
      const submissions = createChatSubmissions({
        lanes: { onLane: () => () => {} },
        dispatch: async (_id, input) => { submitted = input; return { ok: true } },
      })
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000, onBlocksAdopted: submissions.observe })
      const shown = cache.retain("s1")
      let reshown: ReturnType<typeof cache.retain> | undefined
      try {
        await fake.live(cache, "s1", liveView([textBlock("t1", "one")]))
        await submissions.send("s1", { text: "continue" })
        expect(submissions.pending("s1")).toHaveLength(1)
        expect(submitted?.submissionIds).toHaveLength(1)
        shown.release()

        const delivered: FrontendOutputBlock = {
          kind: "userMessage", id: "delivered", content: "continue", timestamp: 2,
          pending: false, injected: false, submissionIds: submitted?.submissionIds,
        }
        await fake.live(cache, "s1", liveView([textBlock("t1", "one"), delivered]))
        expect(outputView(cache, "s1").blocks.map(content)).toEqual(["one"])
        expect(submissions.pending("s1")).toHaveLength(0)

        reshown = cache.retain("s1")
        expect(outputView(cache, "s1").blocks.map(content)).toEqual(["one", "continue"])
        expect(outputView(cache, "s1").blocks[1]).toMatchObject({ pending: false })
        expect(submissions.pending("s1")).toHaveLength(0)
      } finally {
        reshown?.release()
        shown.release()
        submissions.dispose()
        dispose()
      }
    })
  })

  it("restores an active Bash output tail after switching away and back", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient()
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000, maxSessions: 2 })
      const bash: FrontendOutputBlock = { kind: "tool", id: "bash-active", name: "bash", presentation: { name: "Bash", detail: "long command" }, status: "pending", timestamp: 1 }
      const streamingToolText = { [bash.id]: { content: "prior output\nstill running" } }
      await fake.live(cache, "s1", liveView([bash], streamingToolText))
      const s1 = cache.retain("s1")

      await seedComplete(cache, fake, "s2")
      s1.release()
      const s2 = cache.retain("s2")
      await seedComplete(cache, fake, "s3")
      expect(cache.view("s1")).toBeUndefined()

      const reopened = cache.retain("s1")
      const reopening = cache.open("s1")
      fake.settleTotal(fake.totalCalls().length - 1, 1)
      await Promise.resolve()
      fake.settleRange(fake.rangeCalls().length - 1, { ...rangeOk([bash]), streamingToolText })
      await reopening

      expect(outputView(cache, "s1").streamingToolText).toEqual(streamingToolText)
      s2.release()
      reopened.release()
      dispose()
    })
  })

  it("ensure while an open is in flight does not duplicate the outputWindow fetch", async () => {
    await createRoot(async (dispose) => {
      const fake = fakeRuntimeClient({ "chat-1": [textBlock("a", "seeded")] })
      const cache = createOutputTranscriptCache({ appService: fake.client, now: () => 1000 })

      const opening = cache.open("chat-1")
      cache.ensure("chat-1") // the open IS the probe: its response adopts the cursor baseline
      await opening
      await Promise.resolve()

      expect(fake.outputWindowCalls()).toBe(1)
      expect(content(outputView(cache, "chat-1").blocks[0])).toBe("seeded")

      cache.ensure("chat-1") // already probed: still no extra fetch
      await Promise.resolve()
      expect(fake.outputWindowCalls()).toBe(1)
      dispose()
    })
  })
})
