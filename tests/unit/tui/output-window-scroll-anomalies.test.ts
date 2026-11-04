import { describe, expect, it, spyOn } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { DebugLog } from "../../../src/infra/debug-log.js"
import { createRowChurnMonitor } from "../../../src/tui/output-window/output-window-scroll-anomalies.js"
import type { TranscriptLayoutSlot } from "../../../src/tui/output-window/output-window-scroll.js"
import type { TranscriptSnapshot } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"
import { LINE_WHEEL } from "../../../src/tui/output-window/output-window-wheel.js"
import { asScrollBox, fakeScrollBox, mountController, snapshotFor } from "../../fixtures/output-scroll-harness.js"
import { makeView, renderWindow, snapshot, textBlock, windowOf } from "./_output-window-transcript.js"

describe("createRowChurnMonitor", () => {
  it("records a row that keeps unmounting without a height report once, and closes its episode when it reports", () => {
    const records = spyOn(DebugLog, "record").mockImplementation(() => {})
    const churn = createRowChurnMonitor("s-churn")
    const evidence = () => ({ kind: "tool", holdReason: "no-layout", indexRows: 3 })
    const written = () => records.mock.calls.map(([record]) => record)
    try {
      // Scrolling away unmounts a row once; a row that reported never counts.
      churn.mounted(4, 1).unmounted(evidence)
      const reporting = churn.mounted(9, 1)
      reporting.reported()
      reporting.unmounted(evidence)
      expect(written()).toEqual([])
      churn.mounted(4, 1).unmounted(evidence)
      churn.mounted(4, 1).unmounted(evidence)
      expect(written()).toEqual([{ type: "tui.row.mount_churn.detected", sessionId: "s-churn", payload: { blockIndex: 4, generation: 1, unmounts: 3, kind: "tool", holdReason: "no-layout", indexRows: 3 } }])
      churn.mounted(4, 1).unmounted(evidence)
      churn.mounted(4, 1).unmounted(evidence)
      churn.mounted(4, 1).reported()
      expect(written().slice(1)).toMatchObject([{ type: "tui.row.mount_churn.ended", sessionId: "s-churn", payload: { blockIndex: 4, generation: 1, count: 3 } }])
      // An episode of one occurrence closes too, here at a new generation.
      for (let mount = 0; mount < 3; mount += 1) churn.mounted(7, 1).unmounted(evidence)
      churn.mounted(7, 2)
      expect(written().slice(2).map(record => [record.type, record.payload])).toMatchObject([
        ["tui.row.mount_churn.detected", { blockIndex: 7, generation: 1 }],
        ["tui.row.mount_churn.ended", { blockIndex: 7, generation: 1, count: 1 }],
      ])
    } finally {
      churn.close()
      records.mockRestore()
    }
  })
})

describe("createOutputScrollController fight record", () => {
  it("records an extent that swings without input once with its evidence, and closes it once when it stops", () => {
    // 20 blocks x 2 rows = 40 content rows; viewport 10 => maxScrollTop 30.
    const slot: TranscriptLayoutSlot = { sessionId: "s-fight" }
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-fight", 20))
    const records = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      createRoot((dispose) => {
        const controller = mountController(slot, snap)
        const box = fakeScrollBox()
        controller.attach(asScrollBox(box))
        box.scrollHeight = 40
        box.frame(16)
        controller.page("half-page-up")
        box.frame(16)
        const written = () => records.mock.calls.map(([record]) => record).filter(record => record.type.startsWith("tui."))
        // Steady frames and the person's own scrolling write nothing.
        for (let frame = 0; frame < 5; frame += 1) {
          box.onMouseEvent?.({ type: "scroll", scroll: { direction: "up", delta: 1 } })
          box.frame(16)
        }
        expect(written()).toEqual([])
        // A row mounts and unmounts on alternate frames: the extent swings between 40 and 41.
        for (let frame = 0; frame < 10; frame += 1) {
          box.scrollHeight = 40 + (frame % 2)
          box.frame(16)
        }
        expect(written().map(record => record.type)).toEqual(["tui.scroll.fight.detected"])
        expect(written()[0]).toMatchObject({ sessionId: "s-fight", payload: { kind: "extent-oscillation", extents: [40, 41, 40], nativeExtent: 40, indexRows: 40, unindexedRows: 0, unaccountedRows: 0, viewportRows: 10, anchorKind: "block" } })
        expect(written()[0]?.payload).toHaveProperty("previousScrollTop")
        box.scrollHeight = 40
        for (let frame = 0; frame < 40; frame += 1) box.frame(16)
        expect(written().map(record => record.type)).toEqual(["tui.scroll.fight.detected", "tui.scroll.fight.ended"])
        // Nine returns: frames 2 to 9, and the settle back to 40.
        expect(written()[1]).toMatchObject({ sessionId: "s-fight", payload: { kind: "extent-oscillation", count: 9 } })
        dispose()
      })
    } finally {
      records.mockRestore()
    }
  })
})

describe("OutputWindow fight record across a resize", () => {
  it("records no fight for wheel steps after the width reflows the anchor block", async () => {
    // Wrapping blocks: the row within the anchor block depends on the width.
    const blocks = Array.from({ length: 30 }, (_, i) => textBlock(`b${i}`, Array.from({ length: 60 }, (_word, word) => `w${i}_${word}`).join(" ")))
    const { view } = makeView(snapshot({ blocks, window: windowOf({ endBlockIndex: 29 }) }))
    const records = spyOn(DebugLog, "record").mockImplementation(() => {})
    const { result, slot } = await renderWindow(view, 12, 80, "workflow-agent", false, undefined, LINE_WHEEL, { sessionId: "s-resize" })
    try {
      for (let frame = 0; frame < 6; frame += 1) await result.renderOnce()
      for (let step = 0; step < 20; step += 1) {
        await result.mockMouse.scroll(5, 5, "up")
        await result.renderOnce()
      }
      expect(slot.scroll?.anchor?.kind).toBe("block")
      result.resize(40, 12)
      for (let frame = 0; frame < 3; frame += 1) await result.renderOnce()
      for (let step = 0; step < 5; step += 1) {
        await result.mockMouse.scroll(5, 5, "up")
        await result.renderOnce()
      }
      expect(records.mock.calls.map(([record]) => record.type).filter(type => type.startsWith("tui."))).toEqual([])
    } finally {
      result.renderer.destroy()
      records.mockRestore()
    }
  })
})
