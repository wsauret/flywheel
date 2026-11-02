import { describe, expect, it } from "bun:test"
import { createKeymap } from "../../../../src/tui/keymap/keymap.js"
import { HELP_SHORTCUT_SECTIONS, helpShortcuts } from "../../../../src/tui/components/modal-help-shortcuts.js"

describe("ModalHelp shortcuts", () => {
  it("documents currently wired global and prompt shortcuts under default bindings", () => {
    const { keymap } = createKeymap()
    const labels = helpShortcuts(keymap.chordFor).map(([key]) => key)

    for (const expected of [
      "ctrl+p",
      "ctrl+n",
      "ctrl+s",
      "ctrl+w",
      "tab / shift+tab",
      "ctrl+1 .. ctrl+9",
      "pageup / pagedown",
      "right arrow",
      "esc",
      "/help",
    ]) {
      expect(labels).toContain(expected)
    }
    expect(labels).not.toContain("? (empty prompt)")

    const undo = helpShortcuts(keymap.chordFor).find(([, description]) => description === "Undo text edit")?.[0]
    const redo = helpShortcuts(keymap.chordFor).find(([, description]) => description === "Redo text edit")?.[0]
    expect(undo).toContain("ctrl+z")
    expect(undo).toContain("super+z")
    expect(redo).toContain("ctrl+y")
    expect(redo).toContain("shift+super+z")
  })

  it("renders every row under its section in the established order", () => {
    const { keymap } = createKeymap()
    const shortcuts = helpShortcuts(keymap.chordFor)
    const rendered = HELP_SHORTCUT_SECTIONS.map((section) => [section, shortcuts.filter((shortcut) => shortcut[2] === section).map(([key, label]) => `${key} - ${label}`)])
    expect(rendered).toEqual([
      ["Prompt", [
        "alt+enter / enter - Send prompt",
        "shift+enter / ctrl+enter - Insert new line",
        "esc - Close/cancel/interrupt",
        "up arrow (empty prompt) - Open prompt history",
        "up/down arrows · enter · esc - Navigate prompt lists",
        "tab - Complete slash command",
        "right arrow - Accept ghost text",
        "ctrl+v / super+v - Paste clipboard image",
        "/help - Commands",
      ]],
      ["Text editing", [
        "left arrow / ctrl+b - Move one character left",
        "right arrow / ctrl+f - Move one character right",
        "up arrow - Move one visual line up",
        "down arrow - Move one visual line down",
        "home / super+up arrow - Jump to entry start",
        "end / super+down arrow - Jump to entry end",
        "ctrl+a - Jump to line start",
        "ctrl+e - Jump to line end",
        "alt+a / super+left arrow - Jump to wrapped-line start",
        "alt+e / super+right arrow - Jump to wrapped-line end",
        "ctrl+backspace / alt+backspace - Delete previous word",
        "alt+d / alt+delete / ctrl+delete - Delete next word",
        "ctrl+shift+d - Delete current line",
        "ctrl+k - Delete to line end",
        "ctrl+u - Delete to line start",
        "backspace / shift+backspace - Delete previous character",
        "ctrl+d / delete / shift+delete - Delete next character",
        "ctrl+- / super+z / ctrl+z - Undo text edit",
        "ctrl+. / shift+super+z / ctrl+y / ctrl+shift+z - Redo text edit",
        "alt+f / alt+right arrow / ctrl+right arrow - Move one word forward",
        "alt+b / alt+left arrow / ctrl+left arrow - Move one word backward",
      ]],
      ["Selection", [
        "shift+left arrow - Select one character left",
        "shift+right arrow - Select one character right",
        "shift+up arrow - Select one visual line up",
        "shift+down arrow - Select one visual line down",
        "shift+home / shift+super+up arrow - Select to entry start",
        "shift+end / shift+super+down arrow - Select to entry end",
        "ctrl+shift+e - Select to line end",
        "alt+shift+a / shift+super+left arrow - Select to wrapped-line start",
        "alt+shift+e / shift+super+right arrow - Select to wrapped-line end",
        "alt+shift+f / alt+shift+right arrow - Select one word forward",
        "alt+shift+b / alt+shift+left arrow - Select one word backward",
        "ctrl+shift+a / super+a - Select all",
        "ctrl+shift+a / super+a, then backspace - Clear entry after Select all",
      ]],
      ["App navigation", [
        "ctrl+p - Commands",
        "ctrl+n - New chat",
        "ctrl+s - Sessions",
        "ctrl+w - Close tab",
        "ctrl+r - Resume an interrupted session",
        "tab / shift+tab - Cycle sessions",
        "ctrl+1 .. ctrl+9 - Activate tab",
        "pageup / pagedown - Scroll output",
        "ctrl+pageup / ctrl+pagedown - Scroll half page",
        "home / end - Jump to top / bottom",
      ]],
    ])
  })

  it("renders the effective chord after a remap", () => {
    const { keymap } = createKeymap({ help: "ctrl+g" })
    const labels = helpShortcuts(keymap.chordFor).map(([key]) => key)

    expect(labels).toContain("ctrl+g")
    expect(labels).not.toContain("ctrl+p")
  })
})
