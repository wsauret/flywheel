import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import { createTerminalPalette, RGBA } from "@opentui/core"
import { EventEmitter } from "node:events"
import type { Clock, TerminalColors, TimerHandle } from "@opentui/core"
import type { CompatibleRenderingMode } from "../../../../src/orchestration/config/schema.js"
import type { RuntimeConfigView } from "../../../../src/protocol/runtime-config-protocol-types.js"
import { contrastRatio } from "../../../../src/tui/context/theme/color-contrast.js"
import { configView } from "../../../helpers/runtime-views.js"

const { ThemeProvider, useTheme } = await import("../../../../src/tui/context/theme.js")

describe("system terminal color detection", () => {
  it.each(["special-only", "full", "silent"] as const)("preserves %s reports and releases query resources", async (mode) => {
    const terminal = paletteTerminal(mode)
    try {
      const detection = terminal.detector.detect({ size: 16, timeout: 1000 })
      await terminal.clock.finishQueries()
      const colors = await detection
      expect(colors.defaultForeground).toBe(mode === "silent" ? null : "#f8f8f2")
      expect(colors.defaultBackground).toBe(mode === "silent" ? null : "#282a36")
      expect(colors.palette).toEqual(Array.from({ length: 16 }, () => mode === "full" ? "#123456" : null))
      expect(terminal.writes.filter((write) => write.includes("\x1b]4;1;?"))).toHaveLength(mode === "full" ? 1 : 0)
      expect(terminal.writes[1]).toContain("\x1b]10;?")
      expect(terminal.handlers.size).toBe(0)
      expect(terminal.clock.timers.size).toBe(0)
    } finally { terminal.detector.cleanup() }
  })

  it("releases subscriptions and timers when detection is cancelled", () => {
    const terminal = paletteTerminal("silent")
    void terminal.detector.detect({ timeout: 1000 })
    expect(terminal.handlers.size).toBeGreaterThan(0)
    expect(terminal.clock.timers.size).toBeGreaterThan(0)
    terminal.detector.cleanup()
    expect(terminal.handlers.size).toBe(0)
    expect(terminal.clock.timers.size).toBe(0)
  })
})

function paletteTerminal(mode: "special-only" | "full" | "silent") {
  const clock = new PaletteClock()
  const handlers = new Set<(sequence: string) => void>()
  const writes: string[] = []
  const emit = (sequence: string) => { for (const handler of handlers) handler(sequence) }
  const detector = createTerminalPalette({
    // With oscSource and writeFn injected, the detector reads only isTTY from these streams.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: OpenTUI's detector types stdin as a full Node TTY stream, and a test process has no terminal to open one on
    stdin: { isTTY: true } as NodeJS.ReadStream,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: OpenTUI's detector types stdout as a full Node TTY stream, and a test process has no terminal to open one on
    stdout: { isTTY: true } as NodeJS.WriteStream,
    clock,
    oscSource: {
      subscribeOsc(handler) { handlers.add(handler); return () => { handlers.delete(handler) } },
    },
    writeFn(data) {
      const query = data.toString()
      writes.push(query)
      if (mode === "full" && query.includes("\x1b]4;")) {
        queueMicrotask(() => emit(Array.from({ length: 16 }, (_, index) => `\x1b]4;${index};#123456\x07`).join("")))
      }
      if (mode !== "silent" && query.includes("\x1b]10;?")) {
        queueMicrotask(() => emit("\x1b]10;rgb:f8f8/f8f8/f2f2\x07\x1b]11;rgb:2828/2a2a/3636\x1b\\"))
      }
      return true
    },
  })
  return { detector, clock, handlers, writes }
}

class PaletteClock implements Clock {
  timers = new Map<TimerHandle, { callback: () => void; at: number }>()
  private time = 0
  private nextHandle = 1
  now() { return this.time }
  setTimeout(callback: () => void, delay: number) {
    const handle = this.nextHandle++
    this.timers.set(handle, { callback, at: this.time + delay })
    return handle
  }
  clearTimeout(handle: TimerHandle) { this.timers.delete(handle) }
  setInterval(): TimerHandle { throw new Error("Palette detection must not poll") }
  clearInterval(handle: TimerHandle) { this.clearTimeout(handle) }
  async finishQueries() {
    await flush()
    while (this.timers.size > 0) {
      const next = [...this.timers].toSorted((left, right) => left[1].at - right[1].at)[0]!
      this.time = next[1].at
      this.timers.delete(next[0])
      next[1].callback()
      await flush()
    }
  }
}

