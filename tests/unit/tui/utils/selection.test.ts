import { describe, it, expect } from "bun:test"
import { BoxRenderable, TextRenderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { consumeSelectedText } from "../../../../src/tui/utils/selection.js"

describe("consumeSelectedText", () => {
  it("returns selected text and clears the selection", () => {
    let cleared = false
    const text = consumeSelectedText({
      getSelection: () => ({ anchor: { x: 0, y: 0 }, focus: { x: 20, y: 0 }, selectedRenderables: [{ x: 0, y: 0, width: 20, isDestroyed: false, getSelectedText: () => "copied text" }] }),
      clearSelection: () => { cleared = true },
    })

    expect(text).toBe("copied text")
    expect(cleared).toBe(true)
  })

  it("clears empty selections without attempting to copy", () => {
    let cleared = false
    const text = consumeSelectedText({
      getSelection: () => ({ anchor: { x: 0, y: 0 }, focus: { x: 20, y: 0 }, selectedRenderables: [{ x: 0, y: 0, width: 20, isDestroyed: false, getSelectedText: () => "" }] }),
      clearSelection: () => { cleared = true },
    })

    expect(text).toBeNull()
    expect(cleared).toBe(true)
  })

  it.each([null, { anchor: { x: 2, y: 0 }, focus: { x: 2, y: 0 }, selectedRenderables: [] }])("keeps an empty click selection so the next click can select a word: %j", (selection) => {
    let cleared = false
    const text = consumeSelectedText({
      getSelection: () => selection,
      clearSelection: () => { cleared = true },
    })

    expect(text).toBeNull()
    expect(cleared).toBe(false)
  })

  it("copies a double-click word through mouse-up and clears its selection", async () => {
    const render = await testRender(() => null, { width: 24, height: 2 })
    const copied: string[] = []
    try {
      const box = new BoxRenderable(render.renderer, {
        width: 24, height: 2,
        onMouseUp: () => {
          const text = consumeSelectedText(render.renderer)
          if (text !== null) copied.push(text)
        },
      })
      box.add(new TextRenderable(render.renderer, { content: "hello world foobar", selectable: true }))
      render.renderer.root.add(box)
      await render.renderOnce()
      await render.mockMouse.doubleClick(8, 0)
      expect(copied).toEqual(["world"])
      expect(render.renderer.getSelection()).toBeNull()
    } finally {
      render.renderer.destroy()
      await render.renderer.closed
    }
  })
})
