import { describe, expect, it } from "bun:test"
import type { DegradedBlock as DegradedBlockType } from "../../../../src/infra/output-blocks.js"

async function renderDegradedBlock(block: DegradedBlockType) {
  const [{ testRender }, { createComponent }, { DegradedBlock }, { ThemeProvider }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
    import("../../../../src/tui/output-blocks/degraded-block.js"),
    import("../../../../src/tui/context/theme.js"),
  ])
  return testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(DegradedBlock, { block })
      },
    }),
    { width: 80, height: 4 },
  )
}

describe("degraded block", () => {
  it("renders only the fixed safe notice", async () => {
    const result = await renderDegradedBlock({
      kind: "degraded",
      id: "conversation:c1:7:0",
      factFamily: "chat_tree",
      failureClass: "structural_violation",
      eventType: "chat.entries.appended",
      eventVersion: 1,
      eventPosition: 7,
      notice: "Part of this transcript could not be displayed.",
      timestamp: 123,
    })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("• Part of this transcript could not be displayed.")
    } finally {
      result.renderer.destroy()
    }
  })
})
