/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import { createComponent } from "solid-js/web"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { heightEstimatesFromBlocks } from "../../../src/tui/hooks/output-height-estimates.js"
import { LINE_WHEEL } from "../../../src/tui/output-window/output-window-wheel.js"
import type { OutputTranscriptView, TranscriptSnapshot, TranscriptStatus, TranscriptWindow } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"
import { renderScheduledFrame } from "./_output-window-transcript.js"
import { BOLD } from "../../../src/tui/utils/text-attributes.js"

function textBlock(id: string, content: string): FrontendOutputBlock {
  return { kind: "text", id, content, timestamp: 1 }
}

function windowOf(over: Partial<TranscriptWindow> = {}): TranscriptWindow {
  return { startBlockIndex: 40, endBlockIndex: 59, hasBefore: true, hasAfter: false, estimatedRows: 20, contentBytes: 17, ...over }
}

function snapshot(blocks: readonly FrontendOutputBlock[], totalBlocks: number, window: TranscriptWindow): TranscriptSnapshot {
  const heightEstimates = heightEstimatesFor(blocks, window.startBlockIndex ?? 0)
  return {
    status: { kind: "partial" } satisfies TranscriptStatus,
    source: { kind: "historical", consistencyToken: "g1" },
    totalBlocks,
    window: { ...window, estimatedRows: heightEstimates.reduce((sum, estimate) => sum + estimate.rows, 0) },
    heightEstimates,
    blocks,
    generation: 1,
    seedEpoch: 0,
    historicalThroughIndex: -1,
  }
}

function heightEstimatesFor(blocks: readonly FrontendOutputBlock[], startBlockIndex: number) {
  return heightEstimatesFromBlocks(blocks, startBlockIndex, false)
}

function makeView(initial: TranscriptSnapshot) {
  const [snap, set] = createSignal(initial)
  return {
    set,
    view: {
      protectReader: () => {},
      mutationEvidence: () => undefined,
      reportProjectionFailure: (error: unknown): never => { throw error },
      visibleRange: () => snap(),
      visibleMessageCount: () => snap().totalBlocks,
      jumpToLatest: async () => {},
      freshness: () => undefined,
      hydrateAnchor: async () => {},
      loadAround: async () => {},
      takeEstimateUpdates: () => [],
      evictBefore: () => {},
      setDisclosure: () => {},
      disclosure: () => undefined,
      hydrateBlockBody: async () => {},
    },
  }
}

/** `belowRows` sizes a sibling under the transcript that takes rows from it, as the prompt area does. */
async function renderWindow(view: OutputTranscriptView, belowRows: () => number = () => 0, height = 8, clock?: ManualClock): Promise<{ scrollbox: ScrollBoxRenderable; result: Awaited<ReturnType<typeof testRender>> }> {
  const [{ OutputWindow }, { ThemeProvider }] = await Promise.all([
    import("../../../src/tui/output-window/output-window.js"),
    import("../../../src/tui/context/theme.js"),
  ])
  let scrollbox!: ScrollBoxRenderable
  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        const window = createComponent(OutputWindow, {
          layoutSlot: {},
          transcript: view,
          running: false,
          // One row per report on every host: these tests count rows.
          wheel: LINE_WHEEL,
          captureScrollbox: (el: ScrollBoxRenderable) => { scrollbox = el },
          sessionIntro: {
            moduleRows: () => [],
            runtimeIdentity: () => ({ version: "0.0.0-test", buildId: null }), showBuild: () => false,
            projectRoot: () => "/scratch/project",
            accountHome: "/scratch/home",
            userDataRoot: "/scratch/home/.flywheel",
            branchName: () => undefined,
            sessionKind: () => "chat" as const,
            modelLabel: () => undefined,
            profileName: () => "default",
            fontTipDismissed: () => false,
            tabsHintDismissed: () => false, onDismissTabsHint: () => {},
            availableWidth: () => 60,
            noProviderReady: () => false,
          },
        })
        return (
          <box flexDirection="column" height="100%">
            <box flexGrow={1} flexBasis={0} minHeight={0} flexDirection="column">{window}</box>
            <box height={belowRows()} flexShrink={0} />
          </box>
        )
      },
    }),
    { width: 60, height, clock },
  )
  if (!clock) await result.flush()
  else while (result.renderer.getSchedulerState().hasScheduledRender) await renderScheduledFrame(result, clock)
  return { scrollbox, result }
}

