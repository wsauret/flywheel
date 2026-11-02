import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { BoxRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createMeasuredWidth } from "../../../../src/tui/hooks/create-measured-width.js"

describe("createMeasuredWidth", () => {
  it("serves the seed until the element measures, then the measurement wins", async () => {
    const render = await createTestRenderer({ width: 78, height: 2 })
    try {
      await createRoot(async (dispose) => {
        const measured = createMeasuredWidth(() => 80)
        // Pre-mount and mount frame: the seed covers the gap so consumers wrap
        // their final shape immediately instead of rendering blank.
        expect(measured.width()).toBe(80)
        // OpenTUI reports NaN width between layouts; the ref must skip it.
        const box = new BoxRenderable(render.renderer, { height: 1 })
        Object.defineProperty(box, "width", { configurable: true, get: () => Number.NaN })
        measured.ref(box)
        expect(measured.width()).toBe(80)
        Reflect.deleteProperty(box, "width")
        // First real layout: the element measurement becomes the authority,
        // healing any drift between declared chrome and actual JSX.
        render.renderer.root.add(box)
        await render.renderOnce()
        expect(measured.width()).toBe(78)
        dispose()
      })
    } finally {
      render.renderer.destroy()
    }
  })

  it("clamps a negative seed and keeps legacy no-seed behavior", () => {
    createRoot((dispose) => {
      // Seed narrower than the declared chrome (tiny terminal): clamp to 0,
      // which consumers already treat as "width unknown, render blank".
      expect(createMeasuredWidth(() => -3).width()).toBe(0)
      expect(createMeasuredWidth().width()).toBe(0)
      dispose()
    })
  })
})
