import { describe, expect, test } from "bun:test"

import { createExternalUrlOpener, utf16Argument } from "../../../src/infra/open-external-url.js"
import type { OwnedProcess } from "../../../src/infra/owned-subprocess.js"
import type { LauncherScope } from "../../../src/infra/process-supervisor.js"

/** URLs whose text is a command line on Windows if anything ever parses it.
 *  Each one is a legal http(s) URL, so the scheme check lets it through and the
 *  handoff itself is what has to be safe. */
const METACHARACTER_URLS = [
  "https://example.com/?a=1&calc.exe",
  'https://example.com/"&calc.exe&"',
  "https://example.com/%COMSPEC%",
  "https://example.com/a|calc.exe",
  "https://example.com/a^&calc.exe",
  "https://example.com/a%0Acalc.exe",
  "https://example.com/'`calc.exe`'",
  "http://example.com/;calc.exe",
]

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.close() } })
}

interface ScopeProbe {
  readonly scope: LauncherScope
  readonly launches: string[][]
}

function scopeProbe(exitCode = 0): ScopeProbe {
  const launches: string[][] = []
  const scope = {
    spawnOwned(command: readonly string[]): Promise<OwnedProcess> {
      launches.push([...command])
      const exit = { code: exitCode, signal: null, statusOf: "payload", ownership: "surrendered" } as const
      return Promise.resolve({
        pid: 7,
        token: "owned:opener",
        strength: "process-group",
        stdin: undefined,
        stdout: emptyStream(),
        stderr: emptyStream(),
        exited: Promise.resolve(exit),
        terminate: () => Promise.resolve(exit),
      })
    },
    adoptOwned: () => Promise.reject(new Error("the opener never adopts a command")),
    open: () => { throw new Error("the opener never nests a scope") },
    close: () => Promise.resolve({ settled: true } as const),
  }
  return { scope, launches }
}

describe("opening an external URL", () => {
  test("refuses every scheme that is not http(s), on every platform", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const asked: string[] = []
      const probe = scopeProbe()
      const open = createExternalUrlOpener({ platform, shellExecute: (url) => { asked.push(url); return true } })

      expect(await open(probe.scope, "file:///etc/passwd")).toBe(false)
      expect(await open(probe.scope, ["java", "script:alert(1)"].join(""))).toBe(false)
      expect(await open(probe.scope, "not a url")).toBe(false)
      expect(probe.launches).toEqual([])
      expect(asked).toEqual([])
    }
  })

  test("hands the URL to macOS and Linux as one argument of one owned launch", async () => {
    for (const [platform, opener] of [["darwin", "open"], ["linux", "xdg-open"]] as const) {
      const probe = scopeProbe()
      const open = createExternalUrlOpener({ platform, shellExecute: () => { throw new Error("not this platform") } })

      for (const url of METACHARACTER_URLS) expect(await open(probe.scope, url)).toBe(true)

      // Never a shell, and never a joined command line: the URL is its own argv
      // element, so nothing between here and the desktop can split it.
      expect(probe.launches).toEqual(METACHARACTER_URLS.map((url) => [opener, url]))
    }
  })

  test("reports a failed handoff on macOS and Linux instead of claiming success", async () => {
    const probe = scopeProbe(1)
    const open = createExternalUrlOpener({ platform: "linux", shellExecute: () => true })

    expect(await open(probe.scope, "https://example.com")).toBe(false)
  })

  test("starts no process at all on Windows, whatever the URL contains", async () => {
    const asked: string[] = []
    const probe = scopeProbe()
    const open = createExternalUrlOpener({ platform: "win32", shellExecute: (url) => { asked.push(url); return true } })

    for (const url of METACHARACTER_URLS) expect(await open(probe.scope, url)).toBe(true)

    // No launch means no command line, so there is nothing for `cmd` to parse.
    expect(probe.launches).toEqual([])
    // Byte for byte what the caller asked for: no quoting, no escaping, no
    // rewriting, because the value is a data argument rather than a command.
    expect(asked).toEqual([...METACHARACTER_URLS])
  })

  test("reports a Windows handoff the shell refused", async () => {
    const probe = scopeProbe()
    const open = createExternalUrlOpener({ platform: "win32", shellExecute: () => false })

    expect(await open(probe.scope, "https://example.com")).toBe(false)
    expect(probe.launches).toEqual([])
  })
})

describe("the Windows URL argument", () => {
  test("is a null-terminated UTF-16LE string, not a command line", () => {
    const bytes = utf16Argument("a&b")

    expect([...bytes]).toEqual([0x61, 0x00, 0x26, 0x00, 0x62, 0x00, 0x00, 0x00])
  })

  test("carries every metacharacter through as its own code unit", () => {
    for (const url of METACHARACTER_URLS) {
      const bytes = utf16Argument(url)
      const units = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2)

      expect(units.at(-1)).toBe(0)
      expect(String.fromCharCode(...units.subarray(0, -1))).toBe(url)
    }
  })
})
