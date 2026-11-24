import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { captureReaderAnchor, createOlderPageScroll, createReadingRestore, firstVisibleReaderAnchor, preserveReaderAnchor, settleReaderExpansionMutation, survivingReaderAnchor, type ReaderAnchorRect, type ReaderExpansionState } from "./transcript-scroll.js"

const following: ReaderExpansionState = { pending: false, following: true }

describe("reader expansion scroll ownership", () => {
  test("leaves native scroll movement alone and consumes a real layout correction once", () => {
    const writes: ScrollToOptions[] = []
    const viewport = {
      scrollTop: 6071,
      scrollHeight: 20000,
      clientHeight: 800,
      scrollTo: (options: ScrollToOptions) => { writes.push(options) },
      getBoundingClientRect: () => ({ top: 0 }),
    }
    let rowTop = -5829
    const row = { isConnected: true, getBoundingClientRect: () => ({ top: rowTop }) }
    const anchor = captureReaderAnchor(viewport, row)

    viewport.scrollTop = 6048
    rowTop = -5806
    anchor.reconcile()
    assert.deepEqual(writes, [], "movement between a scroll event and a transcript mutation must not cancel momentum")

    rowTop = -5606
    anchor.reconcile()
    assert.deepEqual(writes, [{ top: 6248, behavior: "instant" }], "content inserted above the row preserves the reader's place")
    viewport.scrollTop = 6248
    rowTop = -5806
    anchor.reconcile()
    assert.equal(writes.length, 1, "the same layout change cannot scroll the reader twice")

    row.isConnected = false
    rowTop = 0
    anchor.reconcile()
    assert.equal(writes.length, 1, "a removed row no longer owns the viewport")
  })

  test("corrects from the reader's position when removed content clamped the scroll offset", () => {
    const writes: ScrollToOptions[] = []
    const viewport = {
      scrollTop: 30400,
      scrollHeight: 32000,
      clientHeight: 800,
      scrollTo: (options: ScrollToOptions) => { writes.push(options) },
      getBoundingClientRect: () => ({ top: 0 }),
    }
    let rowTop = -400
    const row = { isConnected: true, getBoundingClientRect: () => ({ top: rowTop }) }
    const anchor = captureReaderAnchor(viewport, row)

    // Everything above the reader's row is gone, so the browser has already
    // clamped the offset to the new maximum before the mutation is seen.
    viewport.scrollHeight = 2000
    viewport.scrollTop = 1200
    rowTop = -1200
    anchor.reconcile()
    assert.deepEqual(writes, [{ top: 400, behavior: "instant" }], "the reader stays 400px into their row instead of landing on its top")
  })

  test("falls forward and then backward when a Changes anchor disappears", () => {
    const previous = ["a", "b", "c", "d"]
    assert.equal(survivingReaderAnchor(previous, ["a", "c", "d"], "b"), "c")
    assert.equal(survivingReaderAnchor(previous, ["a"], "b"), "a")
    assert.equal(survivingReaderAnchor(previous, [], "b"), undefined)
  })

  test("moves a prepended page above the reader instead of leaving the load trigger active", () => {
    const anchor = firstVisibleReaderAnchor([
      { id: "hidden", top: -80, bottom: -20 },
      { id: "visible", top: 12, bottom: 72 },
      { id: "later", top: 74, bottom: 134 },
    ], 0)
    assert.deepEqual(anchor, { id: "visible", top: 12, bottom: 72 })

    const restored = preserveReaderAnchor(36, 412, anchor?.top ?? 0)
    assert.equal(restored, 436)
    assert.ok(restored > 80, "the reader leaves the automatic paging threshold")
  })

  test("holds one paging operation through tail output and restores after a regrouped prepend", async () => {
    let sessionId = "session-a"
    let blockIds = ["tool:c", "tool:d"]
    let rows: ReaderAnchorRect[] = [
      { id: "toolGroup:tool:c", top: 12, bottom: 72 },
      { id: "text:later", top: 74, bottom: 134 },
    ]
    let scrollTop = 36
    const writes: number[] = []
    let resolve!: (loaded: boolean) => void
    let loads = 0
    let measurements = 0
    const paging = createOlderPageScroll({
      viewport: {
        get scrollTop() { return scrollTop },
        top: () => 0,
        *rows() {
          for (const row of rows) {
            measurements += 1
            yield row
          }
        },
        scrollTo: (top) => {
          writes.push(top)
          const delta = top - scrollTop
          rows = rows.map(row => ({ ...row, top: row.top - delta, bottom: row.bottom - delta }))
          scrollTop = top
        },
      },
      sessionId: () => sessionId,
      blockIds: () => blockIds,
      loadOlder: () => {
        loads += 1
        return new Promise<boolean>((done) => { resolve = done })
      },
    })

    paging.onScroll(true, () => undefined)
    paging.onScroll(true, () => undefined)
    assert.equal(loads, 1)

    blockIds = ["tool:c", "tool:d", "text:new"]
    rows = [...rows, { id: "text:new", top: 136, bottom: 196 }]
    assert.equal(paging.reconcile(), false)
    paging.onScroll(true, () => undefined)
    assert.equal(loads, 1, "live output does not release the older-page operation")
    resolve(true)
    await Promise.resolve()

    scrollTop = 136
    rows = rows.map(row => ({ ...row, top: row.top - 100, bottom: row.bottom - 100 }))
    measurements = 0
    paging.onScroll(false, () => ({ id: "text:later", top: -26, bottom: 34 }))
    assert.equal(measurements, 0, "refresh reuses the scroll's own reader measurement and reads no rows")
    blockIds = ["tool:a", "tool:b", "tool:c", "tool:d", "text:new"]
    rows = [
      { id: "toolGroup:tool:a", top: -100, bottom: 310 },
      { id: "text:later", top: 312, bottom: 372 },
      { id: "text:new", top: 374, bottom: 434 },
    ]
    assert.equal(paging.reconcile(), true)
    assert.equal(scrollTop, 474, "the pending request respects scrolling after it started")

    paging.onScroll(true, () => undefined)
    assert.equal(loads, 2, "the next paging gesture is available")
    let contentTop = scrollTop + 12
    const reader = captureReaderAnchor({
      get scrollTop() { return scrollTop },
      scrollHeight: 10000,
      clientHeight: 800,
      getBoundingClientRect: () => ({ top: 0 }),
      scrollTo: (options) => { writes.push(options.top ?? 0) },
    }, {
      isConnected: true,
      getBoundingClientRect: () => ({ top: contentTop - scrollTop }),
    })
    blockIds = ["text:older", ...blockIds]
    contentTop += 400
    rows = rows.map(row => ({ ...row, top: row.top + 400, bottom: row.bottom + 400 }))
    assert.equal(paging.reconcile(), true, "the pager owns the prepended layout correction")
    reader.rebase()
    reader.reconcile()
    assert.deepEqual(writes, [474, 874], "paging and reader anchoring consume each prepend only once")
    sessionId = "session-b"
  })

  test("releases paging ownership when no older page loads", async () => {
    let resolve!: (loaded: boolean) => void
    let loads = 0
    const paging = createOlderPageScroll({
      viewport: {
        scrollTop: 0,
        top: () => 0,
        rows: () => [{ id: "text:c", top: 0, bottom: 60 }],
        scrollTo: () => undefined,
      },
      sessionId: () => "session-a",
      blockIds: () => ["text:c"],
      loadOlder: () => {
        loads += 1
        return new Promise<boolean>((done) => { resolve = done })
      },
    })

    paging.onScroll(true, () => undefined)
    resolve(false)
    await Promise.resolve()
    paging.onScroll(true, () => undefined)
    assert.equal(loads, 2)
  })

  test("reads a restore's older pages back only as each page renders", async () => {
    // The client paints a committed page a frame after the request settles,
    // so the settlement must not read as the page being on screen.
    const savedIndex = 3
    let rendered = { start: 211, hasBefore: true }
    const requests: ((loaded: boolean) => void)[] = []
    let loads = 0
    let settled = false
    let landed = false
    const restore = createReadingRestore({
      pages: 10,
      window: () => rendered,
      land: () => {
        if (savedIndex < rendered.start) return "before"
        landed = true
        return "landed"
      },
      loadOlder: () => {
        loads += 1
        // The store holds the whole history after two pages and has nothing older to read.
        return loads <= 2 ? new Promise<boolean>((done) => { requests.push(done) }) : Promise.resolve(false)
      },
      retry: () => restore.attempt(),
      settleAtTail: () => { settled = true },
    })
    const settle = async (loaded: boolean) => {
      requests.shift()?.(loaded)
      for (let turn = 0; turn < 40; turn += 1) await Promise.resolve()
    }

    restore.attempt()
    assert.equal(loads, 1)
    await settle(true)
    restore.attempt()
    assert.equal(loads, 1, "a settled page that has not rendered is not read again")

    rendered = { start: 92, hasBefore: true }
    restore.attempt()
    assert.equal(loads, 2, "the rendered page moves the restore one page further back")
    await settle(true)
    restore.attempt()
    assert.equal(settled, false, "the last page's settlement does not send the reader to the tail")
    assert.equal(loads, 2)

    rendered = { start: 0, hasBefore: false }
    restore.attempt()
    assert.equal(landed, true, "the saved place lands once its page renders")
    assert.equal(settled, false)
  })

  test("settles a restore at the tail once a request ends without a page and nothing older remains", async () => {
    let rendered = { start: 40, hasBefore: true }
    let settled = 0
    let loads = 0
    const restore = createReadingRestore({
      pages: 10,
      window: () => rendered,
      land: () => "before",
      loadOlder: async () => {
        loads += 1
        rendered = { start: 40, hasBefore: false }
        return false
      },
      retry: () => restore.attempt(),
      settleAtTail: () => { settled += 1 },
    })
    restore.attempt()
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
    assert.equal(loads, 1)
    assert.equal(settled, 1)
  })

  test("holds position from an incomplete open through hydration and later live growth", () => {
    const opened = settleReaderExpansionMutation(following, { action: "open", pending: true }, true, true)
    assert.deepEqual(opened, { pending: true, following: false, consumed: true })

    const hydrated = settleReaderExpansionMutation(opened, undefined, false, false)
    assert.deepEqual(hydrated, { pending: false, following: false, consumed: true })

    const liveGrowth = settleReaderExpansionMutation(hydrated, undefined, false, false)
    assert.deepEqual(liveGrowth, { pending: false, following: false, consumed: false })
  })

  test("a collapse and Jump to Latest can each restore tail following", () => {
    const pending: ReaderExpansionState = { pending: true, following: false }
    assert.deepEqual(
      settleReaderExpansionMutation(pending, { action: "close" }, false, true),
      { pending: false, following: true, consumed: true },
    )

    const jumped: ReaderExpansionState = { pending: false, following: true }
    assert.deepEqual(
      settleReaderExpansionMutation(jumped, undefined, false, true),
      { pending: false, following: true, consumed: false },
    )
  })

  test("a complete disclosure keeps following when it settles at the tail", () => {
    assert.deepEqual(
      settleReaderExpansionMutation(following, { action: "open", pending: false }, false, true),
      { pending: false, following: true, consumed: true },
    )
  })
})
