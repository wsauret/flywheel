import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { blockIdentity } from "../../../src/protocol/block-identity.js"
import { foldTranscript } from "../../../src/protocol/client/transcript-model.js"
import { presentWebTranscript, rowIdentity, type TranscriptViewRow } from "../client/tool-runs.js"
import { createBlockLanding, followTranscriptLayout, publishPaneHeight } from "./transcript-scroll.js"
import { mountToolGroup } from "./render-ownership-loader-fixture.js"

const css = await Bun.file(new URL("../styles/transcript.css", import.meta.url)).text()

describe("transcript scroll clearance", () => {
  test("a question tap returns an already open transcript to newest output once per tap", async () => {
    const mounted = mountToolGroup([{ kind: "text", id: "output", timestamp: 0, content: "Output" }])
    try {
      await Promise.resolve()
      const viewport = mounted.viewport()
      assert.ok(viewport)
      viewport.scrollHeight = 1400
      viewport.scrollTop = 100
      mounted.attend()
      await Promise.resolve()
      assert.equal(viewport.scrollTop, 1400)
      assert.equal(mounted.jumps(), 1)
      mounted.publish({ sessionId: "another-chat" })
      mounted.publish({ sessionId: "render-ownership" })
      await Promise.resolve()
      assert.equal(mounted.jumps(), 1)
      viewport.scrollTop = 200
      mounted.attend()
      await Promise.resolve()
      assert.equal(viewport.scrollTop, 1400)
      assert.equal(mounted.jumps(), 2)
    } finally { mounted.dispose() }
  })
  test("layout resizing follows the tail, and holds the reader's row instead while not following", () => {
    const original = globalThis.ResizeObserver
    let resize = () => {}
    let disconnected = false
    const observed: Element[] = []
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resize = () => callback([], this) }
      observe(target: Element) { observed.push(target) }
      unobserve() {}
      disconnect() { disconnected = true }
    }
    try {
      let following = true
      let scrollHeight = 1200
      const scrolls: ScrollToOptions[] = []
      const scrolling: Pick<HTMLElement, "scrollHeight" | "scrollTo"> = {
        get scrollHeight() { return scrollHeight },
        scrollTo(options?: ScrollToOptions | number) {
          assert.ok(typeof options === "object")
          scrolls.push(options)
        },
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: followTranscriptLayout hands the viewport to ResizeObserver.observe, which requires a full Element, and bun test has no DOM.
      const viewport = scrolling as HTMLElement
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: followTranscriptLayout hands the content to ResizeObserver.observe, which requires a full Element; the fake observer records only its identity.
      const content = {} as HTMLElement
      let holds = 0
      const dispose = followTranscriptLayout(viewport, content, () => following, () => { holds += 1 })
      assert.deepEqual(observed, [viewport, content])
      resize()
      assert.deepEqual(scrolls, [{ top: 1200, behavior: "instant" }])
      scrollHeight = 1500
      resize()
      assert.deepEqual(scrolls.at(-1), { top: 1500, behavior: "instant" })
      scrollHeight = 1350
      resize()
      assert.deepEqual(scrolls.at(-1), { top: 1350, behavior: "instant" })
      assert.equal(holds, 0, "a pinned tail has no reader row to hold")
      following = false
      scrollHeight = 1400
      resize()
      assert.equal(scrolls.length, 3, "a reader away from the tail is not pinned to it")
      assert.equal(holds, 1, "a reader away from the tail keeps their row through the resize")
      dispose()
      assert.equal(disconnected, true)
    } finally {
      globalThis.ResizeObserver = original
    }
  })

  test("a floating element publishes to its shared pane rather than its wrapper and withdraws on dispose", () => {
    const original = globalThis.ResizeObserver
    let resize = () => {}
    let disconnected = false
    globalThis.ResizeObserver = class implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) { resize = () => callback([], this) }
      observe() {}
      unobserve() {}
      disconnect() { disconnected = true }
    }
    try {
      let offsetHeight = 120
      const properties = new Map<string, string>()
      const pane = { style: { setProperty: (name: string, value: string) => { properties.set(name, value) }, removeProperty: (name: string) => { properties.delete(name); return "" } } }
      const wrapperProperties = new Map<string, string>()
      const wrapper = { style: { setProperty: (name: string, value: string) => { wrapperProperties.set(name, value) }, removeProperty: (name: string) => { wrapperProperties.delete(name); return "" } } }
      // oxlint-disable-next-line typescript/consistent-type-assertions, anti-slop/no-chained-type-assertions -- boundary: publishPaneHeight hands the element to ResizeObserver.observe, which requires a full Element, and bun test has no DOM; the stand-in supplies native height and ancestor lookup.
      const element = { get offsetHeight() { return offsetHeight }, parentElement: wrapper, closest: () => pane } as unknown as HTMLElement
      const dispose = publishPaneHeight(element, "--fw-find-hits-height")
      assert.equal(properties.get("--fw-find-hits-height"), "120px")
      assert.equal(wrapperProperties.size, 0)
      offsetHeight = 360
      resize()
      assert.equal(properties.get("--fw-find-hits-height"), "360px")
      offsetHeight = 90
      resize()
      assert.equal(properties.get("--fw-find-hits-height"), "90px")
      dispose()
      assert.equal(disconnected, true)
      assert.equal(properties.has("--fw-find-hits-height"), false)
    } finally {
      globalThis.ResizeObserver = original
    }
  })

  test("the return control is a centered content pill bounded by the pane", () => {
    assert.match(css, /\.jump-latest\s*\{[^}]*left:\s*50%;[^}]*transform:\s*translateX\(-50%\);[^}]*max-width:\s*calc\(100% - \(2 \* var\(--fw-s3\)\)\);[^}]*width:\s*max-content;[^}]*\}/s)
    assert.match(css, /\.jump-latest:hover\s*\{[^}]*background:/s)
    assert.match(css, /@media \(pointer:\s*coarse\)\s*\{[^}]*\.jump-latest\s*\{[^}]*min-height:\s*calc\(2 \* var\(--fw-s5\)\);/s)
  })
})

