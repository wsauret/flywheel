import { describe, expect, test } from "bun:test"
import { baseSurfacesUseDefaultBackground } from "../../../../src/tui/utils/terminal-capabilities.js"

describe("baseSurfacesUseDefaultBackground", () => {
  test("true only for Terminal.app", () => {
    expect(baseSurfacesUseDefaultBackground({ TERM_PROGRAM: "Apple_Terminal" })).toBe(true)
    expect(baseSurfacesUseDefaultBackground({ TERM_PROGRAM: "WarpTerminal" })).toBe(false)
    expect(baseSurfacesUseDefaultBackground({ TERM_PROGRAM: "iTerm.app" })).toBe(false)
    expect(baseSurfacesUseDefaultBackground({ TERM_PROGRAM: "tmux" })).toBe(false)
    expect(baseSurfacesUseDefaultBackground({})).toBe(false)
  })
})
