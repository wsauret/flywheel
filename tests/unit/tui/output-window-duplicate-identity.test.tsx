/** @jsxImportSource @opentui/solid */

import { testRender } from "@opentui/solid"
import { describe, expect, it } from "bun:test"
import { createComponent } from "solid-js/web"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import type { TranscriptSnapshot, TranscriptStatus, TranscriptWindow } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"
import { heightEstimatesFromBlocks } from "../../../src/tui/hooks/output-height-estimates.js"
import { makeView } from "./_output-window-transcript.js"

function textBlock(id: string, content: string): FrontendOutputBlock {
  return { kind: "text", id, content, timestamp: 1 }
}

function snapshotOf(blocks: readonly FrontendOutputBlock[]): TranscriptSnapshot {
  const window: TranscriptWindow = {
    startBlockIndex: 0,
    endBlockIndex: blocks.length - 1,
    hasBefore: false,
    hasAfter: false,
    estimatedRows: blocks.length,
    contentBytes: 64,
  }
  return {
    status: { kind: "partial" } satisfies TranscriptStatus,
    source: { kind: "historical", consistencyToken: "g1" },
    totalBlocks: blocks.length,
    window,
    heightEstimates: heightEstimatesFromBlocks(blocks, 0, false),
    blocks,
    generation: 1,
    seedEpoch: 0,
    historicalThroughIndex: -1,
  }
}

// A durable branch that double-recorded a turn hands the viewport two blocks
// with the SAME identity. <Key by id> would then give OpenTUI's reconciler
// the same renderable twice, and Yoga's WASM aborts the whole process on the
// second insertChild ("child already has an owner"). The viewport must key
// duplicates with an occurrence suffix and render both truthfully.
describe("TranscriptViewport duplicate block identities", () => {
  it("renders a window containing duplicate identities without crashing", async () => {
    const blocks = [
      textBlock("a", "alpha row"),
      textBlock("dup", "duplicated row"),
      textBlock("dup", "duplicated row"),
      textBlock("z", "omega row"),
    ]
    const snap = snapshotOf(blocks)
    const { view } = makeView(snap)
    const [{ OutputWindow }, { ThemeProvider }] = await Promise.all([
      import("../../../src/tui/output-window/output-window.js"),
      import("../../../src/tui/context/theme.js"),
    ])
    const result = await testRender(
      () => createComponent(ThemeProvider, {
        mode: "dark",
        get children() {
          return createComponent(OutputWindow, {
            layoutSlot: {},
            transcript: view,
            running: false,
            captureScrollbox: () => {},
            onNearEdge: () => {},
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
        },
      }),
      { width: 60, height: 16 },
    )
    try {
      await result.flush()
      const frame = result.captureCharFrame()
      expect(frame).toContain("alpha row")
      expect(frame).toContain("omega row")
      const duplicates = frame.match(/duplicated row/g) ?? []
      expect(duplicates.length).toBe(2)
    } finally {
      result.renderer.destroy()
    }
  })
})
