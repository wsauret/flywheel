import { describe, expect, it } from "bun:test"
import { createComponent, createMemo, createRoot, createSignal } from "solid-js"
import { createKeymap, DEFAULT_BINDINGS } from "../../../src/tui/keymap/keymap.js"
import { createToastPresenter } from "../../../src/tui/utils/toast-presenter.js"
import type { RuntimeConfigView } from "../../../src/protocol/runtime-config-protocol-types.js"
import { configView } from "../../helpers/runtime-views.js"

const { KeymapProvider, presentKeymapIssues, useKeymap } = await import("../../../src/tui/context/keymap.js")

/** The chord a single accepted override gives its command. */
function overrideChord(spec: string, commandId: (typeof DEFAULT_BINDINGS)[number]["commandId"] = "help"): string {
  const { keymap, issues } = createKeymap({ [commandId]: spec })
  expect(issues).toEqual([])
  return keymap.chordFor(commandId)
}

describe("override chord parsing", () => {
  it("canonicalizes simple and modified chords", () => {
    expect(overrideChord("ctrl+o")).toBe("ctrl+o")
    expect(overrideChord("pageup", "output.page-up")).toBe("pageup")
    expect(overrideChord("escape")).toBe("escape")
    expect(overrideChord("ctrl+shift+p")).toBe("ctrl+shift+p")
  })

  it("normalizes case, whitespace, and modifier order", () => {
    expect(overrideChord(" CTRL + Shift+P ")).toBe("ctrl+shift+p")
    expect(overrideChord("shift+ctrl+p")).toBe("ctrl+shift+p")
    expect(overrideChord("meta+ctrl+home")).toBe("ctrl+meta+home")
  })

  it("rejects malformed chords with a reason and keeps the default", () => {
    for (const bad of ["", "ctrl+", "ctrl", "ctrl+shift", "a+b", "ctrl+bogus", "ctrl+ctrl+p"]) {
      const { keymap, issues } = createKeymap({ help: bad })
      expect(issues).toHaveLength(1)
      const prefix = `Ignoring [keybindings] entry help = "${bad}": `
      expect(issues[0]).toStartWith(prefix)
      // A non-empty parse reason sits between the prefix and the ". " before the usage hint.
      expect(issues[0]!.slice(prefix.length)).toMatch(/^[^.]+\. /)
      expect(keymap.chordFor("help")).toBe("ctrl+p")
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

describe("KeymapProvider config publications", () => {
  function mountKeymap(initial: RuntimeConfigView | undefined) {
    const [config, publish] = createSignal(initial)
    const toasts: string[] = []
    const presenter = createToastPresenter((toast) => { toasts.push(toast.message) })
    let helpChordComputations = 0
    let helpChord!: () => string
    const dispose = createRoot((disposeRoot) => {
      createComponent(KeymapProvider, {
        config,
        get children() {
          const { keymap } = useKeymap()
          helpChord = createMemo(() => { helpChordComputations += 1; return keymap.chordFor("help") })
          presentKeymapIssues(presenter)
          return undefined
        },
      })
      return disposeRoot
    })
    return { publish, toasts, presenter, helpChord, helpChordComputations: () => helpChordComputations, dispose }
  }

  it("a theme-only publication leaves the keymap as it was, and a keybinding change rebuilds it", () => {
    const shell = mountKeymap(configView({ keybindings: { help: "ctrl+g" } }))
    try {
      expect(shell.helpChord()).toBe("ctrl+g")
      const computations = shell.helpChordComputations()
      shell.publish(configView({ keybindings: { help: "ctrl+g" }, writeSyntaxTheme: "slate" }))
      expect(shell.helpChordComputations()).toBe(computations)
      shell.publish(configView({ keybindings: { help: "ctrl+e" } }))
      expect(shell.helpChord()).toBe("ctrl+e")
      expect(shell.helpChordComputations()).toBe(computations + 1)
    } finally { shell.dispose() }
  })

  it("shows an invalid override that arrives after startup once, and a repeat publication of it never", () => {
    const shell = mountKeymap(undefined)
    try {
      expect(shell.toasts).toEqual([])
      shell.publish(configView({ keybindings: { help: "ctrl+bogus" } }))
      expect(shell.toasts).toHaveLength(1)
      expect(shell.toasts[0]).toContain('"ctrl+bogus"')
      shell.publish(configView({ keybindings: { help: "ctrl+bogus" } }))
      shell.publish(configView({ keybindings: { help: "ctrl+bogus" }, showThinking: false }))
      expect(shell.toasts).toHaveLength(1)
    } finally { shell.dispose() }
  })

  it("shows two invalid overrides once each, and an unrelated publication after another config toast shows neither again", () => {
    const shell = mountKeymap(configView({ keybindings: { palete: "ctrl+g", help: "ctrl+bogus" } }))
    try {
      expect(shell.toasts).toHaveLength(2)
      // Another fact in the same family, such as the config status toast, moves the family's last shown key.
      shell.presenter.present("config.invalid", { message: "config.toml is invalid", variant: "warning" })
      shell.publish(configView({ keybindings: { palete: "ctrl+g", help: "ctrl+bogus" }, showThinking: false }))
      expect(shell.toasts).toHaveLength(3)
    } finally { shell.dispose() }
  })

  it("shows an invalid override again when it returns after a fix", () => {
    const shell = mountKeymap(configView({ keybindings: { help: "ctrl+bogus" } }))
    try {
      shell.publish(configView())
      shell.publish(configView({ keybindings: { help: "ctrl+bogus" } }))
      expect(shell.toasts).toHaveLength(2)
      expect(shell.toasts[1]).toBe(shell.toasts[0])
    } finally { shell.dispose() }
  })
})