describe("theme baseBackground", () => {
  it("renders immediately, captures original colors, and follows system publications only while selected", async () => {
    const renderer = new PaletteRenderer()
    const [themeName, publishTheme] = createSignal("flywheel")
    let context!: ReturnType<typeof useTheme>
    const result = await testRender(() =>
      createComponent(ThemeProvider, {
        mode: "dark", get themeName() { return themeName() }, renderer, compatibleRendering: () => "on",
        get children() {
          context = useTheme()
          return null
        },
      }), { width: 20, height: 3 })
    try {
      expect(renderer.queries).toHaveLength(1)
      const named = context.theme.background.toString()
      expect(context.terminalColorsReady).toBe(false)
      expect(context.baseBackground).toBe(context.theme.background)
      expect(context.cursorColor).toBe(context.theme.primary)
      renderer.queries[0]!.resolve({ ...reported("#fafafa", "#222222"), cursorColor: "#ff79c6" })
      await flush()
      expect(context.terminalColorsReady).toBe(true)
      expect(context.cursorColor.equals(RGBA.fromHex("#ff79c6"))).toBe(true)
      expect(context.baseBackground).toBeUndefined()
      expect(context.theme.background.toString()).toBe(named)
      publishTheme("system")
      expect(context.themeName).toBe("system")
      expect(context.mode).toBe("light")
      expect(context.theme.background.equals(RGBA.fromHex("#fafafa"))).toBe(true)
      await flush()
      expect(renderer.resets).toBe(1)
      renderer.queries[1]!.resolve(reported("#101020", "#eeeeee"))
      await flush()
      expect(context.mode).toBe("dark")
      expect(context.theme.background.equals(RGBA.fromHex("#101020"))).toBe(true)
      renderer.emit("palette", reported("#eeeecc", "#202020"))
      expect(context.mode).toBe("light")
      publishTheme("dracula")
      const dracula = context.theme.background.toString()
      renderer.emit("palette", reported("#ff0000", "#ffffff"))
      expect(context.theme.background.toString()).toBe(dracula)
      expect(context.mode).toBe("dark")
      publishTheme("system")
      expect(context.theme.background.equals(RGBA.fromHex("#eeeecc"))).toBe(true)
      await flush()
      result.renderer.destroy()
      await result.renderer.closed
      expect(renderer.listenerCount("palette")).toBe(0)
      expect(renderer.listenerCount("theme_mode")).toBe(0)
      expect(renderer.handlers.size).toBe(0)
      const last = context.theme.background.toString()
      renderer.queries.at(-1)!.resolve(reported("#ffffff", "#000000"))
      await flush()
      expect(context.theme.background.toString()).toBe(last)
    } finally { result.renderer.destroy(); await result.renderer.closed }
  })

  it("coalesces notifications and clears the cache without waiting for native detection", async () => {
    const renderer = new PaletteRenderer()
    let context!: ReturnType<typeof useTheme>
    const result = await testRender(() =>
      createComponent(ThemeProvider, {
        mode: "dark", themeName: "system", renderer,
        get children() { context = useTheme(); return null },
      }), { width: 20, height: 3 })
    try {
      renderer.queries[0]!.resolve(reported("#101010", "#eeeeee"))
      await flush()
      renderer.paletteDetectionStatus = "detecting"
      for (const handler of renderer.handlers) {
        expect(handler("\x1b[?997;2n")).toBe(false)
        handler("\x1b[?997;2n")
      }
      await flush()
      expect(renderer.clears).toBe(1)
      expect(renderer.queries).toHaveLength(2)
      renderer.queries[1]!.resolve(reported("#202030", "#eeeeee"))
      await flush()
      expect(context.terminalColorsReady).toBe(true)
      expect(context.themeName).toBe("system")
      expect(context.mode).toBe("dark")
      expect(context.theme.background.equals(RGBA.fromHex("#202030"))).toBe(true)
    } finally { result.renderer.destroy(); await result.renderer.closed }
  })

  it("contains a failed initial capture and keeps a usable system fallback", async () => {
    const renderer = new PaletteRenderer()
    let context!: ReturnType<typeof useTheme>
    const result = await testRender(() =>
      createComponent(ThemeProvider, {
        mode: "light", themeName: "system", renderer, compatibleRendering: () => "on",
        get children() { context = useTheme(); return null },
      }), { width: 20, height: 3 })
    try {
      const fallback = context.theme.background.toString()
      expect(context.mode).toBe("light")
      expect(context.theme.text.toString()).not.toBe(fallback)
      expect(context.baseBackground).toBe(context.theme.background)
      renderer.queries[0]!.reject(new Error("suspended"))
      await flush()
      expect(context.terminalColorsReady).toBe(true)
      expect(context.theme.background.toString()).toBe(fallback)
      expect(renderer.resets).toBe(0)
      expect(context.baseBackground).toBe(context.theme.background)
      renderer.emit("palette", reported("#fafafa", "#222222"))
      expect(context.baseBackground).toBeUndefined()
    } finally { result.renderer.destroy(); await result.renderer.closed }
  })

  it("does not publish a query from a previous system selection after a named-theme write", async () => {
    const renderer = new PaletteRenderer()
    const [themeName, publishTheme] = createSignal("flywheel")
    let context!: ReturnType<typeof useTheme>
    const result = await testRender(() =>
      createComponent(ThemeProvider, {
        mode: "dark", get themeName() { return themeName() }, renderer,
        get children() { context = useTheme(); return null },
      }), { width: 20, height: 3 })
    try {
      renderer.queries[0]!.resolve(reported("#111122", "#ffffff"))
      await flush()
      publishTheme("system")
      await flush()
      publishTheme("dracula")
      publishTheme("system")
      renderer.emit("palette", reported("#ff0000", "#ffffff"))
      renderer.queries[1]!.resolve(reported("#ff0000", "#ffffff"))
      await flush()
      expect(context.theme.background.equals(RGBA.fromHex("#111122"))).toBe(true)
      expect(renderer.queries).toHaveLength(3)
      renderer.queries[2]!.resolve(reported("#eeeecc", "#222222"))
      await flush()
      expect(context.theme.background.equals(RGBA.fromHex("#eeeecc"))).toBe(true)
    } finally { result.renderer.destroy(); await result.renderer.closed }
  })

  it("follows the compatible-rendering setting and theme switches", async () => {
    const [rendering, setRendering] = createSignal<CompatibleRenderingMode>("on")
    const [themeName, publishTheme] = createSignal("flywheel")
    let context!: ReturnType<typeof useTheme>
    const result = await testRender(() =>
      createComponent(ThemeProvider, {
        mode: "dark",
        get themeName() { return themeName() },
        compatibleRendering: () => rendering(),
        get children() {
          context = useTheme()
          return null
        },
      }), { width: 20, height: 3 })
    try {
      // Forced compatible rendering: base surfaces stay on the terminal
      // default background.
      expect(context.baseBackground).toBeUndefined()

      // Forced explicit rendering: base surfaces paint the resolved theme
      // background.
      setRendering("off")
      const explicit = context.baseBackground
      expect(explicit).toBe(context.theme.background)

      // A theme switch re-resolves the explicit background.
      publishTheme("dracula")
      expect(context.baseBackground).toBe(context.theme.background)
      expect(context.baseBackground).not.toBe(explicit)

    } finally { result.renderer.destroy(); await result.renderer.closed }
  })
})

