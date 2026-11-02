/** @jsxImportSource @opentui/solid */

import { TextBufferRenderable, type Renderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { describe, expect, it, spyOn } from "bun:test"
import { DebugLog } from "../../../src/infra/debug-log.js"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { DEFAULT_ESTIMATE } from "../../../src/tui/hooks/output-height-estimates.js"
import { createTranscriptWindowProjector } from "../../../src/tui/output-window/output-window-projection.js"
import { makeView, mutationTranscriptFixture, renderScheduledFrame, renderWindow, snapshot, textBlock, transcriptOf, windowOf } from "./_output-window-transcript.js"
import { createBlockDisclosureChannel } from "../../../src/tui/context/block-disclosure.js"
import { mutationEvidenceFixture } from "./output-blocks/_mutation-evidence-fixture.js"
import { scrollFrameHook } from "../../helpers/scroll-frame-hook.js"
import { LINE_WHEEL } from "../../../src/tui/output-window/output-window-wheel.js"
import type { TranscriptLayoutSlot } from "../../../src/tui/output-window/output-window-scroll.js"

/** The hidden-growth transcript: the tab measured its first blocks, then EDITS edits arrived
 *  every EDIT_GAP blocks among prose while it was hidden. */
const TOTAL_BLOCKS = 80
const SHOWN_BLOCKS = 20
const EDITS = 2
const EDIT_GAP = 10

describe("OutputWindow virtualization", () => {
  it("keeps a gap-row anchor painted through a visibility toggle and fresh estimates", async () => {
    const blocks = Array.from({ length: 40 }, (_, block) => textBlock(`b${block}`, Array.from({ length: 50 }, (_word, word) => `w${block}_${word}`).join(" ")))
    const publish = () => snapshot({ blocks, window: windowOf({ endBlockIndex: 39 }) })
    const { view, set } = makeView(publish())
    const { scrollbox, result, slot, setShowThinking } = await renderWindow(view, 20, 60, "chat", false, undefined, LINE_WHEEL)
    try {
      for (let frame = 0; frame < 10; frame += 1) await result.renderOnce()
      for (let up = 0; up < 12; up += 1) {
        await result.mockMouse.scroll(10, 10, "up")
        await result.renderOnce()
      }
      const index = slot.heightIndex!.index
      const textOf = (row: Renderable): string => (row instanceof TextBufferRenderable ? row.plainText : "") + row.getChildren().map(textOf).join("")
      const mountedIndices = scrollbox.getChildren().flatMap(row => {
        const match = /w(\d+)_\d+/u.exec(textOf(row))
        return match ? [Number(match[1])] : []
      })
      expect(slot.scroll?.anchor?.blockIndex).toBe(36)
      // The viewport top is the gap row above the block's text: the reading position holds the text below it.
      expect(slot.scroll?.textPosition).toBeDefined()
      expect(slot.scroll?.textDepth).toBeGreaterThan(0)
      const contentFrame = () => result.captureCharFrame().split("\n").map(line => line.slice(0, 57)).join("\n")
      const before = contentFrame()
      const reports = spyOn(index, "reportMeasured")
      try {
        setShowThinking(true)
        set(publish())
        for (let frame = 0; frame < 3; frame += 1) {
          await result.renderOnce()
          expect(contentFrame()).toBe(before)
          for (const blockIndex of mountedIndices) expect(index.hasMeasured(blockIndex)).toBe(true)
        }
        for (const blockIndex of mountedIndices) expect(reports.mock.calls.some(([reported]) => reported === blockIndex)).toBe(true)
      } finally { reports.mockRestore() }
    } finally { result.renderer.destroy() }
  })

  it.each(["thinking", "system", "userMessage"] as const)("retains open and closed %s choices after virtualizing, without sharing choices between identities", async kind => {
    const fixture = await mutationEvidenceFixture([{ path: "notice.ts", lines: 2, patch: "@@ -1 +1 @@\n-before\n+DISCLOSED-BODY" }])
    const block = (id: string): FrontendOutputBlock => kind === "thinking"
      ? { kind, id, timestamp: 1, status: "completed", content: "DISCLOSED-BODY\nline two\nline three\nline four\nline five\nline six" }
      : kind === "system" ? { kind, id, timestamp: 1, message: "Review notice", mutationEvidence: fixture.evidence }
      : { kind, id, timestamp: 1, injected: true, pending: false, content: "Injected heading\n\nDISCLOSED-BODY" }
    const blocks = [block("chosen"), ...Array.from({ length: 300 }, (_, i) => textBlock(`filler${i}`, `filler ${i}`)), block("untouched")]
    const disclosure = createBlockDisclosureChannel()
    const view = { ...transcriptOf(blocks), ...disclosure, mutationEvidence: () => fixture.reader }
    const { result, scrollbox, setCommand } = await renderWindow(view, 16, 80, "workflow-agent", true)
    let commandId = 0
    const frames = async () => { for (let frame = 0; frame < 6; frame++) { await result.renderOnce(); await fixture.settle() } }
    const navigate = async (type: "top" | "bottom") => { setCommand({ id: ++commandId, type }); await frames() }
    const header = kind === "thinking" ? "Thinking" : kind === "system" ? "Review notice" : "System"
    const assertOpen = (open: boolean) => {
      const frame = result.captureCharFrame()
      expect(frame.split("\n").find(line => line.includes(header))).toContain(open ? "▾" : "▸")
      expect(frame.includes("DISCLOSED-BODY")).toBe(open)
    }
    const click = async () => {
      const y = result.captureCharFrame().split("\n").findIndex(line => line.includes(header))
      expect(y).toBeGreaterThanOrEqual(0)
      await result.mockMouse.click(10, y)
      await frames()
    }
    const row = () => scrollbox.getChildren().find(child => child.getChildren().some(function contains(node: Renderable): boolean {
      return node instanceof TextBufferRenderable && node.plainText.includes(header) || node.getChildren().some(contains)
    }))
    try {
      await frames()
      await navigate("top")
      const initialOpen = kind === "userMessage"
      assertOpen(initialOpen)
      for (const open of [!initialOpen, initialOpen]) {
        await click()
        assertOpen(open)
        const chosenRow = row()
        expect(chosenRow).toBeDefined()
        await navigate("bottom")
        expect(scrollbox.getChildren()).not.toContain(chosenRow)
        expect(scrollbox.getChildren().length).toBeLessThan(120)
        assertOpen(initialOpen)
        await navigate("top")
        expect(row()).not.toBe(chosenRow)
        expect(scrollbox.getChildren().length).toBeLessThan(120)
        assertOpen(open)
      }
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it.each(["up", "down"] as const)("settles collapsed diffs from their metadata pages and holds visible lines through %s wheel glide", async direction => {
    // Each edit renders about 29 rows. A collapsed edit takes its rows from the previews in its
    // metadata page, so its height is final when the page settles and no glide reads patch bytes.
    const { view, settle, patchReads, dispose } = await mutationTranscriptFixture(16)
    const previousTerminal = process.env.WT_SESSION
    process.env.WT_SESSION = "wheel-glide-test"
    let clock = 0
    const time = spyOn(performance, "now").mockImplementation(() => { clock += 1000; return clock })
    // The renderer paints only the frames it schedules, on this clock, so no
    // wall-clock render timer can slip an unchecked glide frame between checks.
    const frameClock = new ManualClock()
    const { result, scrollbox, setCommand } = await renderWindow(view, 24, 80, "workflow-agent", false, frameClock)
    const tracked = () => {
      const rows = new Map<string, number>()
      for (const [row, line] of result.captureCharFrame().split("\n").entries()) {
        const key = /(MARKER-\d+|[-+](?:old|new) F\d+L\d+|Edit file\d+\.ts)/.exec(line)?.[0]
        if (key) rows.set(key, row)
      }
      return rows
    }
    /** Settles the lazy reads, then paints each frame the view schedules and settles
     *  after it, until a frame and its settled reads schedule no further frame. */
    const paintUntilQuiet = async (check: (frame: number, oldTop: number) => void = () => {}) => {
      await settle()
      for (let frame = 0; result.renderer.getSchedulerState().hasScheduledRender; frame++) {
        const oldTop = scrollbox.scrollTop
        await renderScheduledFrame(result, frameClock)
        check(frame, oldTop)
        await settle()
      }
    }
    const atEdge = () => direction === "up" ? scrollbox.scrollTop === 0 : scrollbox.scrollTop === scrollbox.scrollHeight - scrollbox.viewport.height
    try {
      await paintUntilQuiet()
      if (direction === "down") {
        setCommand({ id: 1, type: "top" })
        await paintUntilQuiet()
      }
      let before = tracked()
      let comparisons = 0
      const unexpected: string[] = []
      const loadingInView: string[] = []
      const checkFrame = (step: number, frame: number, oldTop: number) => {
        const after = tracked()
        for (const [row, line] of result.captureCharFrame().split("\n").slice(0, 23).entries()) {
          if (/Loading\.\.\.|More files\.\.\./.test(line)) loadingInView.push(`${step}:${frame} row ${row}`)
        }
        const rows = frame === 0 ? 2 : frame === 1 ? 1 : 0
        const available = direction === "up" ? oldTop : scrollbox.scrollHeight - scrollbox.viewport.height - oldTop
        const movement = Math.min(rows, available) * (direction === "up" ? 1 : -1)
        for (const [key, row] of before) {
          const target = row + movement
          if (target < 0 || target >= 23) continue
          comparisons++
          if (after.get(key) !== target) unexpected.push(`${step}:${frame} ${key} ${row}->${after.get(key)}`)
        }
        before = after
      }
      for (let step = 0; !atEdge(); step++) {
        const stepTop = scrollbox.scrollTop
        await result.mockMouse.scroll(2, 2, direction)
        await paintUntilQuiet(checkFrame.bind(undefined, step))
        // Every report moves the view until the content edge stops it.
        expect(scrollbox.scrollTop).not.toBe(stepTop)
      }
      expect(patchReads()).toBe(0)
      expect(comparisons).toBeGreaterThan(1000)
      expect(unexpected).toEqual([])
      expect(loadingInView).toEqual([])
    } finally {
      result.renderer.destroy()
      dispose()
      time.mockRestore()
      if (previousTerminal === undefined) Reflect.deleteProperty(process.env, "WT_SESSION")
      else process.env.WT_SESSION = previousTerminal
    }
  })

  it("moves the content by exactly the wheel rows past edits that arrived while the tab was hidden", async () => {
    // The tab measured its first edits, then left. The edits that arrived while it was hidden
    // return unmeasured on the same height index, and each holds its height until its metadata
    // page settles. Every one-row wheel step from the tail to the top moves every line one row.
    const evidence = await mutationTranscriptFixture(EDITS)
    const { settle, dispose } = evidence
    const edits = evidence.view.visibleRange()!.blocks.filter(block => block.kind === "tool")
    // Prose of mixed lengths with the edits spread through the part that grew while hidden.
    const blocks = Array.from({ length: TOTAL_BLOCKS }, (_block, i): FrontendOutputBlock => {
      const edit = i >= SHOWN_BLOCKS && (i - SHOWN_BLOCKS) % EDIT_GAP === 0 ? edits[(i - SHOWN_BLOCKS) / EDIT_GAP] : undefined
      return edit ?? textBlock(`p${i}`, `MARKER-${i} ${"words ".repeat(i % 3 === 0 ? 40 : 2)}`)
    })
    const viewOf = (shown: readonly FrontendOutputBlock[]) => ({
      ...makeView(snapshot({ blocks: shown, window: windowOf({ endBlockIndex: shown.length - 1 }) })).view,
      mutationEvidence: evidence.view.mutationEvidence,
    })
    const slot: TranscriptLayoutSlot = {}
    const tracked = (frame: string) => {
      const rows = new Map<string, number>()
      for (const [row, line] of frame.split("\n").slice(0, 23).entries()) {
        const key = /(MARKER-\d+|[-+](?:old|new) F\d+L\d+|Edit file\d+\.ts)/.exec(line)?.[0]
        if (key) rows.set(key, row)
      }
      return rows
    }
    // A frame that schedules another one can loop without input, so each call paints a bounded count.
    const paint = async (window: Awaited<ReturnType<typeof renderWindow>>, clock: ManualClock, frames = 3) => {
      for (let frame = 0; frame < frames; frame++) {
        await settle()
        if (!window.result.renderer.getSchedulerState().hasScheduledRender) return
        await renderScheduledFrame(window.result, clock)
      }
    }
    const firstClock = new ManualClock()
    const first = await renderWindow(viewOf(blocks.slice(0, SHOWN_BLOCKS)), 24, 80, "chat", false, firstClock, LINE_WHEEL, slot)
    await paint(first, firstClock, 40)
    first.result.renderer.destroy()
    expect(slot.heightIndex?.eagerCompleted).toBe(true)
    const clock = new ManualClock()
    const records = spyOn(DebugLog, "record").mockImplementation(() => {})
    const second = await renderWindow(viewOf(blocks), 24, 80, "chat", false, clock, LINE_WHEEL, slot)
    const { result, scrollbox } = second
    try {
      await paint(second, clock, 12)
      expect(slot.heightIndex!.index.hasMeasured(SHOWN_BLOCKS)).toBe(false)
      const unexpected: string[] = []
      let before = tracked(result.captureCharFrame())
      for (let step = 0; scrollbox.scrollTop > 0 && step < 2000; step++) {
        await result.mockMouse.scroll(2, 2, "up")
        await paint(second, clock)
        const after = tracked(result.captureCharFrame())
        for (const [key, row] of before) {
          if (row + 1 < 23 && after.get(key) !== row + 1) unexpected.push(`${step} ${key} ${row}->${after.get(key)}`)
        }
        before = after
      }
      expect(unexpected.slice(0, 5)).toEqual([])
      expect(scrollbox.scrollTop).toBe(0)
      // The index matched native layout throughout: no fight or churn recorded itself.
      expect(records.mock.calls.map(([record]) => record.type).filter(type => type.startsWith("tui."))).toEqual([])
    } finally {
      result.renderer.destroy()
      records.mockRestore()
      dispose()
    }
  })

  it("paints the same rendered source through width changes and moved recovery", async () => {
    const content = `# Heading\n\n${Array.from({ length: 20 }, (_, i) => `paragraph${i} 界\t ${"word ".repeat(35)}`).join("\n\n")}\n\n\`\`\`text\n${Array.from({ length: 12 }, (_, i) => `code${i}\t界 ${"value ".repeat(27)}`).join("\n")}\n\`\`\`\n\n${"tail ".repeat(200)}`
    const initial = snapshot({ blocks: [textBlock("reading", content)], window: windowOf({ endBlockIndex: 0 }) })
    const { view, set } = makeView(initial)
    const { result, scrollbox, setCommand, slot } = await renderWindow(view, 14, 80)
    let id = 0
    const frames = async () => { for (let frame = 0; frame < 3; frame++) await result.renderOnce() }
    const leaves = (el: Renderable): TextBufferRenderable[] => el instanceof TextBufferRenderable ? [el] : el.getChildren().flatMap(leaves)
    const top = () => {
      const y = scrollbox.viewport.y
      const leaf = leaves(scrollbox).find((el) => el.y <= y && el.y + el.height > y)
      if (!leaf) return undefined
      const visual = y - leaf.y + leaf.scrollY
      const info = leaf.lineInfo
      return { subject: leaf.plainText, source: info.lineSources[visual], column: info.lineStartCols[visual], nextColumn: info.lineSources[visual + 1] === info.lineSources[visual] ? info.lineStartCols[visual + 1] : undefined, frame: result.captureCharFrame().split("\n")[y] }
    }
    const resize = async () => {
      const before = top()
      if (!before) throw new Error("expected text at the viewport top")
      const saved = slot.scroll?.textPosition
      const wideLines = leaves(scrollbox).reduce((total, leaf) => total + leaf.lineInfo.lineSources.length, 0)
      for (const width of [40, 80]) {
        result.resize(width, 14)
        for (let frame = 0; frame < 3; frame++) {
          await result.renderOnce()
          if (width === 40) {
            const narrowLines = leaves(scrollbox).reduce((total, leaf) => total + leaf.lineInfo.lineSources.length, 0)
            expect(narrowLines).toBeGreaterThan(wideLines)
          }
          const current = top()
          expect(current?.subject).toBe(before.subject)
          expect(current?.source).toBe(before.source)
          expect(current?.column).toBeLessThanOrEqual(before.column ?? 0)
          expect(current?.nextColumn ?? Infinity).toBeGreaterThan(before.column ?? 0)
          expect(slot.scroll?.textPosition).toEqual(saved)
          if (width === 80) {
            expect(current?.column).toBe(before.column)
            expect(current?.frame?.trim()).toBe(before.frame?.trim())
          }
        }
      }
      return before
    }
    try {
      await frames()
      setCommand({ id: ++id, type: "top" })
      await frames()
      setCommand({ id: ++id, type: "page-down" })
      await frames()
      setCommand({ id: ++id, type: "half-page-down" })
      await frames()
      const before = await resize()
      const prefix = textBlock("inserted", "older text")
      set(snapshot({ blocks: [prefix, ...initial.blocks], window: windowOf({ endBlockIndex: 1 }), generation: 2, seedEpoch: 2 }))
      for (let frame = 0; frame < 3; frame++) {
        await result.renderOnce()
        expect(top()).toEqual(before)
      }
      let reachedCode = false
      for (let step = 0; step < 30; step++) {
        setCommand({ id: ++id, type: "half-page-down" })
        await frames()
        if (top()?.subject.startsWith("code0") && (top()?.column ?? 0) > 0) { reachedCode = true; break }
      }
      expect(reachedCode).toBe(true)
      await resize()
      const leaf = leaves(scrollbox).find((el) => el.y <= scrollbox.viewport.y && el.y + el.height > scrollbox.viewport.y)
      const getter = Object.getOwnPropertyDescriptor(TextBufferRenderable.prototype, "lineInfo")?.get
      if (!leaf || !getter) throw new Error("expected the rendered code leaf")
      let sourceReads = 0
      Object.defineProperty(leaf, "lineInfo", { configurable: true, get() { sourceReads++; return getter.call(leaf) } })
      await frames()
      expect(sourceReads).toBe(0)
    } finally { result.renderer.destroy() }
  })

  it("anchors a newly mounted navigation destination before resizing", async () => {
    const blocks = Array.from({ length: 100 }, (_, i) => textBlock(`reading${i}`, `block${i} ${"longword 界\t ".repeat(55)}`))
    const view = transcriptOf(blocks)
    const { result, scrollbox, setCommand, slot } = await renderWindow(view, 14, 80, "workflow-agent")
    const frames = async () => { for (let frame = 0; frame < 5; frame++) await result.renderOnce() }
    const leaves = (el: Renderable): TextBufferRenderable[] => el instanceof TextBufferRenderable ? [el] : el.getChildren().flatMap(leaves)
    const top = () => {
      const y = scrollbox.viewport.y
      const leaf = leaves(scrollbox).find((el) => el.y <= y && el.y + el.height > y)
      if (!leaf) throw new Error("expected mounted text at the viewport top")
      const visual = y - leaf.y + leaf.scrollY
      const info = leaf.lineInfo
      return { subject: leaf.plainText, source: info.lineSources[visual], column: info.lineStartCols[visual] ?? 0, nextColumn: info.lineSources[visual + 1] === info.lineSources[visual] ? info.lineStartCols[visual + 1] : undefined }
    }
    try {
      await frames()
      setCommand({ id: 1, type: "top" })
      await frames()
      for (let id = 2; id < 33; id++) setCommand({ id, type: "page-down" })
      await frames()
      const before = top()
      expect(before.column).toBeGreaterThan(0)
      const saved = slot.scroll?.textPosition
      for (const width of [40, 80]) {
        result.resize(width, 14)
        await frames()
        const current = top()
        expect(current.subject).toBe(before.subject)
        expect(current.source).toBe(before.source)
        expect(current.column).toBeLessThanOrEqual(before.column)
        expect(current.nextColumn ?? Infinity).toBeGreaterThan(before.column)
        expect(slot.scroll?.textPosition).toEqual(saved)
        if (width === 80) expect(current).toEqual(before)
      }
    } finally { result.renderer.destroy() }
  })

  it("mounts only the hydrated window rows plus two spacers; scrollHeight is total estimated rows", async () => {
    // A mid-transcript window: blocks 140..147 hydrated out of 300 total.
    const blocks = Array.from({ length: 8 }, (_, i) => textBlock(`b${140 + i}`, `row ${140 + i}`))
    const { view } = makeView(snapshot({
      blocks,
      totalBlocks: 300,
      window: windowOf({ startBlockIndex: 140, endBlockIndex: 147, hasBefore: true, hasAfter: true, estimatedRows: 8 }),
    }))
    const { scrollbox, result } = await renderWindow(view)
    try {
      // Frame ticks apply the controller's initial mid-history anchor and let
      // mounted rows measure before the geometry assertions read it.
      const update = scrollFrameHook(scrollbox)
      for (let i = 0; i < 8; i += 1) { update(16); await result.flush(); await new Promise((r) => setTimeout(r, 0)) }
      // Culling is deliberately OFF (see output-window.tsx): culled subtrees
      // skip their update pass and measure short, oscillating the extent on
      // every scroll pass. Virtualization, not culling, bounds the work.
      expect(scrollbox.viewportCulling).toBe(false)
      // Option B: the ScrollBox is a dumb clipping viewport with its sticky
      // bottom-pin suppressed, so OutputWindow is the sole scroll authority.
      expect(scrollbox.stickyScroll).toBe(false)
      // 8 hydrated rows + a small constant of chrome (SessionIntro + 2 spacers +
      // the conditional status/notice nodes). The count tracks the WINDOW, never
      // the 300-block transcript -- the virtualization invariant.
      const children = scrollbox.getChildren()
      expect(children.length).toBeLessThanOrEqual(8 + 8)
      // scrollHeight spans the WHOLE transcript. Unhydrated rows use the TUI
      // DEFAULT_ESTIMATE base, while the mounted window can measure a little
      // shorter or taller; the extent must never collapse to the mounted child
      // count.
      const estimatedTranscriptRows = 300 * DEFAULT_ESTIMATE
      expect(scrollbox.scrollHeight).toBeGreaterThanOrEqual(estimatedTranscriptRows - blocks.length * (DEFAULT_ESTIMATE - 1))
      expect(scrollbox.scrollHeight).toBeLessThan(estimatedTranscriptRows + blocks.length * DEFAULT_ESTIMATE)
      const frame = result.captureCharFrame()
      expect(frame).not.toContain("row 0")
      expect(frame).not.toContain("row 299")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the focused semantic row at the same viewport position across an older-page prepend", async () => {
    // Park mid-transcript at block 140, then prepend an older page (blocks 130..139).
    // DEFAULT_ESTIMATE seeds unknown rows, but mounted rows can measure shorter;
    // the invariant is semantic anchoring around block 140, not monotonic scrollTop.
    const tail = Array.from({ length: 8 }, (_, i) => textBlock(`b${140 + i}`, `row ${140 + i}`))
    const { view, set } = makeView(snapshot({
      blocks: tail,
      totalBlocks: 300,
      window: windowOf({ startBlockIndex: 140, endBlockIndex: 147, hasBefore: true, hasAfter: true, estimatedRows: 8 }),
    }))
    const { scrollbox, result } = await renderWindow(view)
    try {
      // The mid-history window opens anchored at its head (block 140); a frame
      // tick applies the controller's initial anchor.
      const update = scrollFrameHook(scrollbox)
      update(16)
      await result.flush()
      // Prepend a 10-block older page (130..139). Measuring those rows can shrink
      // their DEFAULT_ESTIMATE extent, but the viewport must stay in the previously
      // viewed neighborhood instead of jumping to the freshly prepended rows.
      set(snapshot({
        blocks: [...Array.from({ length: 10 }, (_, i) => textBlock(`b${130 + i}`, `row ${130 + i}`)), ...tail],
        totalBlocks: 300,
        window: windowOf({ startBlockIndex: 130, endBlockIndex: 147, hasBefore: true, hasAfter: true, estimatedRows: 18 }),
      }))
      await result.flush()
      update(16)
      await result.flush()
      const frame = result.captureCharFrame()
      expect(frame).not.toContain("row 130")
      expect(frame).toContain("row 140")
    } finally {
      result.renderer.destroy()
    }
  })

  it("captures a user scroll during prepend settle before the next re-anchor", async () => {
    const tail = Array.from({ length: 8 }, (_, i) => textBlock(`b${140 + i}`, `row ${140 + i}`))
    const older = Array.from({ length: 10 }, (_, i) => textBlock(`b${130 + i}`, `row ${130 + i}`))
    const { view, set } = makeView(snapshot({
      blocks: tail,
      totalBlocks: 300,
      window: windowOf({ startBlockIndex: 140, endBlockIndex: 147, hasBefore: true, hasAfter: true, estimatedRows: 8 }),
    }))
    const { scrollbox, result } = await renderWindow(view)
    try {
      const update = scrollFrameHook(scrollbox)
      update(16)
      await result.flush()

      set(snapshot({
        blocks: [...older, ...tail],
        totalBlocks: 300,
        window: windowOf({ startBlockIndex: 130, endBlockIndex: 147, hasBefore: true, hasAfter: true, estimatedRows: 18 }),
      }))
      await result.flush()
      update(16)
      // A wheel input DURING the prepend settle: intent arrives through the
      // input path (ownership inversion) and must survive later re-anchors.
      const beforeWheel = scrollbox.scrollTop
      await result.mockMouse.scroll(2, 2, "down")
      update(16) // wheel input applies on the next frame
      const userTop = scrollbox.scrollTop
      expect(userTop).toBeGreaterThan(beforeWheel)

      set(snapshot({
        blocks: [...older, ...tail],
        totalBlocks: 300,
        window: windowOf({ startBlockIndex: 130, endBlockIndex: 147, hasBefore: true, hasAfter: true, estimatedRows: 18 }),
      }))
      await result.flush()
      update(16)

      expect(scrollbox.scrollTop).toBeGreaterThanOrEqual(userTop)
    } finally {
      result.renderer.destroy()
    }
  })

  it("does not move the viewport when tail content grows while the user is scrolled up", async () => {
    // The Option B anti-jump guarantee: with stickyScroll suppressed, streaming
    // more tail content while the user is scrolled up must NOT snap the viewport to
    // the bottom. The user's anchored row holds; the new rows are not revealed.
    // A mid-transcript tail window (startBlockIndex > 0, hasAfter false) so the
    // SessionIntro does not render and skew offsets.
    const tail = Array.from({ length: 20 }, (_, i) => textBlock(`b${40 + i}`, `row ${40 + i}`))
    const { view, set } = makeView(snapshot({
      blocks: tail,
      totalBlocks: 60,
      window: windowOf({ startBlockIndex: 40, endBlockIndex: 59, hasBefore: true, hasAfter: false, estimatedRows: 20 }),
    }))
    const { scrollbox, result } = await renderWindow(view, 8)
    try {
      const update = scrollFrameHook(scrollbox)
      // A real wheel input disarms follow; a raw position inside the hydrated
      // window is then captured as user movement and anchored. The old one-row
      // fixture used 42; under the TUI DEFAULT_ESTIMATE model the same semantic
      // spot is two rows into block 40's estimated offset.
      await result.mockMouse.scroll(2, 2, "up")
      scrollbox.scrollTop = 40 * DEFAULT_ESTIMATE + 2
      update(16)
      await result.flush()
      const before = scrollbox.scrollTop
      // We are genuinely scrolled up: there is unseen content below the viewport.
      expect(before).toBeLessThan(scrollbox.scrollHeight - scrollbox.viewport.height)
      // Stream 10 more blocks onto the tail.
      set(snapshot({
        blocks: [...tail, ...Array.from({ length: 10 }, (_, i) => textBlock(`b${60 + i}`, `row ${60 + i}`))],
        totalBlocks: 70,
        window: windowOf({ startBlockIndex: 40, endBlockIndex: 69, hasBefore: true, hasAfter: false, estimatedRows: 30 }),
      }))
      await result.flush()
      // The viewport held where the user left it -- no snap-to-bottom. It stays
      // within a row of the anchored position (the height index rebuilds when
      // totalBlocks changes, so the anchor re-resolves to within ~1 row) and nowhere
      // near the new bottom, and the freshly streamed tail rows are not revealed.
      expect(Math.abs(scrollbox.scrollTop - before)).toBeLessThanOrEqual(1)
      expect(scrollbox.scrollTop).toBeLessThan(scrollbox.scrollHeight - scrollbox.viewport.height)
      expect(result.captureCharFrame()).not.toContain("row 69")
    } finally {
      result.renderer.destroy()
    }
  })

  it("recomputes the window projection in O(window), not O(transcript)", () => {
    // 80-block window inside a 100k-block transcript. The projection must iterate
    // the window, never the 100k transcript.
    const blocks = Array.from({ length: 80 }, (_, i) => textBlock(`b${i}`, `line ${i}`))
    let reads = 0
    const counted: readonly FrontendOutputBlock[] = new Proxy(blocks, {
      get(target, prop, receiver) {
        if (prop === "length") reads += 0 // length reads are O(1), not iteration
        if (typeof prop === "string" && /^\d+$/.test(prop)) reads += 1
        // oxlint-disable-next-line anti-slop/no-reflect-get -- boundary: a Proxy trap forwards an arbitrary property key to its target
        return Reflect.get(target, prop, receiver)
      },
    })
    const snap = snapshot({ blocks: counted, totalBlocks: 100_000, window: windowOf({ startBlockIndex: 99_920, endBlockIndex: 99_999, hasBefore: true, estimatedRows: 80 }) })
    const projection = createTranscriptWindowProjector()(snap, false)
    expect(projection.timelineBlocks.length).toBe(80)
    // Indexed element reads stay within a small constant multiple of the window,
    // never approaching 100k.
    expect(reads).toBeLessThan(80 * 6)
  })

  it("keeps timeline source indices aligned through grouping and hidden thinking", () => {
    const blocks: FrontendOutputBlock[] = [
      { kind: "tool", id: "read-1", name: "read", action: "file_read", presentation: { name: "Read", detail: "read" }, status: "completed", timestamp: 1 },
      { kind: "tool", id: "search-1", name: "search", action: "search", presentation: { name: "Search", detail: "search" }, status: "completed", timestamp: 2 },
      { kind: "thinking", id: "thinking:1", content: "hidden", status: "completed", timestamp: 3 },
      textBlock("b23", "done"),
    ]
    const snap = snapshot({ blocks, totalBlocks: 100, window: windowOf({ startBlockIndex: 20, endBlockIndex: 23, hasBefore: true, hasAfter: true, estimatedRows: 4 }) })
    const projection = createTranscriptWindowProjector()(snap, false)

    expect(projection.timelineBlocks.map((b) => b.kind)).toEqual(["toolRun", "text"])
    expect(projection.timelineBlockIndices).toEqual([20, 23])
    expect(projection.zeroHeightBlockIndices).toEqual([21, 22])
  })

  it("drag-selects across mounted window rows but cannot start spanning spacer to spacer", async () => {
    const blocks = Array.from({ length: 6 }, (_, i) => textBlock(`b${140 + i}`, `selectable ${140 + i}`))
    const { view } = makeView(snapshot({
      blocks,
      totalBlocks: 300,
      window: windowOf({ startBlockIndex: 140, endBlockIndex: 145, hasBefore: true, hasAfter: true, estimatedRows: 6 }),
    }))
    const { scrollbox, result } = await renderWindow(view, 6)
    try {
      // The mid-history window (hasAfter) opens anchored at its first block, so
      // the mounted rows sit at the viewport top without any raw scrollTop
      // write; a frame tick applies the controller's initial anchor.
      const update = scrollFrameHook(scrollbox)
      update(16)
      await result.flush()
      // Drag from column 2 (past the left gutter inset) across the mounted rows.
      // Selection spans only the hydrated window -- the spacer gaps are
      // selectable={false}, so a drag cannot smear block 0 onto block 299.
      await result.mockMouse.drag(2, 0, 30, 5)
      const selected = result.renderer.getSelection()?.getSelectedText() ?? ""
      expect(selected).toContain("selectable 14")
      expect(selected).not.toContain("row 0")
      expect(selected).not.toContain("row 299")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders a hydrated block even when its content exceeds the old inline byte budget", async () => {
    const { view } = makeView(snapshot({
      blocks: [textBlock("big", `visible oversized block\n${"x".repeat(200_000)}`)],
      totalBlocks: 300,
      window: windowOf({ startBlockIndex: 150, endBlockIndex: 150, hasBefore: true, hasAfter: true, contentBytes: 200_000 }),
    }))
    const { scrollbox, result } = await renderWindow(view)
    try {
      // A frame tick applies the controller's initial mid-history anchor (the
      // window's first block) before the frame is captured.
      const update = scrollFrameHook(scrollbox)
      update(16)
      await result.flush()
      const frame = result.captureCharFrame()
      expect(frame).toContain("visible oversized block")
      expect(frame.toLowerCase()).not.toContain("too large")
    } finally {
      result.renderer.destroy()
    }
  })

  it("preserves blockId-keyed expansion across an older-page prepend and a token bump", async () => {
    // Expansion lives in the transcript view, keyed by blockId -- not in component
    // state -- so a prepend (which shifts every row's position) and a token
    // bump (new token, same blockId) both leave an open tool group open. The
    // per-row expansion lookup keys off the CURRENT block's id, so a position-reused
    // row never leaks one block's expansion onto another.
    const tail = [
      { kind: "agentGroup", containerKind: "subagent", id: "tg1", toolUseId: "tg1", totalToolCount: 0, label: "Agent", description: "", status: "completed", children: [], timestamp: 1 } satisfies FrontendOutputBlock,
      textBlock("b99", "tail text"),
    ]
    const { view, set } = makeView(snapshot({ blocks: tail, totalBlocks: 100, window: windowOf({ startBlockIndex: 98, endBlockIndex: 99, hasBefore: true }) }))
    view.setDisclosure("tool:tg1", true)
    const { result } = await renderWindow(view)
    try {
      expect(view.disclosure("tool:tg1")).toBe(true)
      // Prepend an older block: every existing row shifts down one position.
      set(snapshot({ blocks: [textBlock("b97", "older"), ...tail], totalBlocks: 100, window: windowOf({ startBlockIndex: 97, endBlockIndex: 99, hasBefore: true }) }))
      await result.flush()
      expect(view.disclosure("tool:tg1")).toBe(true)
      expect(result.captureCharFrame()).toContain("Agent")
      // A genuine token bump: a NEW consistency token (which rebuilds the height
      // index) carrying the same block ids. The blockId-keyed expansion survives.
      set(snapshot({ blocks: tail, totalBlocks: 100, consistencyToken: "g2", window: windowOf({ startBlockIndex: 98, endBlockIndex: 99, hasBefore: true }) }))
      await result.flush()
      expect(view.disclosure("tool:tg1")).toBe(true)
      expect(result.captureCharFrame()).toContain("Agent")
    } finally {
      result.renderer.destroy()
    }
  })

  it("removes the scroll frame hook on unmount", async () => {
    // OutputWindow appends a frame hook node to the scrollbox wrapper. On
    // teardown it must destroy it, so the hook never outlives the component.
    const blocks = Array.from({ length: 4 }, (_, i) => textBlock(`b${i}`, `row ${i}`))
    const { view } = makeView(snapshot({ blocks, totalBlocks: 4, window: windowOf({ endBlockIndex: 3, estimatedRows: 4 }) }))
    const { scrollbox, result } = await renderWindow(view)
    scrollFrameHook(scrollbox)
    const frameHook = scrollbox.wrapper.getChildren().at(-1)
    result.renderer.destroy()
    expect(frameHook?.isDestroyed).toBe(true)
  })

  it("holds the eager mount until hydration reaches the head, then virtualizes", async () => {
    // The latch regression: the 80-block tail seed measures in milliseconds,
    // long before fill pages arrive. Latching on the seed alone virtualized
    // immediately and left every later-hydrated block to measure lazily under
    // the user's scroll -- the upstream correction-hop jitter. The eager mount
    // must hold while hasBefore is true, then collapse to the viewport
    // neighborhood once the head has hydrated and measured.
    const tallBlock = (i: number) => textBlock(`b${i}`, Array.from({ length: 5 }, (_, l) => `filler ${i} line ${l}`).join("\n"))
    const tail = Array.from({ length: 150 }, (_, i) => tallBlock(150 + i))
    const { view, set } = makeView(snapshot({
      blocks: tail,
      totalBlocks: 300,
      window: windowOf({ startBlockIndex: 150, endBlockIndex: 299, hasBefore: true, hasAfter: false, estimatedRows: 750 }),
    }))
    const { scrollbox, result } = await renderWindow(view)
    try {
      const update = scrollFrameHook(scrollbox)
      for (let i = 0; i < 4; i += 1) { update(16); await result.flush(); await new Promise((r) => setTimeout(r, 0)) }
      // Seed fully measured but hasBefore=true: the eager mount HOLDS -- every
      // hydrated row stays mounted (150 rows dwarf the ~56-block virtualized
      // neighborhood at 5 rows/block).
      expect(scrollbox.getChildren().length).toBeGreaterThanOrEqual(150)
      // Head hydration completes: the full transcript arrives in one fill page.
      set(snapshot({
        blocks: [...Array.from({ length: 150 }, (_, i) => tallBlock(i)), ...tail],
        totalBlocks: 300,
        window: windowOf({ startBlockIndex: 0, endBlockIndex: 299, hasBefore: false, hasAfter: false, estimatedRows: 1500 }),
      }))
      await result.flush()
      for (let i = 0; i < 6; i += 1) { update(16); await result.flush(); await new Promise((r) => setTimeout(r, 0)) }
      // All 300 measured -> latch flips -> the window collapses to the viewport
      // neighborhood and stays there.
      expect(scrollbox.getChildren().length).toBeLessThan(120)
    } finally {
      result.renderer.destroy()
    }
  })
})
