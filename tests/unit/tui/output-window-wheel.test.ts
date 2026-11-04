import { StdinParser, type StdinEvent } from "@opentui/core"
import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { LINE_WHEEL, NOTCH_WHEEL, wheelProfileFor } from "../../../src/tui/output-window/output-window-wheel.js"
import type { TranscriptSnapshot } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"
import { createMountedRowRegistry, type TranscriptLayoutSlot } from "../../../src/tui/output-window/output-window-scroll.js"
import { asScrollBox, fakeScrollBox, type FakeScrollBox, mountController, snapshotFor } from "../../fixtures/output-scroll-harness.js"

describe("wheel coalescing", () => {
  // 200 blocks x 2 rows = 400 content rows; viewport 10 rows => maxScrollTop 390.
  const MAX_TOP = 390

  function wheel(box: FakeScrollBox, direction: "up" | "down", times = 1): void {
    for (let i = 0; i < times; i += 1) box.onMouseEvent?.({ type: "scroll", scroll: { direction, delta: 1 } })
  }

  it("coalesces a between-frames burst and applies it whole on the next frame", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 200))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 400
      box.frame(16) // fresh generation tails to the bottom
      expect(box.scrollTop).toBe(MAX_TOP)

      // A burst of 12 notches (12 rows) between paints: nothing moves inline...
      wheel(box, "up", 12)
      expect(box.scrollTop).toBe(MAX_TOP)
      // ...then the next frame applies the whole backlog at once: position
      // tracks input; the backlog coalesces, it never animates.
      box.frame(16)
      expect(box.scrollTop).toBe(MAX_TOP - 12)
      box.frame(16)
      expect(box.scrollTop).toBe(MAX_TOP - 12) // and stays put off-tail
      dispose()
    })
  })

  it("a direction change nets with the backlog instead of dropping it", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 200))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 400
      box.frame(16)
      controller.page("page-up") // park off-tail so both directions have room
      const parked = box.scrollTop
      wheel(box, "up", 10)
      wheel(box, "down")
      box.frame(16)
      // Every report moves the view: ten rows up and one row down.
      expect(box.scrollTop).toBe(parked - 9)
      box.frame(16)
      expect(box.scrollTop).toBe(parked - 9)
      dispose()
    })
  })

  it("a stalled-frame backlog lands whole on the next frame", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 400))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 800 // maxScrollTop 790
      box.frame(16)
      expect(box.scrollTop).toBe(790)
      wheel(box, "up", 300)
      box.frame(16)
      expect(box.scrollTop).toBe(790 - 300)
      dispose()
    })
  })

  it("an explicit input discards the pending wheel backlog", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 200))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 400
      box.frame(16)
      wheel(box, "up", 20) // 20-row backlog, none applied yet
      controller.page("page-down") // explicit input wins; stale fling dropped
      const landed = box.scrollTop
      for (let i = 0; i < 5; i += 1) box.frame(16)
      expect(box.scrollTop).toBe(landed) // no leftover backlog drags upward
      dispose()
    })
  })
})