function reported(background: string | null, foreground: string | null): TerminalColors {
  return {
    palette: Array.from({ length: 16 }, () => null), defaultBackground: background, defaultForeground: foreground,
    cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null,
    tekBackground: null, highlightBackground: null, highlightForeground: null,
  }
}

// oxlint-disable-next-line unicorn/prefer-event-target -- boundary: OpenTUI exposes EventEmitter subscriptions
class PaletteRenderer extends EventEmitter {
  paletteDetectionStatus: "idle" | "detecting" | "cached" = "idle"
  queries: { resolve: (colors: TerminalColors) => void; reject: (error: Error) => void }[] = []
  handlers = new Set<(sequence: string) => boolean>()
  clears = 0
  resets = 0
  getPalette() {
    return new Promise<TerminalColors>((resolve, reject) => { this.queries.push({ resolve, reject }) })
  }
  clearPaletteCache() { this.clears++ }
  resetTerminalBgColor() { this.resets++ }
  prependInputHandler(handler: (sequence: string) => boolean) { this.handlers.add(handler) }
  removeInputHandler(handler: (sequence: string) => boolean) { this.handlers.delete(handler) }
}

async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve() }

describe("write syntax colors", () => {
  it("keeps write colors independent and releases readable derived styles", async () => {
    const renderer = new PaletteRenderer()
    const [writeSyntaxTheme, setWriteSyntaxTheme] = createSignal<"nord" | "vesper">("nord")
    const [themeName, publishTheme] = createSignal("flywheel")
    const config = (): RuntimeConfigView => configView({ writeSyntaxTheme: writeSyntaxTheme() })
    let context!: ReturnType<typeof useTheme>
    const result = await testRender(() =>
      createComponent(ThemeProvider, {
        mode: "dark",
        get themeName() { return themeName() },
        config,
        renderer,
        get children() {
          context = useTheme()
          return null
        },
      }), { width: 20, height: 3 })
    try {
      const chromeText = context.theme.text.toString()
      const chatFunction = context.chatSyntaxColors.function.toString()
      const previousSubtle = context.subtleSyntax
      const previousSyntax = context.syntax
      const previousPalette = context.subtleTheme
      for (const name of context.subtleSyntax.getRegisteredNames()) {
        const subdued = context.subtleSyntax.getStyle(name)
        const normal = context.syntax.getStyle(name)
        if (!subdued?.fg) continue
        expect(subdued.fg.a, name).toBe(1)
        expect(subdued?.bold, name).toBe(normal?.bold)
        expect(subdued?.italic, name).toBe(normal?.italic)
        expect(contrastRatio(subdued!.fg!, context.theme.background), name).toBeGreaterThanOrEqual(4.5)
      }
      expect(context.subtleSyntax.getStyle("default")?.fg).toEqual(context.subtleTheme.text)
      expect(context.subtleTheme).toBe(previousPalette)
      expect(context.writeSyntaxColors.function.equals(RGBA.fromHex("#88c0d0"))).toBe(true)
      setWriteSyntaxTheme("vesper")
      expect(context.writeSyntaxColors.function.equals(RGBA.fromHex("#cfb08a"))).toBe(true)
      expect(context.theme.text.toString()).toBe(chromeText)
      expect(context.chatSyntaxColors.function.toString()).toBe(chatFunction)
      renderer.queries[0]!.resolve(reported("#fafafa", "#222222"))
      await flush()
      publishTheme("system")
      expect(context.subtleTheme).not.toBe(previousPalette)
      expect(() => previousSubtle.getStyle("default")).toThrow()
      expect(() => previousSyntax.getStyle("default")).toThrow()
      expect(context.mode).toBe("light")
      expect(writeSyntaxTheme()).toBe("vesper")
      expect(context.writeSyntaxColors.function.equals(RGBA.fromHex("#654a27"))).toBe(true)
      await flush()
      renderer.queries[1]!.resolve(reported("#101020", "#eeeeee"))
      await flush()
      expect(context.mode).toBe("dark")
      expect(writeSyntaxTheme()).toBe("vesper")
      expect(context.writeSyntaxColors.function.equals(RGBA.fromHex("#cfb08a"))).toBe(true)
    } finally {
      const subtle = context.subtleSyntax
      const normal = context.syntax
      result.renderer.destroy()
      await result.renderer.closed
      expect(() => subtle.getStyle("default")).toThrow()
      expect(() => normal.getStyle("default")).toThrow()
    }
  })
})
