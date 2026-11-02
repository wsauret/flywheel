import { describe, expect, spyOn, test } from "bun:test"
import { NativeSession, RGBA } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { Writable } from "node:stream"
import { createRoot, createSignal } from "solid-js"
import { createComponent } from "solid-js/web"
import { ThemeProvider, useTheme } from "../../../../src/tui/context/theme.js"
import { createTerminalBackground, oscDefaultBackground } from "../../../../src/tui/hooks/create-terminal-background.js"

test("captures before compatible OSC 11 writes and never sets a system background", async () => {
  let context!: ReturnType<typeof useTheme>
  const [themeName, publishTheme] = createSignal("flywheel")
  let finish!: () => void
  const writes: string[] = []
  const result = await testRender(() => {
    const renderer = useRenderer()
    spyOn(renderer, "getPalette").mockImplementation(() => new Promise(resolve => {
      finish = () => resolve({
        palette: Array.from({ length: 16 }, () => null), defaultBackground: "#111122", defaultForeground: "#ffffff",
        cursorColor: null, mouseForeground: null, mouseBackground: null, tekForeground: null,
        tekBackground: null, highlightBackground: null, highlightForeground: null,
      })
    }))
    spyOn(renderer, "resetTerminalBgColor").mockImplementation(() => { writes.push("\x1b]111\x07") })
    return createComponent(ThemeProvider, {
      mode: "dark", get themeName() { return themeName() }, compatibleRendering: () => "on", renderer,
      get children() {
        context = useTheme()
        createTerminalBackground({
          write: sequence => { writes.push(new TextDecoder().decode(sequence)); return true },
          idle: async () => {},
        })
        return null
      },
    })
  }, { width: 20, height: 3 })
  try {
    await result.renderOnce()
    expect(writes.some(sequence => sequence.startsWith("\x1b]11;"))).toBe(false)
    finish()
    for (let index = 0; index < 12; index++) await Promise.resolve()
    expect(writes.filter(sequence => sequence.startsWith("\x1b]11;"))).toEqual([oscDefaultBackground(context.theme.background)])
    publishTheme("system")
    for (let index = 0; index < 12; index++) await Promise.resolve()
    expect(writes.filter(sequence => sequence.startsWith("\x1b]11;"))).toHaveLength(1)
    publishTheme("dracula")
    expect(writes.filter(sequence => sequence.startsWith("\x1b]11;"))).toHaveLength(2)
  } finally { result.renderer.destroy(); await result.renderer.closed }
})

test.each(["retry", "supersede", "reset", "system", "dispose", "destroy", "failed-idle"] as const)(
  "handles a refused background when the next action is %s",
  async (action) => {
    let context!: ReturnType<typeof useTheme>
    const [themeName, publishTheme] = createSignal("flywheel")
    let disposeBackground!: () => void
    const [compatible, setCompatible] = createSignal<"on" | "off">("on")
    const idle = Promise.withResolvers<void>()
    const attempts: string[] = []
    const delivered: string[] = []
    let idleCalls = 0
    const result = await testRender(() => {
      const renderer = useRenderer()
      spyOn(renderer, "resetTerminalBgColor").mockImplementation(() => { delivered.push("\x1b]111\x07") })
      return createComponent(ThemeProvider, {
        mode: "dark", get themeName() { return themeName() }, compatibleRendering: compatible,
        get children() {
          context = useTheme()
          createRoot(dispose => {
            disposeBackground = dispose
            createTerminalBackground({
              write: bytes => {
                const sequence = new TextDecoder().decode(bytes)
                attempts.push(sequence)
                if (attempts.length === 1) return false
                delivered.push(sequence)
                return true
              },
              idle: () => { idleCalls++; return idle.promise },
            })
          })
          return null
        },
      })
    }, { width: 20, height: 3 })
    try {
      await result.renderOnce()
      const first = oscDefaultBackground(context.theme.background)
      expect(attempts).toEqual([first])
      expect(delivered).toEqual([])
      let latest = first
      if (action === "supersede") {
        publishTheme("ayu")
        publishTheme("dracula")
        publishTheme("vesper")
        latest = oscDefaultBackground(context.theme.background)
      } else if (action === "reset") {
        setCompatible("off")
      } else if (action === "system") {
        publishTheme("system")
      } else if (action === "dispose") {
        disposeBackground()
      } else if (action === "destroy") {
        result.renderer.destroy()
      }
      if (action === "failed-idle") idle.reject(new Error("native sink failed"))
      else idle.resolve()
      for (let index = 0; index < 12; index++) await Promise.resolve()
      if (action === "retry" || action === "supersede") {
        expect(delivered).toEqual([latest])
        expect(attempts).toEqual([first, latest])
      } else {
        expect(attempts).toEqual([first])
        expect(delivered).toEqual(action === "reset" ? ["\x1b]111\x07"] : [])
      }
      expect(idleCalls).toBe(1)
    } finally {
      disposeBackground()
      idle.resolve()
      result.renderer.destroy()
      await result.renderer.closed
    }
  },
)

