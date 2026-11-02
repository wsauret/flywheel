import { describe, expect, test } from "bun:test"
import { NativeSession } from "@opentui/core"

import { createTerminalOutput } from "../../../src/tui/terminal-output.js"

interface FakeHost {
  readonly consoleWrites: string[]
  readonly streamWrites: string[]
  readonly resizeListeners: Set<() => void>
  readonly size: { columns: number; rows: number }
}

/** A Windows console as the TUI host sees it. `accept` limits how many
 *  UTF-16 units one console write takes, as a failing console would. */
function host(platform: NodeJS.Platform, options: { readonly console?: boolean; readonly accept?: number; readonly forceHyperlink?: string } = {}) {
  const fake: FakeHost = { consoleWrites: [], streamWrites: [], resizeListeners: new Set(), size: { columns: 120, rows: 35 } }
  const output = createTerminalOutput({
    platform,
    forceHyperlink: options.forceHyperlink,
    stream: {
      get columns() { return fake.size.columns },
      get rows() { return fake.size.rows },
      write: (chunk: string | Uint8Array) => {
        fake.streamWrites.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
        return true
      },
    },
    openConsole: () => options.console === false ? undefined : (text) => {
      const taken = Math.min(text.length, options.accept ?? text.length)
      fake.consoleWrites.push(text.slice(0, taken))
      return taken
    },
    onResize: (listener) => {
      fake.resizeListeners.add(listener)
      return () => { fake.resizeListeners.delete(listener) }
    },
  })
  return { fake, output }
}

function write(output: ReturnType<typeof createTerminalOutput>, bytes: Uint8Array): Promise<boolean> {
  const stdout = output.rendererConfig.stdout
  if (stdout === undefined) throw new Error("expected a console output")
  return new Promise((resolve, reject) => {
    stdout.write(bytes, error => { if (error) reject(error); else resolve(true) })
  })
}

/** A scroll-step frame as OpenTUI paints it: synchronized, about 7 KB, so
 *  OpenTUI's own Windows writer would split it at 4096 UTF-16 units. */
function frame(): string {
  return `\x1b[?2026h\x1b[?25l${"\x1b[1;1H\x1b[38;2;200;200;200m".concat("x".repeat(160)).repeat(40)}\x1b[?25h\x1b[?2026l`
}

describe("terminal output", () => {
  test("a Windows console is a native session sink and receives whole frames", async () => {
    const { fake, output } = host("win32")
    const stdout = output.rendererConfig.stdout
    if (!stdout) throw new Error("expected a console output")
    const session = new NativeSession(stdout)
    session.dispose()
    const text = frame()
    expect(text.length).toBeGreaterThan(4096)

    expect(await write(output, new TextEncoder().encode(text))).toBe(true)

    expect(fake.consoleWrites).toEqual([text])
    expect(fake.streamWrites).toEqual([])
    expect(output.rendererConfig.remote).toBe(false)
  })

  test("a Windows console declares hyperlinks unless the person chose a setting", () => {
    expect(host("win32").output.rendererConfig.environment).toEqual({ FORCE_HYPERLINK: "1" })
    expect(host("win32", { forceHyperlink: "0" }).output.rendererConfig.environment).toBeUndefined()
  })

  test("a character split across two renderer spans reaches the console whole", async () => {
    const { fake, output } = host("win32")
    const bytes = new TextEncoder().encode("ab─cd")
    await write(output, bytes.subarray(0, 3))
    await write(output, bytes.subarray(3))
    expect(fake.consoleWrites.join("")).toBe("ab─cd")
  })

  test("text the console does not take goes to the stream", async () => {
    const { fake, output } = host("win32", { accept: 4 })
    await write(output, new TextEncoder().encode("abcdefgh"))
    expect(fake.consoleWrites).toEqual(["abcd"])
    expect(fake.streamWrites).toEqual(["efgh"])
  })

  test("a terminal resize reaches the renderer until the output is released", () => {
    const { fake, output } = host("win32")
    const sizes: string[] = []
    const release = output.attach({ resize: (width, height) => { sizes.push(`${width}x${height}`) } })
    fake.size.columns = 100
    fake.size.rows = 30
    for (const listener of fake.resizeListeners) listener()
    release()
    expect(fake.resizeListeners.size).toBe(0)
    expect(sizes).toEqual(["100x30"])
  })

  test("other platforms and a stream that is not a console keep the renderer's own output", () => {
    for (const { fake, output } of [host("darwin"), host("linux"), host("win32", { console: false })]) {
      expect(output.rendererConfig).toEqual({})
      output.attach({ resize: () => {} })
      expect(fake.resizeListeners.size).toBe(0)
    }
  })
})
