import type { CliRenderer, CliRendererConfig } from "@opentui/core"
import { Writable } from "node:stream"
import { type ConsoleTextWriter, openWindowsConsoleWriter } from "../infra/windows-console-output.js"

/** Where the renderer's frames go.
 *
 *  On a Windows console, OpenTUI's own writer limits each `WriteConsoleW`
 *  call to 4096 UTF-8 input bytes before UTF-16 conversion
 *  (`renderer-output.zig`, `UTF16_BUFFER_SIZE`). A console host can paint
 *  between two calls. Windows Terminal holds the pieces together only through
 *  synchronized output (DEC 2026); the classic console window and the inbox
 *  ConPTY ignore it. There, a scroll step, which repaints about 7 KB, showed
 *  half a frame and a hidden cursor for 9 to 16 ms on every step, and streaming
 *  hid the cursor between pieces about four times a second.
 *
 *  So on a Windows console the renderer writes through OpenTUI's custom-stdout
 *  path instead. That path hands this side each frame whole (up to the feed's
 *  64 KiB span), and this side gives it to the console in one call. */
export interface TerminalOutput {
  /** Renderer options that route frames through this output. Empty when the
   *  renderer keeps its own output. */
  readonly rendererConfig: CliRendererConfig
  /** Forwards terminal resizes to the renderer, which watches `SIGWINCH` only
   *  for its own output. Returns the release. */
  readonly attach: (renderer: Pick<CliRenderer, "resize">) => () => void
}

interface TerminalOutputHost {
  readonly platform: NodeJS.Platform
  /** The person's own FORCE_HYPERLINK, if any. */
  readonly forceHyperlink: string | undefined
  readonly stream: Pick<NodeJS.WriteStream, "columns" | "rows" | "write">
  readonly openConsole: () => ConsoleTextWriter | undefined
  readonly onResize: (listener: () => void) => () => void
}

const PROCESS_HOST: TerminalOutputHost = {
  platform: process.platform,
  forceHyperlink: process.env.FORCE_HYPERLINK,
  stream: process.stdout,
  openConsole: openWindowsConsoleWriter,
  onResize: (listener) => {
    process.on("SIGWINCH", listener)
    return () => { process.off("SIGWINCH", listener) }
  },
}

export function createTerminalOutput(host: TerminalOutputHost = PROCESS_HOST): TerminalOutput {
  const writeConsole = host.platform === "win32" ? host.openConsole() : undefined
  if (writeConsole === undefined) return { rendererConfig: {}, attach: () => () => {} }
  const { stream } = host
  // A frame larger than one feed span arrives in two spans, which can cut a
  // UTF-8 character; the streaming decoder carries the partial bytes over.
  const decoder = new TextDecoder()
  const stdout = new Writable({
    decodeStrings: false,
    write(chunk: string | Uint8Array, _encoding, done) {
      const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
      const taken = writeConsole(text)
      if (taken < text.length) stream.write(text.slice(taken))
      done()
    },
  })
  Object.defineProperties(stdout, {
    columns: { get: () => stream.columns },
    rows: { get: () => stream.rows },
  })
  // SAFETY: NativeSession accepts Writable sinks. CliRenderer also reads the
  // live dimensions above, but types a custom sink as a full terminal stream.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: OpenTUI's custom stdout type is narrower than its Writable runtime contract
  const rendererStdout = stdout as NodeJS.WriteStream
  return {
    rendererConfig: {
      stdout: rendererStdout,
      // A custom stdout makes OpenTUI assume a remote terminal. This one is
      // local; remote mode changes only GNU screen passthrough, which Windows
      // does not have.
      remote: false,
      // OpenTUI enables hyperlinks on Windows only when it sees WT_SESSION,
      // which Windows Terminal does not set for a console that Windows hands
      // to it, such as PowerShell started from Start. Every Windows console
      // host parses OSC 8, so the declaration holds for this whole path. A
      // person's own FORCE_HYPERLINK reaches OpenTUI unchanged, because this
      // entry would override it.
      ...(host.forceHyperlink === undefined ? { environment: { FORCE_HYPERLINK: "1" } } : {}),
    },
    attach: (renderer) => host.onResize(() => { renderer.resize(stream.columns || 80, stream.rows || 24) }),
  }
}
