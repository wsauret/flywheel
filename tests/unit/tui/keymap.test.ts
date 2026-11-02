import { describe, expect, it } from "bun:test"
import { createKeymap, DEFAULT_BINDINGS, parseChord } from "../../../src/tui/keymap/keymap.js"

describe("parseChord", () => {
  it("canonicalizes simple and modified chords", () => {
    expect(parseChord("ctrl+o")).toEqual({ ok: true, chord: "ctrl+o" })
    expect(parseChord("pageup")).toEqual({ ok: true, chord: "pageup" })
    expect(parseChord("escape")).toEqual({ ok: true, chord: "escape" })
    expect(parseChord("ctrl+shift+p")).toEqual({ ok: true, chord: "ctrl+shift+p" })
  })

  it("normalizes case, whitespace, and modifier order", () => {
    expect(parseChord(" CTRL + Shift+P ")).toEqual({ ok: true, chord: "ctrl+shift+p" })
    expect(parseChord("shift+ctrl+p")).toEqual({ ok: true, chord: "ctrl+shift+p" })
    expect(parseChord("meta+ctrl+home")).toEqual({ ok: true, chord: "ctrl+meta+home" })
  })

  it("rejects malformed chords with a reason", () => {
    for (const bad of ["", "ctrl+", "ctrl", "ctrl+shift", "a+b", "ctrl+bogus", "ctrl+ctrl+p"]) {
      const result = parseChord(bad)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
    }
  })
})

describe("createKeymap defaults", () => {
  const { keymap, } = createKeymap()

  it("resolves default app chords to command ids", () => {
    expect(keymap.resolve({ name: "p", ctrl: true })).toBe("help")
    expect(keymap.resolve({ name: "n", ctrl: true })).toBe("new")
    expect(keymap.resolve({ name: "s", ctrl: true })).toBe("sessions")
    expect(keymap.resolve({ name: "w", ctrl: true })).toBe("tab.close")
    expect(keymap.resolve({ name: "r", ctrl: true })).toBe("resume")
    expect(keymap.resolve({ name: "o", ctrl: true })).toBeNull()
    expect(keymap.resolve({ name: "pageup" })).toBe("output.page-up")
    expect(keymap.resolve({ name: "pagedown" })).toBe("output.page-down")
    expect(keymap.resolve({ name: "pageup", ctrl: true })).toBe("output.half-page-up")
    expect(keymap.resolve({ name: "pagedown", ctrl: true })).toBe("output.half-page-down")
    expect(keymap.resolve({ name: "home" })).toBe("output.top")
    expect(keymap.resolve({ name: "end" })).toBe("output.bottom")
    expect(keymap.resolve({ name: "1", ctrl: true })).toBe("tab.1")
    expect(keymap.resolve({ name: "9", ctrl: true })).toBe("tab.9")
  })

  it("resolves tab cycling including the shift-tab terminal name", () => {
    expect(keymap.resolve({ name: "tab" })).toBe("tab.next")
    expect(keymap.resolve({ name: "tab", shift: true })).toBe("tab.previous")
    expect(keymap.resolve({ name: "shift-tab" })).toBe("tab.previous")
  })

  it("does not resolve modified variants of unmodified bindings", () => {
    expect(keymap.resolve({ name: "pageup", meta: true })).toBeNull()
    expect(keymap.resolve({ name: "home", ctrl: true })).toBeNull()
    expect(keymap.resolve({ name: "end", meta: true })).toBeNull()
  })

  it("returns null for unbound and empty key events", () => {
    expect(keymap.resolve({ name: "x", ctrl: true })).toBeNull()
    expect(keymap.resolve({ name: "p" })).toBeNull()
    expect(keymap.resolve({ name: "" })).toBeNull()
    expect(keymap.resolve({ name: "escape" })).toBeNull()
  })

  it("reports the default chord for display", () => {
    expect(keymap.chordFor("help")).toBe("ctrl+p")
    expect(keymap.chordFor("sessions")).toBe("ctrl+s")
    expect(keymap.chordFor("tab.previous")).toBe("shift+tab")
  })
})

describe("createKeymap overrides", () => {
  it("remaps a command: new chord resolves, old chord goes inert, display follows", () => {
    const { keymap, issues } = createKeymap({ help: "ctrl+g" })
    expect(issues).toEqual([])
    expect(keymap.resolve({ name: "g", ctrl: true })).toBe("help")
    expect(keymap.resolve({ name: "p", ctrl: true })).toBeNull()
    expect(keymap.chordFor("help")).toBe("ctrl+g")
  })

  it("accepts non-canonical chord spellings in overrides", () => {
    const { keymap, issues } = createKeymap({ help: "Shift+Ctrl+G" })
    expect(issues).toEqual([])
    expect(keymap.resolve({ name: "g", ctrl: true, shift: true })).toBe("help")
    expect(keymap.chordFor("help")).toBe("ctrl+shift+g")
  })

  it("rejects an unknown command id with an actionable issue, keeping other overrides", () => {
    const { keymap, issues } = createKeymap({ palete: "ctrl+g", sessions: "ctrl+e" })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('"palete"')
    expect(issues[0]).toContain("help")
    expect(keymap.resolve({ name: "e", ctrl: true })).toBe("sessions")
  })

  it("rejects an unparseable chord with an actionable issue, keeping the default", () => {
    const { keymap, issues } = createKeymap({ help: "ctrl+bogus" })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain('"ctrl+bogus"')
    expect(keymap.resolve({ name: "p", ctrl: true })).toBe("help")
    expect(keymap.chordFor("help")).toBe("ctrl+p")
  })

  it("rejects an override that collides with another command's chord", () => {
    const { keymap, issues } = createKeymap({ help: "ctrl+s" })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toContain("ctrl+s")
    expect(issues[0]).toContain("sessions")
    expect(keymap.resolve({ name: "s", ctrl: true })).toBe("sessions")
    expect(keymap.resolve({ name: "p", ctrl: true })).toBe("help")
  })

  it("allows swapping two chords via paired overrides", () => {
    const { keymap, issues } = createKeymap({ help: "ctrl+s", sessions: "ctrl+p" })
    expect(issues).toEqual([])
    expect(keymap.resolve({ name: "s", ctrl: true })).toBe("help")
    expect(keymap.resolve({ name: "p", ctrl: true })).toBe("sessions")
  })

  it("keeps chordFor total: every command id always has a chord", () => {
    const { keymap } = createKeymap({ help: "ctrl+s" })
    for (const binding of DEFAULT_BINDINGS) {
      expect(typeof keymap.chordFor(binding.commandId)).toBe("string")
    }
  })
})
