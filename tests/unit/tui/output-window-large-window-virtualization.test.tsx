/** @jsxImportSource @opentui/solid */

import type { ScrollBoxRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { describe, expect, it } from "bun:test"
import { createComponent } from "solid-js/web"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import type { OutputTranscriptView, TranscriptSnapshot, TranscriptWindow } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"
import { scrollFrameHook } from "../../helpers/scroll-frame-hook.js"
import { makeView } from "./_output-window-transcript.js"

function textBlock(index: number): FrontendOutputBlock {
  return { kind: "text", id: `b${index}`, content: `row ${index}`, timestamp: index }
}

function snapshot(blocks: readonly FrontendOutputBlock[], window: TranscriptWindow, totalBlocks = 601): TranscriptSnapshot {
  return {
    status: { kind: "partial" },
    source: { kind: "historical", consistencyToken: "g-large" },
    totalBlocks,
    window,
    heightEstimates: Array.from({ length: totalBlocks }, (_value, blockIndex) => ({ blockIndex, rows: 1 })),
    blocks,
    generation: 1,
    seedEpoch: 0,
    historicalThroughIndex: -1,
  }
}

function viewOf(snap: TranscriptSnapshot): OutputTranscriptView {
  return makeView(snap).view
}

async function renderWindow(view: OutputTranscriptView): Promise<{ scrollbox: ScrollBoxRenderable; result: Awaited<ReturnType<typeof testRender>> }> {
  const [{ OutputWindow }, { ThemeProvider }] = await Promise.all([
    import("../../../src/tui/output-window/output-window.js"),
    import("../../../src/tui/context/theme.js"),
  ])
  let scrollbox!: ScrollBoxRenderable
  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(OutputWindow, {
          layoutSlot: {},
          transcript: view,
          running: false,
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
            availableWidth: () => 80,
            noProviderReady: () => false,
          },
        })
      },
    }),
    { width: 80, height: 10 },
  )
  await result.flush()
  return { scrollbox, result }
}

describe("OutputWindow large hydrated window virtualization", () => {
  it("mounts a normal-sized window whole for one measure pass, then virtualizes down", async () => {
    // A few-hundred-block window fits the resident-block budget: it mounts whole
    // once so every row's true height lands in the extent index, then the tree
    // GCs down to the viewport neighborhood. scrollHeight stays the full measured
    // extent -- the spacers carry the measured (not estimated) geometry. The
    // window is hydrated to the head: the latch deliberately holds the eager
    // mount while hasBefore is true (see output-window-virtualization.test.tsx).
    const blocks = Array.from({ length: 601 }, (_value, offset) => textBlock(offset))
    const snap = snapshot(blocks, { startBlockIndex: 0, endBlockIndex: 600, hasBefore: false, hasAfter: false, estimatedRows: 601, contentBytes: 0 })
    const { scrollbox, result } = await renderWindow(viewOf(snap))
    try {
      expect(scrollbox.scrollHeight).toBeGreaterThanOrEqual(601)
      // Let the measure batch land and the latch flip, then re-render: GC'd.
      await new Promise((resolve) => setTimeout(resolve, 0))
      await result.renderOnce()
      expect(scrollbox.scrollHeight).toBeGreaterThanOrEqual(601)
      expect(scrollbox.getChildren().length).toBeLessThan(180)
    } finally {
      result.renderer.destroy()
    }
  })

  it("slices to the viewport neighborhood only for a giant window past the resident-block budget", async () => {
    const total = 5000
    const blocks = Array.from({ length: 4800 }, (_value, offset) => textBlock(100 + offset))
    const snap = snapshot(blocks, { startBlockIndex: 100, endBlockIndex: 4899, hasBefore: true, hasAfter: false, estimatedRows: 4800, contentBytes: 0 }, total)
    const { scrollbox, result } = await renderWindow(viewOf(snap))
    try {
      // Frame ticks apply the controller's initial tail pin and let mounted
      // rows measure before the spacer/mount assertions read the geometry.
      const update = scrollFrameHook(scrollbox)
      for (let i = 0; i < 8; i += 1) { update(16); await result.flush(); await new Promise((r) => setTimeout(r, 0)) }
      expect(scrollbox.scrollHeight).toBeGreaterThanOrEqual(total)
      expect(scrollbox.getChildren().length).toBeLessThan(180)
    } finally {
      result.renderer.destroy()
    }
  })
})