describe("notch wheel reports (Windows Terminal)", () => {
  // 400 blocks x 2 rows = 800 content rows; viewport 10 rows => maxScrollTop 790.
  const MAX_TOP = 790
  const UP = "\u001b[<64;5;5M"

  function mountNotch() {
    let clock = 0
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("notch", 400))
    const box = fakeScrollBox()
    createRoot(() => {
      const controller = mountController(slot, snap, { wheel: NOTCH_WHEEL, now: () => clock })
      controller.attach(asScrollBox(box))
    })
    box.scrollHeight = 800
    box.frame(16) // fresh generation tails to the bottom
    return {
      box,
      at: (ms: number) => { clock = ms },
      report: (direction: "up" | "down") => box.onMouseEvent?.({ type: "scroll", scroll: { direction, delta: 1 } }),
      // Frames until the view stops moving; returns how many frames moved it.
      settle: () => {
        let moving = 0
        for (let frame = 0; frame < 50; frame += 1) {
          const before = box.scrollTop
          box.frame(16)
          if (box.scrollTop === before) return moving
          moving += 1
        }
        return moving
      },
    }
  }

  it("selects notch reports on Windows and inside Windows Terminal, line reports elsewhere", () => {
    expect(wheelProfileFor("win32", {})).toBe(NOTCH_WHEEL)
    expect(wheelProfileFor("linux", { WT_SESSION: "8c1e" })).toBe(NOTCH_WHEEL)
    expect(wheelProfileFor("darwin", {})).toBe(LINE_WHEEL)
  })

  it("a slow report moves the three lines of a notch and glides them over two frames", () => {
    const { box, at, report } = mountNotch()
    at(1000)
    report("up")
    box.frame(16)
    expect(box.scrollTop).toBe(MAX_TOP - 2)
    box.frame(16)
    expect(box.scrollTop).toBe(MAX_TOP - 3)
    box.frame(16)
    expect(box.scrollTop).toBe(MAX_TOP - 3)
    for (const ms of [1100, 1200, 1300]) {
      at(ms)
      report("up")
      box.frame(16)
      box.frame(16)
    }
    expect(box.scrollTop).toBe(MAX_TOP - 12)
  })

  it("a fast run of reports accelerates and the glide settles within a few frames of the last report", () => {
    const { box, at, report, settle } = mountNotch()
    for (const [index, ms] of [1000, 1020, 1040, 1060, 1080].entries()) {
      at(ms)
      report("up")
      box.frame(16)
      if (index === 0) expect(box.scrollTop).toBe(MAX_TOP - 2)
    }
    expect(settle()).toBeLessThanOrEqual(8)
    // The notch decay curve at 20 ms: 3, 9, 15, 20, 24 rows.
    expect(box.scrollTop).toBe(MAX_TOP - 71)
  })

  it("a pause or a direction change restarts the streak at three rows", () => {
    const { box, at, report, settle } = mountNotch()
    for (const ms of [1000, 1020, 1040]) { at(ms); report("up") }
    at(1640)
    report("up")
    settle()
    expect(box.scrollTop).toBe(MAX_TOP - (3 + 9 + 15 + 3))
    const parked = box.scrollTop
    for (const [ms, direction] of [[3000, "up"], [3020, "up"], [3040, "down"], [3060, "down"]] as const) { at(ms); report(direction) }
    settle()
    // Up 3 and 9, then down restarts at 3 and accelerates to 9: net zero.
    expect(box.scrollTop).toBe(parked)
  })

  it("a burst of reports in one read moves the view once per report", () => {
    const { box, at, settle } = mountNotch()
    const parser = new StdinParser({ armTimeouts: false })
    parser.push(new TextEncoder().encode(UP.repeat(100)))
    let reports = 0
    at(1000)
    parser.drain((event) => {
      if (event.type !== "mouse" || event.event.type !== "scroll") return
      reports += 1
      box.onMouseEvent?.({ type: "scroll", scroll: event.event.scroll })
    })
    expect(reports).toBe(100)
    settle()
    // The first report of the streak moves three rows; each report that came
    // in the same read moves one more.
    expect(box.scrollTop).toBe(MAX_TOP - 102)
  })

  it("a report split across reads at every byte still moves the view", () => {
    const { box, at, settle } = mountNotch()
    const parser = new StdinParser({ armTimeouts: false })
    let reports = 0
    const forward = (event: StdinEvent): void => {
      if (event.type !== "mouse" || event.event.type !== "scroll") return
      reports += 1
      box.onMouseEvent?.({ type: "scroll", scroll: event.event.scroll })
    }
    at(1000)
    for (const byte of new TextEncoder().encode(UP)) {
      parser.push(Uint8Array.of(byte))
      parser.drain(forward)
    }
    expect(reports).toBe(1)
    settle()
    expect(box.scrollTop).toBe(MAX_TOP - 3)
  })
})

describe("return to latest", () => {
  it("captures departure across remount and clears it before the direct jump", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("return-latest", 200))
    let jumps = 0

    createRoot((dispose) => {
      const controller = mountController(slot, snap, {
        visibleMessageCount: () => 12,
        jumpToLatest: async () => { jumps += 1 },
      })
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 400
      box.frame(16)
      box.onMouseEvent?.({ type: "scroll", scroll: { direction: "up", delta: 1 } })
      box.frame(16)

      expect(controller.returnToLatestBaseline()).toBe(12)
      expect(slot.returnToLatestBaseline).toBe(12)
      dispose()
    })

    createRoot((dispose) => {
      const controller = mountController(slot, snap, {
        visibleMessageCount: () => 13,
        jumpToLatest: async () => { jumps += 1 },
      })
      expect(controller.returnToLatestBaseline()).toBe(12)
      controller.returnToLatest()
      expect(controller.returnToLatestBaseline()).toBeUndefined()
      expect(slot.returnToLatestBaseline).toBeUndefined()
      expect(jumps).toBe(1)
      dispose()
    })
  })
})

