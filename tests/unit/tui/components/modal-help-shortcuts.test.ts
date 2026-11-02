import { describe, expect, it } from "bun:test"
import { createKeymap } from "../../../../src/tui/keymap/keymap.js"
import { helpShortcuts } from "../../../../src/tui/components/modal-help-shortcuts.js"

function row(description: string) {
  const { keymap } = createKeymap()
  return helpShortcuts(keymap.chordFor).find(([, value]) => value === description)
}

describe("helpShortcuts text entry rows", () => {
  it("documents prompt movement, deletion, selection, and submission", () => {
    const { keymap } = createKeymap()
    const shortcuts = helpShortcuts(keymap.chordFor)
    const descriptions = shortcuts.map(([, description]) => description)

    for (const expected of [
      "Send prompt",
      "Insert new line",
      "Move one word forward",
      "Move one word backward",
      "Jump to line start",
      "Jump to entry end",
      "Delete previous word",
      "Delete next word",
      "Delete to line start",
      "Delete current line",
      "Select one word forward",
      "Select to entry start",
      "Select to line end",
      "Select all",
      "Clear entry after Select all",
    ]) {
      expect(descriptions).toContain(expected)
    }
  })

  it("keeps opposite editing directions in distinct rows", () => {
    expect(row("Move one character left")?.[0]).toContain("left arrow")
    expect(row("Move one character right")?.[0]).toContain("right arrow")
    expect(row("Delete to line start")?.[0]).toBe("ctrl+u")
    expect(row("Delete to line end")?.[0]).toBe("ctrl+k")
    expect(row("Delete previous word")?.[0]).toContain("ctrl+backspace")
    expect(row("Delete next word")?.[0]).toContain("ctrl+delete")
  })

  it("groups shortcuts by their user-facing context", () => {
    const { keymap } = createKeymap()
    const sections = new Set(helpShortcuts(keymap.chordFor).map((shortcut) => shortcut[2]))

    expect(sections).toEqual(new Set(["Prompt", "Text editing", "Selection", "App navigation"]))
  })

})
