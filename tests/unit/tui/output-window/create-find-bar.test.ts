import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test"
import { createRoot } from "solid-js"
import type { TranscriptFindMatch, TranscriptFindRequest, TranscriptFindResult } from "../../../../src/protocol/transcript-protocol-types.js"
import { createFindBar } from "../../../../src/tui/output-window/create-find-bar.js"
import { createOutputTranscriptCache } from "../../../../src/tui/transcript-store/create-output-transcript-cache.js"
import { fakeRuntimeClient, liveView, textBlock } from "../hooks/_output-transcript-cache-fixtures.js"

const match = (blockIndex: number, occurrence = 0): TranscriptFindMatch => ({ blockId: `text:b${blockIndex}`, blockIndex, occurrence })
const result = (matches: readonly TranscriptFindMatch[], openFromBlockIndex: number, blockCount: number, more = false): TranscriptFindResult => ({ matches, more, openFromBlockIndex, blockCount })

function harness(answer: (request: TranscriptFindRequest) => TranscriptFindResult | Promise<TranscriptFindResult>) {
  const requests: TranscriptFindRequest[] = []
  const reports: string[] = []
  return createRoot((dispose) => {
    // The transcript the bar follows is the shared cache that live output writes.
    const fake = fakeRuntimeClient()
    const cache = createOutputTranscriptCache({ appService: fake.client })
    cache.retain("s1")
    const bar = createFindBar({
      client: { query: async ({ request }) => { requests.push(request); return answer(request) } },
      sessionId: () => "s1",
      includeThinking: () => false,
      transcript: () => ({ freshness: () => cache.bindSession(() => "s1").freshness() }),
      report: (message) => { reports.push(message) },
    })
    const type = (text: string) => { for (const name of text) bar.input({ name, raw: name }) }
    const key = (name: string, modifiers: { shift?: boolean; meta?: boolean } = {}) => bar.input({ name, ...modifiers })
    const seed = () => fake.live(cache, "s1", liveView([textBlock("b0", "x")]))
    let offset = 1
    const stream = (text: string) => {
      fake.liveDelta("s1", { visibleMessageCount: 0, blocks: [{ kind: "append-content", index: 0, blockId: "text:b0", contentOffset: offset, text }] })
      offset += text.length
    }
    return { bar, requests, reports, type, key, dispose, seed, stream }
  })
}

// The scan waits for typing or output to settle; the fake clock runs the
// wait, then the query's promise settles.
async function settle(ms = 600): Promise<void> {
  jest.advanceTimersByTime(ms)
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve()
}

describe("createFindBar", () => {
  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.useRealTimers() })

  it("opens focused, counts the runtime's matches, and moves through them with wrap", async () => {
    const h = harness(() => result([match(1), match(1, 1), match(4)], 5, 6))
    h.bar.open()
    expect(h.bar.focused()).toBe(true)
    h.type("needle")
    await settle()
    expect(h.requests).toEqual([{ pattern: "needle", regex: false, matchCase: false, includeThinking: false, fromBlockIndex: 0 }])
    expect(h.bar.status()).toBe("0/3")

    h.key("return")
    expect(h.bar.status()).toBe("1/3")
    expect(h.bar.landing()).toMatchObject({ blockId: "text:b1", occurrence: 0 })
    h.key("down")
    h.key("return")
    expect(h.bar.landing()).toMatchObject({ blockId: "text:b4", occurrence: 0 })
    h.key("return")
    expect(h.bar.status()).toBe("1/3")
    h.key("return", { shift: true })
    expect(h.bar.status()).toBe("3/3")
    h.key("up")
    expect(h.bar.landing()).toMatchObject({ blockId: "text:b1", occurrence: 1 })
    h.dispose()
  })

  it("reads toggles, reports a bad pattern without asking, and shows a capped count as 1000+", async () => {
    const h = harness(() => result(Array.from({ length: 1000 }, (_, index) => match(index)), 999, 2000, true))
    h.bar.open()
    h.key("r", { meta: true })
    h.type("(")
    await settle()
    expect(h.bar.status()).toBe("bad pattern")
    expect(h.requests).toEqual([])
    h.key("backspace")
    h.type("x+")
    h.key("c", { meta: true })
    await settle()
    expect(h.requests.at(-1)).toMatchObject({ pattern: "x+", regex: true, matchCase: true })
    expect(h.bar.status()).toBe("0/1000+")
    h.dispose()
  })

  it("keeps one scan in flight while typing outruns slow scans, and counts the final pattern", async () => {
    // The runtime refuses a fifth live find; each scan here takes 1500 ms.
    let inFlight = 0
    let mostInFlight = 0
    const h = harness((request) => {
      if (inFlight >= 4) return Promise.reject(new Error("Too many finds are running"))
      inFlight += 1
      mostInFlight = Math.max(mostInFlight, inFlight)
      return new Promise((resolve) => setTimeout(() => {
        inFlight -= 1
        resolve(result(Array.from({ length: request.pattern.length }, (_, index) => match(index)), 0, 10))
      }, 1500))
    })
    h.bar.open()
    for (const name of "needle") {
      h.type(name)
      await settle(200)
    }
    for (let round = 0; round < 4; round += 1) await settle(1500)
    expect(mostInFlight).toBe(1)
    expect(h.requests.at(-1)?.pattern).toBe("needle")
    expect(h.reports).toEqual([])
    expect(h.bar.status()).toBe("0/6")
    h.dispose()
  })

  it("closes on Escape and reopens with the last pattern selected", async () => {
    const h = harness(() => result([match(0)], 0, 1))
    h.bar.open()
    h.type("abc")
    await settle()
    h.key("return")
    expect(h.key("escape")).toBe(true)
    expect(h.bar.isOpen()).toBe(false)
    expect(h.bar.focused()).toBe(false)
    expect(h.bar.landing()).toBeUndefined()
    expect(h.key("a")).toBe(false)

    h.bar.open()
    expect(h.bar.presentation()).toMatchObject({ value: "abc", selection: { start: 0, end: 3 } })
    h.dispose()
  })

  it("follows streamed output from the first block that can still change and keeps the current match", async () => {
    let follow = result([match(5), match(6)], 6, 7)
    const h = harness((request) => request.fromBlockIndex === 0 ? result([match(1), match(5)], 5, 6) : follow)
    await h.seed()
    h.bar.open()
    h.type("x")
    await settle()
    h.key("return")
    h.key("return")
    expect(h.bar.status()).toBe("2/2")

    // Each streamed delta moves the transcript; a burst asks for one scan.
    h.stream("y")
    h.stream("z")
    await settle()
    expect(h.requests.map((request) => request.fromBlockIndex)).toEqual([0, 5])
    expect(h.bar.status()).toBe("2/3")
    expect(h.bar.landing()).toMatchObject({ blockId: "text:b5" })

    // A transcript that shrank was rewound, so the whole transcript is found again.
    follow = result([], 2, 3)
    h.stream("w")
    await settle()
    expect(h.requests.map((request) => request.fromBlockIndex)).toEqual([0, 5, 6, 0])
    h.dispose()
  })
})
