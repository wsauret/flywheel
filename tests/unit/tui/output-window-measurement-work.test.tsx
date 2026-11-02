/** @jsxImportSource @opentui/solid */

import { ScrollBoxRenderable, TextBufferRenderable, TextRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { expect, it, spyOn } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { makeView, renderWindow, snapshot, textBlock, transcriptOf, windowOf } from "./_output-window-transcript.js"
import { createMountedRowRegistry } from "../../../src/tui/output-window/output-window-scroll.js"
import { mountController, snapshotFor } from "../../fixtures/output-scroll-harness.js"

it("measures only changed or newly mounted rows across publications and scrolling", async () => {
  const publicationCost = async (blockCount: number) => {
    const blocks = Array.from({ length: blockCount }, (_, i) => textBlock(`b${40 + i}`, `block ${i}\nline two\nline three\nline four\nline five`))
    const publish = (items = blocks) => snapshot({
      blocks: items,
      totalBlocks: 40 + blockCount,
      window: windowOf({ startBlockIndex: 40, endBlockIndex: 39 + blockCount, hasBefore: true }),
    })
    const { view, set } = makeView(publish())
    const { scrollbox, result, slot } = await renderWindow(view, 30, 80)
    const layouts = spyOn(result.renderer.nativeScene, "getLayout")
    const reports = spyOn(slot.heightIndex!.index, "reportMeasured")
    try {
      for (let frame = 0; frame < 8; frame += 1) await result.renderOnce()
      const mounted = scrollbox.getChildren().length
      layouts.mockClear()
      reports.mockClear()
      set(publish(blocks.map((block, i) => i === blockCount - 1 ? textBlock(`b${40 + i}`, `other ${i}\nline two\nline three\nline four\nline five`) : block)))
      await result.renderOnce()
      expect(reports).not.toHaveBeenCalled()
      expect(layouts.mock.calls.length).toBeLessThanOrEqual(2)
      return { mounted, reads: layouts.mock.calls.length }
    } finally {
      reports.mockRestore()
      layouts.mockRestore()
      result.renderer.destroy()
    }
  }
  const smallPublication = await publicationCost(12)
  const largePublication = await publicationCost(48)
  expect(largePublication.mounted).toBeGreaterThan(smallPublication.mounted)
  expect(largePublication.reads).toBeLessThanOrEqual(smallPublication.reads)

  // Fitting sessions mount every block. A frame must not read the layout
  // of every mounted row: row size callbacks deliver what changed.
  const reportsPerStep = async (blockCount: number) => {
    const blocks = Array.from({ length: blockCount }, (_, i) => textBlock(`b${i}`, `block${i} ${"word ".repeat(5 + ((i * 37) % 60))}`))
    const { scrollbox, result, slot } = await renderWindow(transcriptOf(blocks), 30, 80)
    const layouts = spyOn(result.renderer.nativeScene, "getLayout")
    try {
      for (let frame = 0; frame < 8; frame += 1) await result.renderOnce()
      const index = slot.heightIndex!.index
      let reports = 0
      const reportedIndices: number[] = []
      const report = index.reportMeasured.bind(index)
      index.reportMeasured = (blockIndex, rows) => { reports += 1; reportedIndices.push(blockIndex); report(blockIndex, rows) }
      const leaves = (row: Renderable): TextBufferRenderable[] => row instanceof TextBufferRenderable ? [row] : row.getChildren().flatMap(leaves)
      const steps = 20
      let crossings = 0
      for (let step = 0; step < steps; step += 1) {
        const version = index.extentVersion()
        const before = new Set<object>(scrollbox.getChildren())
        const beforeReports = reports
        layouts.mockClear()
        await result.mockMouse.scroll(10, 10, "up")
        await result.renderOnce()
        const after = scrollbox.getChildren()
        const added = after.filter(row => !before.has(row))
        if (added.length > 0) {
          crossings += 1
          expect(after.some(row => before.has(row))).toBe(true)
          const addedIndices = added.flatMap(row => leaves(row).flatMap(leaf => {
            const match = /^block(\d+) /u.exec(leaf.plainText)
            return match ? [Number(match[1])] : []
          }))
          expect(reports - beforeReports).toBeLessThanOrEqual(added.length)
          for (const blockIndex of reportedIndices.slice(beforeReports)) expect(addedIndices).toContain(blockIndex)
        }
        // Anchor and spacer reads stay bounded when the mounted range changes.
        expect(layouts.mock.calls.filter(([row]) => before.has(row)).length).toBeLessThanOrEqual(4)
        // Reports apply once, in the frame hook, never after each callback.
        expect(index.extentVersion() - version).toBeLessThanOrEqual(1)
      }
      expect(scrollbox.scrollTop).toBeLessThan(scrollbox.scrollHeight - 30)
      return { reports: reports / steps, crossings }
    } finally { layouts.mockRestore(); result.renderer.destroy() }
  }
  const few = await reportsPerStep(60)
  const many = await reportsPerStep(240)
  expect(many.reports).toBeLessThanOrEqual(few.reports)
  expect(many.reports).toBeLessThan(1)
  expect(few.crossings + many.crossings).toBeGreaterThan(0)
})

it("keeps registry lookup and accessor work constant on block-crossing one-row wheel frames", async () => {
  const work = async (count: number) => {
    const result = await createTestRenderer({ width: 60, height: 6 })
    const registry = createMountedRowRegistry()
    const capture = spyOn(registry, "captureText")
    const resolve = spyOn(registry, "resolveText")
    const accessorWork = { reads: 0 }
    let dispose = () => {}
    const unregister: (() => void)[] = []
    try {
      const scroll = new ScrollBoxRenderable(result.renderer, { width: 60, height: 6, scrollY: true })
      result.renderer.root.add(scroll)
      const { controller, setShift } = createRoot(cleanup => {
        dispose = cleanup
        const [shift, updateShift] = createSignal(0)
        for (let i = 0; i < count; i += 1) {
          const row = new TextRenderable(result.renderer, { content: `block ${i}\nsecond line`, height: 2, flexShrink: 0 })
          scroll.add(row)
          unregister.push(registry.register(row, () => { accessorWork.reads += 1; return i + shift() }))
        }
        const rootController = mountController({}, () => snapshotFor(`registry-${count}`, count), { mountedRows: registry })
        rootController.heightIndex().recordMeasuredBatch(Array.from({ length: count }, (_, i) => [i, 2] as const))
        rootController.attach(scroll)
        return { controller: rootController, setShift: updateShift }
      })
      for (let frame = 0; frame < 4; frame += 1) await result.renderOnce()
      // The landing centres the two-row block, so the six-row view opens on
      // the first row of block count - 4.
      controller.toBlock(count - 3)
      for (let frame = 0; frame < 2; frame += 1) await result.renderOnce()
      const before = scroll.scrollTop
      accessorWork.reads = 0
      capture.mockClear()
      resolve.mockClear()
      await result.mockMouse.scroll(3, 2, "up")
      await result.renderOnce()
      const reads = accessorWork.reads
      const lookups = capture.mock.calls.length + resolve.mock.calls.length
      expect(scroll.scrollTop).toBe(before - 1)
      expect(lookups).toBeGreaterThan(0)
      expect(capture.mock.calls.some(([block]) => block === count - 5)).toBe(true)
      setShift(100)
      expect(registry.captureText(count - 1, (count - 1) * 2)).toBeUndefined()
      expect(registry.captureText(count + 99, (count - 1) * 2)).toBeDefined()
      unregister.pop()!()
      expect(registry.captureText(count + 99, (count - 1) * 2)).toBeUndefined()
      return { reads, lookups }
    } finally {
      dispose()
      for (const cleanup of unregister) cleanup()
      capture.mockRestore()
      resolve.mockRestore()
      await result.dispose()
    }
  }
  const few = await work(12)
  const many = await work(48)
  expect(many.lookups).toBeLessThanOrEqual(few.lookups)
  expect(many.reads).toBeLessThanOrEqual(few.reads)
})