describe("thumb honesty", () => {
  it("lands an upstream correction in the same painted frame", () => {
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 400))
    createRoot((dispose) => {
      const controller = mountController(slot, snap)
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))

      // The thumb paints from the offset, so the offset stays truthful: a +100 upstream
      // correction (block 0 estimated 2 rows, measures 102) hops the offset
      // 100 -> 200 in the same painted frame, no deferred settling.
      box.scrollHeight = 800 // 400 blocks x 2 rows; viewport 10 => range 790
      box.frame(16)
      controller.toTop()
      for (let i = 0; i < 10; i += 1) controller.page("page-down") // park at offset 100
      box.frame(16)
      expect(box.scrollTop).toBe(100)
      controller.heightIndex().reportMeasured(0, 102)
      box.frame(16)
      expect(box.scrollTop).toBe(200)
      box.frame(16)
      expect(box.scrollTop).toBe(200) // converged: nothing left to settle
      dispose()
    })
  })
})

describe("createOutputScrollController resize reconciliation work", () => {
  it("resolves the reading anchor in a size callback only when a later layout moved the extent", () => {
    // 20 blocks x 2 estimated rows = 40 content rows; viewport 10 => maxScrollTop 30.
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    const registry = createMountedRowRegistry()
    let resolves = 0
    createRoot((dispose) => {
      const controller = mountController(slot, snap, {
        mountedRows: {
          ...registry,
          layoutRows: (blockIndex) => {
            const top = slot.heightIndex!.index.blockIndexToRowOffset(blockIndex)
            return { top, height: slot.heightIndex!.index.blockIndexToRowOffset(blockIndex + 1) - top }
          },
          captureText: (blockIndex, row) => ({ path: [], sourceLine: row - slot.heightIndex!.index.blockIndexToRowOffset(blockIndex), displayColumn: 0 }),
          resolveText: (blockIndex, position) => {
            resolves += 1
            return slot.heightIndex!.index.blockIndexToRowOffset(blockIndex) + position.sourceLine
          },
        },
      })
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 40
      box.frame(16) // fresh generation tails to the bottom (30)
      controller.page("half-page-up") // off the tail: a source anchor holds the place
      box.frame(16)
      // Size callbacks can run several times in a frame. With the extent
      // unchanged, each one only reasserts the decided offset.
      const resolvesPerFrame = (callbacksPerFrame: number) => {
        const before = resolves
        for (let step = 0; step < 6; step += 1) {
          box.onMouseEvent?.({ type: "scroll", scroll: { direction: "up", delta: 1 } })
          box.frame(16)
          for (let callback = 0; callback < callbacksPerFrame; callback += 1) box.content.emit("resize")
        }
        return (resolves - before) / 6
      }
      const frameOnly = resolvesPerFrame(0)
      expect(resolvesPerFrame(4)).toBe(frameOnly)
      // A later layout round that moved the extent resolves the anchor once.
      const offset = box.scrollTop
      const before = resolves
      box.scrollHeight = 43
      box.content.emit("resize")
      expect(resolves - before).toBe(1)
      expect(box.scrollTop).toBe(offset)
      dispose()
    })
  })
})

describe("createOutputScrollController leading rows", () => {
  it("moves a wheel step onto a margin row by exactly its rows when the intro grows in the same frame", () => {
    // 20 two-row blocks under the intro: each block opens with a margin row, then one text row.
    // Native layout places the intro's new height one frame before its size report reaches the
    // leading rows that the controller reads.
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-leading", 20))
    let nativeLeading = 3
    const top = (blockIndex: number) => nativeLeading + 2 * blockIndex
    createRoot((dispose) => {
      const [leading, setLeading] = createSignal(nativeLeading)
      const controller = mountController(slot, snap, {
        leadingRows: leading,
        mountedRows: {
          ...createMountedRowRegistry(),
          captureText: (blockIndex, row) => row - top(blockIndex) === 1 ? { path: [], sourceLine: 0, displayColumn: 0 } : undefined,
          resolveText: (blockIndex) => top(blockIndex) + 1,
          layoutRows: (blockIndex) => ({ top: top(blockIndex), height: 2 }),
        },
      })
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 43
      box.frame(16)
      controller.page("half-page-up") // the text row of block 12 at the viewport top
      box.frame(16)
      expect(box.scrollTop).toBe(28)
      // One frame: the intro lays out a row taller, and one wheel row lands on block 12's margin row.
      nativeLeading = 4
      box.scrollHeight = 44
      box.onMouseEvent?.({ type: "scroll", scroll: { direction: "up", delta: 1 } })
      box.frame(16)
      expect(box.scrollTop).toBe(28)
      // The next frame: the intro's size report arrives. Its rows already stand under the text.
      setLeading(4)
      box.frame(16)
      expect(box.scrollTop).toBe(28)
      box.frame(16)
      expect(box.scrollTop).toBe(28)
      dispose()
    })
  })
})