describe("OutputWindow bottom follow", () => {
  it("resumes follow after upstream growth and a one-row tail shrink reach the bottom", async () => {
    const initial = Array.from({ length: 30 }, (_, i) => textBlock(`b${40 + i}`, i === 29 ? "row 69\ntail extra" : `row ${40 + i}`))
    const publish = (blocks: readonly FrontendOutputBlock[]) => snapshot(blocks, 40 + blocks.length, windowOf({ endBlockIndex: 39 + blocks.length }))
    const { view, set } = makeView(publish(initial))
    const { scrollbox, result } = await renderWindow(view, () => 0, 24)
    try {
      await result.mockMouse.scroll(2, 2, "up")
      await result.flush()
      expect(scrollbox.scrollTop).toBe(scrollbox.scrollHeight - scrollbox.viewport.height - 1)
      expect(result.captureCharFrame().split("\n")[0]?.trim()).toBe("")
      expect(result.captureCharFrame()).toContain("Latest ↓")
      const grown = initial.map((block, i) => i === 0 ? textBlock("b40", "row 40\ngrowth1\ngrowth2\ngrowth3\ngrowth4\ngrowth5") : block)
      set(publish(grown))
      await result.renderOnce()
      await result.renderOnce()
      const shrunken = grown.map((block, i) => i === 29 ? textBlock("b69", "row 69") : block)
      set(publish(shrunken))
      await result.flush()
      expect(result.captureCharFrame()).not.toContain("Latest ↓")
      set(publish([...shrunken, textBlock("b70", "APPENDED")]))
      await result.flush()
      expect(result.captureCharFrame()).toContain("APPENDED")
      expect(result.captureCharFrame()).not.toMatch(/Latest ↓|new message/u)
    } finally { result.renderer.destroy() }
  })

  it("applies wheel-up from the previous tail when blocks arrive in the same frame", async () => {
    const blocks = Array.from({ length: 20 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`))
    const { view, set } = makeView(snapshot(blocks, 60, windowOf()))
    const { scrollbox, result } = await renderWindow(view)
    try {
      expect(scrollbox.scrollTop).toBe(152)
      expect(result.captureCharFrame().match(/row \d+/u)?.[0]).toBe("row 56")

      const grown = [...blocks, ...Array.from({ length: 4 }, (_, i) => textBlock(`b${60 + i}`, `row ${60 + i}`))]
      set(snapshot(grown, 64, windowOf({ endBlockIndex: 63 })))
      await result.mockMouse.scroll(2, 2, "up")
      for (let frame = 0; frame < 2; frame += 1) {
        await result.renderOnce()
        expect(scrollbox.scrollTop).toBe(151)
        expect(result.captureCharFrame().match(/row \d+/u)?.[0]).toBe("row 55")
      }
    } finally {
      result.renderer.destroy()
    }
  })

  it("paints the full return control in its first off-tail frame and counts new messages without hiding the anchor", async () => {
    const initial = Array.from({ length: 20 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`))
    const { view, set } = makeView(snapshot(initial, 60, windowOf()))
    const clock = new ManualClock()
    const { result, scrollbox } = await renderWindow(view, () => 0, 8, clock)
    try {
      expect(result.captureCharFrame()).not.toContain("Latest ↓")
      const tail = scrollbox.scrollTop
      await result.mockMouse.scroll(2, 2, "up")
      await renderScheduledFrame(result, clock)

      const departed = result.captureCharFrame()
      expect(scrollbox.scrollTop).toBeLessThan(tail)
      expect(departed).toContain("Latest ↓")
      const label = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Latest ↓"))
      if (!label) throw new Error("return control has no painted label")
      expect(label.attributes).toBe(BOLD)
      expect(label.fg.equals(label.bg)).toBe(false)
      const anchorLineIndex = departed.split("\n").findIndex((line) => /row \d+/u.test(line))
      const anchor = departed.split("\n")[anchorLineIndex]?.match(/row \d+/u)?.[0]
      if (anchorLineIndex < 0 || anchor === undefined) throw new Error("departed transcript has no visible row anchor")

      set(snapshot([...initial, textBlock("b60", "row 60")], 61, windowOf({ endBlockIndex: 60, estimatedRows: 21 })))
      while (result.renderer.getSchedulerState().hasScheduledRender) await renderScheduledFrame(result, clock)

      const counted = result.captureCharFrame()
      expect(counted).toContain("1 new message ↓")
      expect(counted.split("\n")[anchorLineIndex]).toContain(anchor)
    } finally {
      result.renderer.destroy()
    }
  })

  it("scrolls the transcript when the pointer is over the return control", async () => {
    const initial = Array.from({ length: 20 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`))
    const { view } = makeView(snapshot(initial, 60, windowOf()))
    const { scrollbox, result } = await renderWindow(view)
    try {
      await result.mockMouse.scroll(2, 2, "up")
      await result.flush()

      const frame = result.captureCharFrame().split("\n")
      const y = frame.findIndex((line) => line.includes("Latest ↓"))
      const x = frame[y]?.indexOf("Latest ↓") ?? -1
      if (x < 0 || y < 0) throw new Error("return control was not rendered")
      const before = scrollbox.scrollTop

      await result.mockMouse.scroll(x, y, "up")
      await result.flush()

      expect(scrollbox.scrollTop).toBeLessThan(before)
    } finally {
      result.renderer.destroy()
    }
  })

  it("does not re-enable follow from bottom geometry without user scroll", async () => {
    const tail = Array.from({ length: 20 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`))
    const { view, set } = makeView(snapshot(tail, 60, windowOf()))
    const { scrollbox, result } = await renderWindow(view)
    try {
      const oldBottom = scrollbox.scrollHeight - scrollbox.viewport.height
      // A real wheel input disarms follow (raw scrollTop movement while follow is
      // active is layout noise and would be re-pinned over).
      await result.mockMouse.scroll(2, 2, "up")
      await result.flush()

      scrollbox.scrollTop = oldBottom
      await result.renderOnce()

      const grownTail = [...tail, ...Array.from({ length: 10 }, (_, i) => textBlock(`b${60 + i}`, `row ${60 + i}`))]
      set(snapshot(grownTail, 70, windowOf({ endBlockIndex: 69, estimatedRows: 30 })))
      await result.flush()

      expect(scrollbox.scrollTop).toBeLessThan(scrollbox.scrollHeight - scrollbox.viewport.height)
      expect(result.captureCharFrame()).not.toContain("row 69")
    } finally {
      result.renderer.destroy()
    }
  })

  it("re-enables follow when the user scrolls back to the hydrated tail", async () => {
    const tail = Array.from({ length: 20 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`))
    const { view, set } = makeView(snapshot(tail, 60, windowOf()))
    const { scrollbox, result } = await renderWindow(view)
    try {
      await result.mockMouse.scroll(2, 2, "up")
      await result.renderOnce()
      expect(scrollbox.scrollTop).toBeLessThan(scrollbox.scrollHeight - scrollbox.viewport.height)
      await result.waitForFrame((frame) => frame.includes("Latest ↓"))

      let returnedFrame = result.captureCharFrame()
      for (let i = 0; i < 100 && returnedFrame.includes("Latest ↓"); i += 1) {
        await result.mockMouse.scroll(2, 2, "down")
        await result.renderOnce()
        returnedFrame = result.captureCharFrame()
      }
      expect(returnedFrame).not.toContain("Latest ↓")
      await result.mockMouse.scroll(2, 2, "down")
      await result.renderOnce()

      const grownTail = [...tail, ...Array.from({ length: 10 }, (_, i) => textBlock(`b${60 + i}`, `row ${60 + i}`))]
      set(snapshot(grownTail, 70, windowOf({ endBlockIndex: 69, estimatedRows: 30 })))
      await result.renderOnce()
      const frame = await result.waitForFrame((rendered) => rendered.includes("row 69"))

      expect(scrollbox.scrollTop).toBeGreaterThanOrEqual(scrollbox.scrollHeight - scrollbox.viewport.height - 1)
      expect(frame).toContain("row 69")
    } finally {
      result.renderer.destroy()
    }
  })

  it("re-enables follow when scrollbar drag reaches the hydrated tail", async () => {
    const tail = Array.from({ length: 20 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`))
    const { view, set } = makeView(snapshot(tail, 60, windowOf()))
    const { scrollbox, result } = await renderWindow(view)
    try {
      await result.mockMouse.scroll(2, 2, "up")
      await result.renderOnce()
      expect(scrollbox.scrollTop).toBeLessThan(scrollbox.scrollHeight - scrollbox.viewport.height)
      await result.waitForFrame((frame) => frame.includes("Latest ↓"))

      // The track is the bar's last column. A press on its top cell takes the
      // thumb there, and a drag below the bar takes it past the end.
      const scrollBar = scrollbox.verticalScrollBar
      const track = scrollBar.x + scrollBar.width - 1
      await result.mockMouse.drag(track, scrollBar.y, track, scrollBar.y + scrollBar.height + 4)
      await result.waitForFrame((frame) => !frame.includes("Latest ↓"))
      await result.renderOnce()

      const grownTail = [...tail, ...Array.from({ length: 10 }, (_, i) => textBlock(`b${60 + i}`, `row ${60 + i}`))]
      set(snapshot(grownTail, 70, windowOf({ endBlockIndex: 69, estimatedRows: 30 })))
      await result.renderOnce()
      const frame = await result.waitForFrame((rendered) => rendered.includes("row 69"))

      expect(scrollbox.scrollTop).toBeGreaterThanOrEqual(scrollbox.scrollHeight - scrollbox.viewport.height - 1)
      expect(frame).toContain("row 69")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the newest row visible on the frame a sibling takes rows from the followed tail", async () => {
    const blocks = Array.from({ length: 20 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`))
    const { view } = makeView(snapshot(blocks, 60, windowOf()))
    const [below, setBelow] = createSignal(0)
    const { result } = await renderWindow(view, below)
    try {
      expect(result.captureCharFrame()).toContain("row 59")
      for (const rows of [3, 3, 0, 4]) {
        setBelow(rows)
        await result.renderOnce()
        expect(result.captureCharFrame()).toContain("row 59")
      }
    } finally {
      result.renderer.destroy()
    }
  })
})
