/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { heightEstimatesFromBlocks } from "../../../src/tui/hooks/output-height-estimates.js"
import { makeView, renderWindow, snapshot, textBlock, windowOf } from "./_output-window-transcript.js"

describe("OutputWindow resize", () => {
  it.each([
    { from: 30, to: 60, wrapped: false },
    { from: 60, to: 30, wrapped: false },
    { from: 30, to: 60, wrapped: true },
    { from: 60, to: 30, wrapped: true },
  ])("paints the reading anchor on the first resize frame with upstream spacers ($from to $to, wrapped $wrapped)", async ({ from, to, wrapped }) => {
    const blocks = Array.from({ length: 10 }, (_, i) => textBlock(`b${i + 40}`, `block${i + 40}${wrapped ? " x".repeat(from) : ""}`))
    const { view } = makeView(snapshot({
      blocks,
      totalBlocks: 100,
      heightEstimates: [
        ...Array.from({ length: 40 }, (_, blockIndex) => ({ blockIndex, rows: 2 })),
        ...heightEstimatesFromBlocks(blocks, 40, false),
      ],
      window: windowOf({ startBlockIndex: 40, endBlockIndex: 49, hasBefore: true, hasAfter: true }),
    }))
    const { result, scrollbox, setCommand, slot } = await renderWindow(view, 10, from, "workflow-agent")
    const top = () => result.captureCharFrame().split("\n")[scrollbox.viewport.y]?.trim() ?? ""
    try {
      setCommand({ id: 1, type: "half-page-down" })
      for (let frame = 0; frame < 3; frame++) await result.renderOnce()
      const reading = top().match(/block\d+/)?.[0]
      expect(reading).toBeDefined()
      const saved = slot.scroll?.textPosition
      expect(saved).toBeDefined()
      const painted: string[] = []
      result.renderer.on("frame", () => { painted.push(top()) })
      result.resize(to, 10)
      await result.renderOnce()
      expect(painted.length).toBeGreaterThan(0)
      expect(painted[0]).toContain(reading!)
      expect(slot.scroll?.textPosition).toEqual(saved)
    } finally { result.renderer.destroy(); await result.renderer.closed }
  })
})
