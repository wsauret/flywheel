import { afterEach, describe, expect, test } from "bun:test"
import { OptimizedBuffer, ResourceContext, RGBA } from "@opentui/core"

const owners: ResourceContext[] = []
afterEach(() => { for (const owner of owners.splice(0)) owner.destroy() })

function bufferOwner(): ResourceContext {
  const owner = new ResourceContext({ objectCapacity: 4, renderCellsMax: 10 })
  owners.push(owner)
  return owner
}

const RED = RGBA.fromInts(128, 48, 48)
const WHITE = RGBA.fromInts(255, 255, 255)
const TRANSPARENT = RGBA.fromValues(0, 0, 0, 0)

function cell(buffer: OptimizedBuffer, x: number) {
  return buffer.withBuffers(({ char, bg }) => ({ char: String.fromCodePoint(char[x] ?? 0), bgAlpha: bg[x * 4 + 3] }))
}

// OpaqueBox occludes overlays by direct-storing transparent space cells with
// setCell so the cells reach the wire as SGR 49 and macOS Terminal.app keeps
// native-drawing connected box glyphs. These tests pin the buffer semantics
// that mechanism depends on; if an OpenTUI pin bump changes them, occlusion
// silently breaks (drawText/fillRect alpha-blend, so a transparent clear
// through them is a no-op).
describe("OptimizedBuffer transparent-clear semantics", () => {
  test("setCell direct-stores a transparent background over painted cells", () => {
    const buffer = OptimizedBuffer.create(10, 1, "unicode", { owner: bufferOwner() })
    try {
      buffer.drawText("XXXXXXXXXX", 0, 0, WHITE, RED)
      buffer.setCell(4, 0, " ", TRANSPARENT, TRANSPARENT)
      expect(cell(buffer, 4)).toEqual({ char: " ", bgAlpha: 0 })
      expect(cell(buffer, 5)).toEqual({ char: "X", bgAlpha: 255 })
    } finally {
      buffer.destroy()
    }
  })

  test("drawText alpha-blends a transparent background (cannot clear)", () => {
    const buffer = OptimizedBuffer.create(10, 1, "unicode", { owner: bufferOwner() })
    try {
      buffer.drawText("XXXXXXXXXX", 0, 0, WHITE, RED)
      buffer.drawText("  ", 2, 0, TRANSPARENT, TRANSPARENT)
      expect(cell(buffer, 2)).toEqual({ char: "X", bgAlpha: 255 })
    } finally {
      buffer.destroy()
    }
  })

  test("fillRect alpha-blends a transparent background (cannot clear)", () => {
    const buffer = OptimizedBuffer.create(10, 1, "unicode", { owner: bufferOwner() })
    try {
      buffer.drawText("XXXXXXXXXX", 0, 0, WHITE, RED)
      buffer.fillRect(2, 0, 2, 1, TRANSPARENT)
      expect(cell(buffer, 2)).toEqual({ char: "X", bgAlpha: 255 })
    } finally {
      buffer.destroy()
    }
  })
})
