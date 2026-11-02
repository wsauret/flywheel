import { tmuxCommand } from "../../../scripts/uat/tmux-driver.js"

export interface TerminalChunk {
  ts: number
  text: string
}

export interface Viewport {
  top: number
  bottom: number
  right: number
}

export interface ScrollObservation {
  mode: "pageKeys" | "wheel" | "drag" | "growing"
  inputs: number[]
  chunks: readonly TerminalChunk[]
  viewport: Viewport
  /** Only one input is outstanding. The response is a changed upper transcript captured through tmux. */
  probes: { input: number; response?: number }[]
  directions: { start: number; end: number; direction: "up" | "down" }[]
}

/** Input writes and PTY output share one monotonic clock, expressed as epoch milliseconds for log correlation. */
export const scrollClock = (): number => performance.timeOrigin + performance.now()

/** Quote a tmux control command, including literal SGR mouse bytes. */
export function controlLiteral(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\u001b", "\\033")}"`
}

/** Send one isolated input and wait for a completed presentation with changed expected viewport text.
 * Capturing tmux alone is insufficient: it exposes writes before DEC 2026 presents them. */
export async function probeViewport(deps: {
  chunks: readonly TerminalChunk[]
  send(): number
  capture(): Promise<string>
  clock(): number
  pause(): Promise<void>
}, viewport: Viewport): Promise<ScrollObservation["probes"][number]> {
  const before = await deps.capture()
  const firstChunk = deps.chunks.length
  const probe: ScrollObservation["probes"][number] = { input: deps.send() }
  while (deps.clock() - probe.input < 1000) {
    await deps.pause()
    // The control client's capture reply follows all earlier PTY notifications.
    // Inspect frames only after that reply, including any frame opened during capture.
    const captured = await deps.capture()
    const { frames, pending } = viewportPresentations(deps.chunks.slice(firstChunk), viewport)
    if (!pending && frames.some(frame => frame.start >= probe.input) && captured !== before) {
      probe.response = deps.clock()
      break
    }
  }
  return probe
}

/** Observe the real PTY through one control client. close() joins the output reader and child. */
export function observeTerminal(server: string, session: string) {
  const command = tmuxCommand(server, ["-C", "attach-session", "-t", session])
  const child = Bun.spawn(["tmux", ...command.argv], {
    cwd: command.cwd, stdin: "pipe", stdout: "pipe", stderr: "inherit", windowsHide: true,
  })
  const chunks: TerminalChunk[] = []
  type Reply = { resolve?(text: string): void; reject?(error: Error): void }
  const replies: Reply[] = []
  let active: Reply | undefined
  let captured: string[] = []
  const reader = (async () => {
    // tmux control mode passes pane UTF-8 bytes raw and can split one glyph across two %output lines.
    // Lines are therefore held as latin1 (one character per byte), and %output bytes go through one streaming decoder.
    let pending = ""
    const output = new TextDecoder()
    for await (const bytes of child.stdout) {
      const ts = scrollClock()
      pending += Buffer.from(bytes).toString("latin1")
      let newline: number
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.startsWith("%output ")) {
          const escaped = line.slice(line.indexOf(" ", 8) + 1)
          const raw = escaped.replaceAll(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)))
          chunks.push({ ts, text: output.decode(Buffer.from(raw, "latin1"), { stream: true }) })
        } else if (line.startsWith("%begin ")) {
          // The attach reply has flag 0. Only commands written below have flag 1.
          active = line.endsWith(" 1") ? replies.shift() : undefined
          captured = []
        } else if (line.startsWith("%error")) {
          const error = new Error(`tmux control command failed: ${line}`)
          active?.reject?.(error)
          throw error
        } else if (line.startsWith("%end ")) {
          active?.resolve?.(captured.join("\n"))
          active = undefined
        } else if (active?.resolve) captured.push(Buffer.from(line, "latin1").toString("utf8"))
      }
    }
  })()
  // A rejected reader is rethrown by close(), not lost as an unhandled rejection.
  void reader.then(() => {
    const error = new Error("tmux control client closed before capture completed")
    active?.reject?.(error)
    for (const reply of replies) reply.reject?.(error)
  }, error => {
    active?.reject?.(error)
    for (const reply of replies) reply.reject?.(error)
  })
  return {
    chunks,
    send(keys: string): number {
      const ts = scrollClock()
      replies.push({})
      child.stdin.write(`send-keys -t ${session}:app ${keys}\n`)
      child.stdin.flush()
      return ts
    },
    /** Capture on the output reader's ordered control stream, never a second tmux process. */
    capture(): Promise<string> {
      return new Promise((resolve, reject) => {
        replies.push({ resolve, reject })
        child.stdin.write(`capture-pane -p -t ${session}:app\n`)
        child.stdin.flush()
      })
    },
    async close() {
      try {
        child.stdin.write("detach-client\n")
        child.stdin.flush()
        const deadline = setTimeout(() => child.kill(), 2000)
        try { await child.exited; await reader } finally { clearTimeout(deadline) }
      } finally { child.kill() }
    },
  }
}

/** Frames end at DEC 2026 presentation. Only text writes in the transcript count, not composer, scrollbar, or Latest chrome. */
export function viewportPresentations(chunks: readonly TerminalChunk[], viewport: Viewport) {
  const frames: { start: number; end: number }[] = []
  const text = chunks.map(chunk => chunk.text).join("")
  let chunkIndex = 0
  let chunkOffset = 0
  const timestampAt = (offset: number): number => {
    while (chunkIndex < chunks.length - 1 && chunkOffset + chunks[chunkIndex]!.text.length <= offset) {
      chunkOffset += chunks[chunkIndex++]!.text.length
    }
    return chunks[chunkIndex]!.ts
  }
  let start: number | undefined
  let bodyStart = 0
  // oxlint-disable-next-line no-control-regex -- boundary: the PTY emits ANSI synchronized-output controls.
  for (const marker of text.matchAll(/\u001b\[\?2026([hl])/g)) {
    if (marker[1] === "h") {
      start = timestampAt(marker.index)
      bodyStart = marker.index + marker[0].length
    } else if (start !== undefined) {
      const end = timestampAt(marker.index + marker[0].length - 1)
      if (writesViewport(text.slice(bodyStart, marker.index), viewport)) frames.push({ start, end })
      start = undefined
    }
  }
  return { frames, pending: start !== undefined }
}

function writesViewport(text: string, viewport: Viewport): boolean {
  let row = 0
  let column = 0
  // oxlint-disable-next-line no-control-regex -- boundary: the PTY emits ANSI cursor and style controls.
  for (const token of text.matchAll(/\u001b\[[0-?]*[ -/]*[@-~]|[^\u001b]+/g)) {
    const value = token[0]
    // oxlint-disable-next-line no-control-regex -- boundary: ANSI cursor addresses start with escape.
    const cursor = /^\u001b\[(\d+);(\d+)H$/.exec(value)
    if (cursor) { row = Number(cursor[1]); column = Number(cursor[2]) }
    else if (!value.startsWith("\u001b")) {
      if (row >= viewport.top && row <= viewport.bottom && column > 0 && column <= viewport.right && /\S/.test(value)) return true
      column += Bun.stringWidth(value)
    }
  }
  return false
}
