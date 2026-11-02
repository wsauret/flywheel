import { describe, expect, test } from "bun:test"

import { chordFor, modKeyLabel, SHORTCUTS } from "../../../webview/src/app/shortcuts.js"

const event = (overrides: Partial<Parameters<typeof chordFor>[0]>) =>
  ({ key: "k", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides })

describe("keyboard shortcuts", () => {
  test("every chord is listed once and every listed chord is a Mod chord", () => {
    const chords = SHORTCUTS.filter((shortcut) => shortcut.chord !== undefined)
    expect(new Set(chords.map((shortcut) => shortcut.chord)).size).toBe(chords.length)
    expect(chords.every((shortcut) => shortcut.keys[0] === "Mod" && shortcut.keys.length === 2)).toBe(true)
  })

  test("answers the command key plus one key and nothing near it", () => {
    expect(chordFor(event({ metaKey: true }))?.label).toBe("Switch session")
    expect(chordFor(event({ ctrlKey: true, key: "B" }))?.label).toBe("Show or hide the session list")
    expect(chordFor(event({ metaKey: true, key: "/" }))?.label).toBe("Show keyboard shortcuts")
    expect(chordFor(event({}))).toBeUndefined()
    expect(chordFor(event({ metaKey: true, shiftKey: true }))).toBeUndefined()
    expect(chordFor(event({ metaKey: true, altKey: true }))).toBeUndefined()
    expect(chordFor(event({ metaKey: true, ctrlKey: true }))).toBeUndefined()
    expect(chordFor(event({ metaKey: true, key: "z" }))).toBeUndefined()
  })

  test("names the command key for the keyboard in use", () => {
    expect(modKeyLabel("MacIntel")).toBe("⌘")
    expect(modKeyLabel("iPhone")).toBe("⌘")
    expect(modKeyLabel("Win32")).toBe("Ctrl")
    expect(modKeyLabel("Linux x86_64")).toBe("Ctrl")
  })
})
