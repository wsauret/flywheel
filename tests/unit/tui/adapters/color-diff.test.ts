import { describe, expect, it, spyOn } from "bun:test"
import { RGBA } from "@opentui/core"
import * as diff from "diff"
import { renderHunk } from "../../../../src/tui/adapters/color-diff.js"
import { generateSystemTheme } from "../../../../src/tui/context/theme/system-theme.js"
import { contrastRatio } from "../../../../src/tui/context/theme/color-contrast.js"

const colors = {
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#888888"),
  addedBg: RGBA.fromHex("#003300"),
  removedBg: RGBA.fromHex("#330000"),
  highlightAdded: RGBA.fromHex("#006600"),
  highlightRemoved: RGBA.fromHex("#660000"),
  highlightForeground: null,
  addedFg: RGBA.fromHex("#00ff00"),
  removedFg: RGBA.fromHex("#ff0000"),
  lineNumber: RGBA.fromHex("#aaaaaa"),
}

function renderPair(oldText: string, newText: string) {
  const lines = renderHunk({
    oldStart: 42, oldLines: 1, newStart: 73, newLines: 1,
    lines: [`-${oldText}`, `+${newText}`],
  }, colors)
  // The gutter renders apart from the code, so a wrapped code line continues under the code.
  expect(lines.map((line) => [line.gutter, line.segments].map((part) => part.map((segment) => segment.text).join(""))))
    .toEqual([[" 42 -", oldText], [" 73 +", newText]])
  expect(lines.map((line) => line.lineBg)).toEqual([colors.removedBg, colors.addedBg])
  for (const [index, foreground] of [colors.removedFg, colors.addedFg].entries()) {
    expect(lines[index]?.gutter.map((segment) => segment.fg)).toEqual([foreground, foreground])
    expect(lines[index]?.segments.every((segment) => segment.fg === colors.text)).toBe(true)
  }
  return lines.map((line) => line.segments.filter((segment) => segment.bg !== undefined).map((segment) => ({
    text: segment.text, bg: segment.bg,
  })))
}

describe("intraline decoration budgets", () => {
  it("keeps small word edits emphasized", () => {
    expect(renderPair("const value = oldName;", "const value = newName;")).toEqual([
      [{ text: "oldName", bg: colors.highlightRemoved }],
      [{ text: "newName", bg: colors.highlightAdded }],
    ])
    const { theme } = generateSystemTheme({ background: { r: 48, g: 52, b: 70 }, foreground: { r: 198, g: 208, b: 245 } })
    const lines = renderHunk({
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
      lines: ["-const value = oldName;", "+const value = newName;"],
    }, {
      text: theme.text, textMuted: theme.textMuted,
      addedBg: theme.diffAddedBg, removedBg: theme.diffRemovedBg,
      highlightAdded: theme.diffHighlightAdded, highlightRemoved: theme.diffHighlightRemoved,
      highlightForeground: theme.background,
      addedFg: theme.diffAdded, removedFg: theme.diffRemoved, lineNumber: theme.diffLineNumber,
    })
    const words = lines.flatMap(line => line.segments.filter(segment => segment.bg !== undefined))
    expect(words.map(segment => segment.text)).toEqual(["oldName", "newName"])
    for (const word of words) {
      expect(word.fg).toEqual(theme.background)
      if (!word.fg || !word.bg) throw new Error("changed words must include both colors")
      expect(contrastRatio(word.fg, word.bg)).toBeGreaterThanOrEqual(4.5)
    }
  })

  it("retains the character-change threshold after a successful search", () => {
    expect(renderPair("abcdefghij", "klmnopqrst")).toEqual([[], []])
  })

  it("admits exactly 2048 tokens with a bounded search", () => {
    const search = spyOn(diff, "diffArrays")
    try {
      const common = "~".repeat(1023)
      expect(renderPair(`${common}!`, `${common}?`)).toEqual([
        [{ text: "!", bg: colors.highlightRemoved }],
        [{ text: "?", bg: colors.highlightAdded }],
      ])
      expect(search).toHaveBeenCalledTimes(1)
      expect(search).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), { maxEditLength: 128 })
    } finally {
      search.mockRestore()
    }
  })

  it("skips search above 2048 tokens without losing line content or colors", () => {
    const search = spyOn(diff, "diffArrays")
    try {
      const common = "~".repeat(1023)
      expect(renderPair(`${common}!`, `${common}??`)).toEqual([[], []])
      expect(renderPair(`${"x;".repeat(7450)}a!`, `${"x;".repeat(7450)}b?`)).toEqual([[], []])
      expect(search).not.toHaveBeenCalled()
    } finally {
      search.mockRestore()
    }
  })

  it("falls back when edit distance exceeds 128 even below the character threshold", () => {
    const search = spyOn(diff, "diffArrays")
    try {
      const common = "unchanged".repeat(100)
      expect(renderPair(`${common}${"!".repeat(65)}`, `${common}${"?".repeat(65)}`)).toEqual([[], []])
      expect(search).toHaveBeenCalledTimes(1)
      expect(search).toHaveBeenCalledWith(expect.any(Array), expect.any(Array), { maxEditLength: 128 })
      expect(search.mock.results[0]?.value).toBeUndefined()
    } finally {
      search.mockRestore()
    }
  })
})
