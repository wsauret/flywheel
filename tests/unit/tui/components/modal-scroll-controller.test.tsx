/** @jsxImportSource @opentui/solid */
import { afterEach, describe, expect, it } from "bun:test"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { createSignal, For } from "solid-js"
import { testRender } from "@opentui/solid"
import { createModalScrollController } from "../../../../src/tui/components/modal-scroll-controller.js"

const renders: Awaited<ReturnType<typeof testRender>>[] = []
afterEach(() => { for (const render of renders.splice(0)) render.renderer.destroy() })

/** Renders a scrollbox of stacked rows whose viewport height is a signal. */
async function renderRows(rowHeights: readonly number[], viewportHeight: number) {
  const [height, setHeight] = createSignal(viewportHeight)
  const [heights, setHeights] = createSignal(rowHeights)
  const controller = createModalScrollController()
  const rows: BoxRenderable[] = []
  let scroll: ScrollBoxRenderable | undefined
  const render = await testRender(() => (
    <box height={height()} flexDirection="column">
      <scrollbox ref={(element: ScrollBoxRenderable) => { scroll = element; controller.attach(element) }} flexGrow={1} scrollY={true} scrollX={false}>
        <For each={heights()}>{(rowHeight, index) => <box ref={(element: BoxRenderable) => { rows[index()] = element }} height={rowHeight} flexShrink={0} />}</For>
      </scrollbox>
    </box>
  ), { width: 20, height: 20, clock: new ManualClock() })
  renders.push(render)
  const settle = async () => {
    for (let pass = 0; pass < 3; pass++) {
      await new Promise((resolve) => setTimeout(resolve, 0))
      await render.renderOnce()
    }
  }
  await settle()
  const mountedScroll = scroll
  if (!mountedScroll) throw new Error("scrollbox did not mount")
  const scrollTop = () => mountedScroll.scrollTop
  const row = (index: number) => {
    const element = rows[index]
    if (!element) throw new Error(`row ${index} did not mount`)
    return element
  }
  return { controller, row, scrollTop, settle, setHeight, setHeights, render, scroll: mountedScroll }
}

describe("modal scroll controller", () => {
  it("reveals a row exactly as tall as a one-row viewport", async () => {
    const view = await renderRows(Array.from({ length: 8 }, () => 1), 1)
    view.controller.scrollIntoView(view.row(5))
    await view.settle()
    expect(view.scrollTop()).toBe(5)
  })

  it("aligns the bottom of a tall element that starts above the viewport", async () => {
    const view = await renderRows([10, 1, 1, 1, 1, 1], 4)
    view.controller.scrollTo(8)
    await view.settle()
    view.controller.scrollIntoView(view.row(0))
    await view.settle()
    expect(view.scrollTop()).toBe(6)
  })

  it("leaves an element that covers the whole viewport where it is", async () => {
    const view = await renderRows([10, 1, 1], 4)
    view.controller.scrollTo(3)
    await view.settle()
    view.controller.scrollIntoView(view.row(0))
    await view.settle()
    expect(view.scrollTop()).toBe(3)
  })

  it("keeps the first row in view when the revealed element fits below it", async () => {
    const view = await renderRows([3, 1, 1, 1, 1, 1, 1, 1, 1], 6)
    view.controller.scrollTo(2)
    await view.settle()
    view.controller.scrollIntoView(view.row(2), { preferTop: true })
    await view.settle()
    expect(view.scrollTop()).toBe(0)
    view.controller.scrollIntoView(view.row(6), { preferTop: true })
    await view.settle()
    expect(view.scrollTop()).toBe(3)
  })

  it("applies the reveal again when the viewport grows after the first layout", async () => {
    const view = await renderRows([3, 1, 1, 1, 1, 1], 1)
    view.controller.scrollIntoView(view.row(1), { preferTop: true })
    await view.settle()
    expect(view.scrollTop()).toBe(3)
    view.setHeight(6)
    await view.settle()
    expect(view.scrollTop()).toBe(0)
  })

  it.each([
    { destination: 26, expected: 26 },
    { destination: Number.MAX_SAFE_INTEGER, expected: 30 },
  ])("applies row destination $destination before the first paint without following later content growth", async ({ destination, expected }) => {
    const view = await renderRows(Array.from({ length: 14 }, () => 1), 10)
    view.setHeights(Array.from({ length: 40 }, () => 1))
    view.controller.scrollTo(destination)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const painted: number[] = []
    view.render.renderer.on("frame", () => { painted.push(view.scrollTop()) })

    await view.render.renderOnce()

    expect(painted[0]).toBe(expected)

    view.scroll.scrollTo(8)
    view.setHeights(Array.from({ length: 50 }, () => 1))
    await view.render.renderOnce()

    expect(view.scrollTop()).toBe(8)
  })

  it("reveals fresh element geometry in the first paint without following later content growth", async () => {
    const view = await renderRows([3, ...Array.from({ length: 11 }, () => 1)], 10)
    const target = view.row(1)
    view.row(0).height = 35
    view.controller.scrollIntoView(target)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const painted: number[] = []
    view.render.renderer.on("frame", () => { painted.push(view.scrollTop()) })

    await view.render.renderOnce()

    expect(painted[0]).toBe(26)

    view.scroll.scrollTo(8)
    view.row(0).height = 45
    await view.render.renderOnce()

    expect(view.scrollTop()).toBe(8)
  })
})