test("delivers only the latest background after a real native output refusal", async () => {
  let context!: ReturnType<typeof useTheme>
  const [themeName, publishTheme] = createSignal("system")
  const chunks: Buffer[] = []
  const blocked = Promise.withResolvers<void>()
  let stalled = false
  let releaseWrite: (() => void) | undefined
  const sink = Object.assign(new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, done) {
      chunks.push(Buffer.from(chunk))
      if (stalled) {
        releaseWrite = done
        blocked.resolve()
      } else done()
    },
  }), { columns: 20, rows: 3 })
  // NativeSession accepts Writable; CliRenderer only needs its live dimensions.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: testRender types its supported custom Writable sink as a full Node TTY stream, and a test process has no terminal to open one on
  const stdout = sink as NodeJS.WriteStream
  const session = new NativeSession(sink)
  const result = await testRender(() => createComponent(ThemeProvider, {
    mode: "dark", get themeName() { return themeName() }, compatibleRendering: () => "on",
    get children() {
      context = useTheme()
      createTerminalBackground(session)
      return null
    },
  }), { width: 20, height: 3, stdout, nativeSession: session, bufferedOutput: "stdout", exitSignals: [], useMouse: false })
  try {
    await result.renderOnce()
    await session.idle()
    chunks.length = 0
    stalled = true
    expect(session.write(new Uint8Array(Number(session.maxAtomicWriteBytes)).fill(120))).toBe(true)
    await blocked.promise
    expect(sink.writableNeedDrain).toBe(true)
    const write = spyOn(session, "write")
    publishTheme("ayu")
    const earlier = oscDefaultBackground(context.theme.background)
    expect(write.mock.results.map(attempt => attempt.value)).toEqual([false])
    publishTheme("dracula")
    const latest = oscDefaultBackground(context.theme.background)
    expect(latest).not.toBe(earlier)
    stalled = false
    releaseWrite?.()
    releaseWrite = undefined
    await session.idle()
    // The hook's idle continuation admits the latest background after the pressure output drains.
    await session.idle()
    const output = Buffer.concat(chunks).toString()
    expect(output.split("\x1b]11;")).toHaveLength(2)
    expect(output).toContain(latest)
  } finally {
    stalled = false
    releaseWrite?.()
    await result.dispose()
    sink.destroy()
  }
})

describe("oscDefaultBackground", () => {
  test("pads single-digit channels", () => {
    expect(oscDefaultBackground(RGBA.fromInts(0, 0, 0))).toBe("\x1b]11;#000000\x07")
    expect(oscDefaultBackground(RGBA.fromInts(1, 2, 3))).toBe("\x1b]11;#010203\x07")
  })

  test("handles full-intensity channels", () => {
    expect(oscDefaultBackground(RGBA.fromInts(255, 255, 255))).toBe("\x1b]11;#ffffff\x07")
  })
})
