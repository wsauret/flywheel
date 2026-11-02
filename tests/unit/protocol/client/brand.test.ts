import { describe, expect, test } from "bun:test"

import { brandTileSvg, FLYWHEEL_MARK_PATHS, flywheelMarkSvg } from "../../../../src/protocol/client/brand.js"

describe("the brand drawing", () => {
  test("the glyph and the tile draw the same mark", () => {
    const glyph = flywheelMarkSvg()
    const tile = brandTileSvg(180)
    expect(glyph).toContain(FLYWHEEL_MARK_PATHS)
    for (const path of FLYWHEEL_MARK_PATHS.split("\n").filter((line) => line.startsWith("<path"))) expect(tile).toContain(path)
  })

  test("the tile is sized as asked and rounds its corners only when told to", () => {
    expect(brandTileSvg(512)).toContain('width="512" height="512"')
    expect(brandTileSvg(512)).not.toContain('clip-path="url(#corners)"')
    expect(brandTileSvg(128, { corners: "rounded" })).toContain('clip-path="url(#corners)"')
  })

})
