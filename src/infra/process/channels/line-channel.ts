import type { Socket } from "bun"

/** One word per line between Flywheel processes: over a Unix socket on POSIX,
 *  over a named pipe on Windows, or over an inherited descriptor.
 *
 *  A line is a decision only once its terminator arrives, so a partial write
 *  is never read as a word. The end of a connection is itself a word: it says
 *  the peer is gone and holds nothing. */

/** A line longer than this is not a word of any Flywheel channel. A peer that
 *  sends one is dropped rather than buffered without bound. */
const MAX_LINE_BYTES = 16 * 1024

/** One connection, from either side. */
export interface LineConnection {
  /** The next line, or undefined once the connection ended. */
  next(): Promise<string | undefined>
  /** Sends one line. Nothing is sent once the connection ended. */
  say(line: string): void
  /** Ends the connection from this side. */
  close(): void
  /** Settles once the connection ended, from either side. */
  readonly ended: Promise<void>
  /** Settles at the native transport close, not the local close request.
   *  A sender awaits this before exit so queued writes reach its peer. */
  readonly closed: Promise<void>
}

interface LineState {
  readonly connection: LineConnection
  receive(chunk: Uint8Array): void
  finish(): void
  transportClosed(): void
}

function lineState(socket: Pick<Socket, "write" | "end">): LineState {
  const decoder = new TextDecoder()
  const lines: string[] = []
  const waiting: Array<(line: string | undefined) => void> = []
  let pending = ""
  let finished = false
  let settleEnded: () => void = () => {}
  const ended = new Promise<void>((resolve) => { settleEnded = resolve })
  let settleClosed!: () => void
  const closed = new Promise<void>((resolve) => { settleClosed = resolve })
  const deliver = (): void => {
    while (waiting.length > 0) {
      const line = lines.shift()
      if (line !== undefined) waiting.shift()?.(line)
      else if (finished) waiting.shift()?.(undefined)
      else return
    }
  }
  const finish = (): void => {
    if (finished) return
    finished = true
    settleEnded()
    deliver()
  }
  return {
    connection: {
      next: () => new Promise<string | undefined>((resolve) => {
        waiting.push(resolve)
        deliver()
      }),
      say(line) {
        if (finished) return
        try {
          socket.write(`${line}\n`)
        } catch {
          // A peer that went away between its end and this write already
          // holds nothing, so the word has nobody left to reach.
          finish()
        }
      },
      close() {
        if (finished) return
        finish()
        socket.end()
      },
      ended,
      closed,
    },
    receive(chunk) {
      if (finished) return
      pending += decoder.decode(chunk, { stream: true })
      for (let terminator = pending.indexOf("\n"); terminator >= 0; terminator = pending.indexOf("\n")) {
        lines.push(pending.slice(0, terminator).trim())
        pending = pending.slice(terminator + 1)
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
        finish()
        socket.end()
        return
      }
      deliver()
    },
    finish,
    transportClosed() { finish(); settleClosed() },
  }
}

/** Connects to the channel served at `address`. Nothing when nothing serves
 *  it, which is how a caller learns that the process behind it is gone. */
export async function connectLines(address: string): Promise<LineConnection | undefined> {
  let state: LineState | undefined
  try {
    const socket = await Bun.connect({
      unix: address,
      socket: {
        // The state exists from the moment the connection opens. A Windows
        // named pipe delivers a word the listener wrote on connection before
        // the connect promise settles, and a state made only after it would
        // lose that word: the launcher's admission, which the supervisor then
        // waits for until its deadline.
        open: (opened) => { state = lineState(opened) },
        data: (_socket, chunk) => { state?.receive(chunk) },
        end: () => { state?.finish() },
        close: () => { state?.transportClosed() },
        error: () => { state?.transportClosed() },
      },
    })
    state ??= lineState(socket)
    return state.connection
  } catch {
    return undefined
  }
}

/** A listening channel. Stopping it ends every connection it holds and
 *  removes a POSIX socket from its directory. */
export interface LineServer {
  stop(): void
}

/** Serves `address` and hands each connection to `accept`, which may close it
 *  at once. Throws when the address cannot be listened on. */
export function serveLines(address: string, accept: (connection: LineConnection) => void): LineServer {
  const states = new Map<object, LineState>()
  const finish = (socket: Socket): void => { states.get(socket)?.finish() }
  const closed = (socket: Socket): void => {
    states.get(socket)?.transportClosed()
    states.delete(socket)
  }
  const server = Bun.listen({
    unix: address,
    socket: {
      open(socket) {
        const state = lineState(socket)
        states.set(socket, state)
        accept(state.connection)
      },
      data: (socket, chunk) => { states.get(socket)?.receive(chunk) },
      // Bun delivers a failed write here. With no handler bound it surfaces as
      // an unhandled exception at the write's call site.
      end: finish,
      close: closed,
      error: closed,
    },
  })
  return { stop: () => {
    // Stopping a Windows named-pipe listener alone leaves its peers waiting.
    for (const state of states.values()) state.connection.close()
    server.stop(true)
  } }
}

/** Reads an inherited descriptor's stream one line at a time, and reports its
 *  end as undefined. */
export function streamLines(stream: ReadableStream<Uint8Array>): () => Promise<string | undefined> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  return async () => {
    for (;;) {
      const terminator = pending.indexOf("\n")
      if (terminator >= 0) {
        const line = pending.slice(0, terminator).trim()
        pending = pending.slice(terminator + 1)
        return line
      }
      const chunk = await reader.read()
      if (chunk.done) return undefined
      pending += decoder.decode(chunk.value, { stream: true })
    }
  }
}