describe("transcript opening", () => {
  test("the loading screen covers the whole pane, the gutters around the composer included", () => {
    const opening = css.match(/\.transcript-opening\s*\{([^}]*)\}/)?.[1] ?? ""
    assert.match(opening, /inset:\s*0;/)
    // The composer's own height stays clear, so the stage centres above it;
    // the composer is a later sibling and paints over the covered gutters.
    assert.match(opening, /padding-bottom:\s*var\(--fw-composer-height, 0px\);/)
  })
})

describe("landing on a marked block", () => {
  const command = (id: string, timestamp: number): FrontendOutputBlock => ({ kind: "tool", id, name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "sleep 3" }, status: "completed", timestamp })
  const reply = (id: string, timestamp: number): FrontendOutputBlock => ({ kind: "text", id, content: "done", timestamp })
  /** A view whose rendered rows are exactly the presented rows, keyed as the
   *  transcript keys them, and which records each row it brought into view. */
  function view(blocks: readonly FrontendOutputBlock[]) {
    let rows: readonly TranscriptViewRow[] = presentWebTranscript(foldTranscript(blocks, false)).rows
    const centered: string[] = []
    const landing = createBlockLanding({
      rows: () => rows,
      center: (rowId) => {
        if (!rows.some((row) => rowIdentity(row) === rowId)) return false
        centered.push(rowId)
        return true
      },
    })
    return {
      landing,
      centered,
      render(next: readonly FrontendOutputBlock[]) { rows = presentWebTranscript(foldTranscript(next, false)).rows },
    }
  }

  test("a command lands on the rendered group that holds its card", () => {
    const first = command("b1", 100)
    const second = command("b2", 110)
    const { landing, centered } = view([reply("t0", 50), first, second, reply("t1", 200)])
    // The identity the transcript store answers for the command's entry.
    landing.land(blockIdentity(second))
    assert.deepEqual(centered, ["toolGroup:tool:b1"])
  })

  test("a block outside the loaded window lands once its row renders, and only once", () => {
    const target = reply("old", 10)
    const { landing, centered, render } = view([reply("t9", 900)])
    landing.land(blockIdentity(target))
    assert.deepEqual(centered, [], "the row is not in the document yet")
    render([target, reply("t9", 900)])
    landing.reconcile()
    assert.deepEqual(centered, ["text:old"])
    landing.reconcile()
    assert.deepEqual(centered, ["text:old"], "a later render leaves the reader where the landing put them")
  })

  test("a landing that answers nothing drops the one still waiting", () => {
    const target = reply("old", 10)
    const { landing, centered, render } = view([reply("t9", 900)])
    landing.land(blockIdentity(target))
    landing.land(undefined)
    render([target, reply("t9", 900)])
    landing.reconcile()
    assert.deepEqual(centered, [])
  })

  test("a landing centers its row in the part of the pane that the find hits and the composer leave visible", () => {
    // The landing brings its row into view with scrollIntoView, which
    // centers the row between the scroller's scroll paddings. The find bar
    // keeps its hits open over the top of the pane after a pick, and the
    // composer floats over its bottom, so each pads the scroller by the
    // height that it publishes.
    const transcript = css.match(/\.transcript\s*\{([^}]*)\}/)?.[1] ?? ""
    assert.match(transcript, /scroll-padding-top:\s*var\(--fw-find-hits-height, 0px\);/)
    assert.match(transcript, /scroll-padding-bottom:\s*var\(--fw-composer-height, 0px\);/)
  })
})
