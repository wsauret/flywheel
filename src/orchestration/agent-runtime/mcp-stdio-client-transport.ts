import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js"
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { OwnedProcess } from "../../infra/owned-subprocess.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import { withDeadline } from "../../infra/with-deadline.js"

const PROCESS_EXIT_GRACE_MS = 250
const READER_JOIN_DEADLINE_MS = 5_000
const MAX_RECORD_CHARS = 1_048_576

/** The pipes one stdio server speaks JSON-RPC over. A launch that produced no
 *  pipes cannot carry the protocol, so the start fails instead of running
 *  blind over a server nothing can read. */
interface StdioPipes {
  readonly stdin: NonNullable<OwnedProcess["stdin"]>
  readonly stdout: NonNullable<OwnedProcess["stdout"]>
  readonly stderr: NonNullable<OwnedProcess["stderr"]>
}

type ProcessEnvironment = { readonly [K in string]: string };

/** One accepted write's terminal outcome. The index identifies the record; the
 *  record itself is never kept, because it can carry tool arguments and
 *  credentials. */
type WriteOutcome =
  | { readonly index: number; readonly failed: false }
  | { readonly index: number; readonly failed: true; readonly error: Error }

export interface BunStdioClientTransportOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: ProcessEnvironment
  readonly signal?: AbortSignal
  readonly onStderrRecord?: (record: string) => void
  /** Launch authority of the generation this connection belongs to. The server
   *  is a container the guardian owns before the payload runs, so this
   *  transport never signals a process group itself and a crash of this process
   *  still removes the server and its descendants. */
  readonly spawnOwned: LauncherScope["spawnOwned"]
}

/** MCP stdio transport for Bun. It owns newline-delimited JSON-RPC framing,
 *  ordered writes, and terminal settlement over one owned container.
 *
 *  Its memoized settlement is the only cancellation authority: the attempt
 *  signal, a natural exit, an explicit close, and a start failure all enter the
 *  same path, so every accepted write, the container, its ownership lease, and
 *  both readers are joined before `onclose`. */
export class BunStdioClientTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: <T extends JSONRPCMessage>(message: T) => void

  private owned: OwnedProcess | null = null
  private stdin: StdioPipes["stdin"] | null = null
  private started = false
  private closing = false
  private closePromise: Promise<void> | null = null
  private sendTail: Promise<void> = Promise.resolve()
  private nextWriteIndex = 0
  private readonly acceptedWrites = new Map<number, Promise<void>>()
  private writeFailure: Error | null = null
  private stdoutTask: Promise<void> = Promise.resolve()
  private stderrTask: Promise<void> = Promise.resolve()
  private removeAbortListener: (() => void) | null = null

  constructor(private readonly options: BunStdioClientTransportOptions) {}

  get pid(): number | null {
    return this.owned?.pid ?? null
  }

  /** Ownership token of the container this transport holds, or null before it
   *  starts. The token is what names the container on a platform whose
   *  containers are named, so this is how a caller asks the container what it
   *  holds instead of inferring membership from a pid. */
  get token(): string | null {
    return this.owned?.token ?? null
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("BunStdioClientTransport is already started")
    this.started = true
    const signal = this.options.signal
    // An abort is the caller's own action, so it reaches the caller as a
    // rejection instead of the `onerror` channel. Nothing was launched, so the
    // attempt holds no ownership lease.
    if (isAborted(signal)) throw abortError(signal)
    let owned: OwnedProcess
    try {
      owned = await this.options.spawnOwned([this.options.command, ...this.options.args], {
        cwd: this.options.cwd,
        env: { ...this.options.env },
      })
    } catch (cause) {
      const error = toError(cause)
      this.reportError(error)
      await this.settle(null)
      throw error
    }
    const pipes = pipesOf(owned)
    if (!pipes) {
      const error = new Error("MCP stdio server launched without pipes")
      this.reportError(error)
      await this.settle(owned)
      throw error
    }
    this.owned = owned
    this.stdin = pipes.stdin
    if (signal !== undefined) {
      const onAbort = (): void => {
        void this.settle(owned)
      }
      signal.addEventListener("abort", onAbort, { once: true })
      this.removeAbortListener = () => signal.removeEventListener("abort", onAbort)
    }
    // An abort during the launch arrived before the listener existed, so the
    // container would otherwise outlive the attempt.
    if (isAborted(signal)) {
      await this.settle(owned)
      throw abortError(signal)
    }
    this.stdoutTask = this.readStdout(pipes.stdout)
    this.stderrTask = this.readStderr(pipes.stderr)
    void owned.exited.then(
      () => this.settle(owned),
      (cause) => {
        this.reportError(toError(cause))
        return this.settle(owned)
      },
    )
  }

  send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    // Admission closes with settlement, so the accepted set cannot grow after
    // it: every accepted write settles with its own outcome before stdin ends.
    if (this.closing) return Promise.reject(new Error("MCP stdio transport is closing"))
    const stdin = this.stdin
    if (!stdin) return Promise.reject(new Error("MCP stdio transport is not connected"))
    const index = this.nextWriteIndex++
    const record = `${JSON.stringify(message)}\n`
    const write = this.sendTail.then(async () => {
      await stdin.write(record)
      await stdin.flush()
    })
    this.sendTail = write.catch(() => {})
    this.acceptedWrites.set(index, write)
    return write.then(
      () => {
        this.acceptedWrites.delete(index)
      },
      (cause: unknown) => {
        this.acceptedWrites.delete(index)
        throw this.recordWriteFailure(index, toError(cause))
      },
    )
  }

  close(): Promise<void> {
    const owned = this.owned
    if (!owned) return this.closePromise ?? Promise.resolve()
    return this.settle(owned)
  }

  private settle(owned: OwnedProcess | null): Promise<void> {
    this.closePromise ??= this.stop(owned)
    return this.closePromise
  }

  private async stop(owned: OwnedProcess | null): Promise<void> {
    this.closing = true
    await this.drainAcceptedWrites()
    const stdin = this.stdin
    this.stdin = null
    if (stdin) {
      try {
        stdin.end()
      } catch {
        // The server can close stdin before its exit is observed.
      }
    }
    if (owned) {
      await this.settleOwnedProcess(owned)
      await this.joinReaders()
    }
    this.owned = null
    try {
      this.removeAbortListener?.()
    } catch (cause) {
      this.reportError(toError(cause))
    }
    this.removeAbortListener = null
    if (this.writeFailure) this.reportError(this.writeFailure)
    this.notifyClose()
  }

  /** Every write this transport accepted settles before stdin ends, so no
   *  accepted record is lost to the close and every failure is part of the
   *  terminal outcome. */
  private async drainAcceptedWrites(): Promise<void> {
    const accepted = [...this.acceptedWrites]
    this.acceptedWrites.clear()
    const outcomes = await Promise.all(accepted.map(async ([index, write]): Promise<WriteOutcome> => {
      try {
        await write
        return { index, failed: false }
      } catch (cause) {
        return { index, failed: true, error: toError(cause) }
      }
    }))
    for (const outcome of outcomes) {
      if (outcome.failed) this.recordWriteFailure(outcome.index, outcome.error)
    }
  }

  /** The first failed write decides the terminal outcome. Only the index and
   *  the reason are kept: the record itself can carry tool arguments and
   *  credentials, so it never reaches a diagnostic. */
  private recordWriteFailure(index: number, cause: Error): Error {
    const failure = new Error(`MCP stdio write #${index} failed: ${cause.message}`)
    this.writeFailure ??= failure
    return failure
  }

  /** Stdin EOF is how an MCP server is asked to stop. The container is then
   *  terminated whether or not the server took that exit: the leader can exit
   *  and leave descendants behind, and only the container signal ends those.
   *  Either path joins the guardian's release, so ownership is settled before
   *  `onclose`. */
  private async settleOwnedProcess(owned: OwnedProcess): Promise<void> {
    await withDeadline(owned.exited.then(() => {}), PROCESS_EXIT_GRACE_MS).catch(() => {})
    try {
      await owned.terminate()
    } catch (cause) {
      this.reportError(toError(cause))
    }
  }

  /** Bounded: a reader that never ends must not hold settlement, because the
   *  ownership lease and every caller of `close` are behind it. */
  private async joinReaders(): Promise<void> {
    try {
      await withDeadline(Promise.allSettled([this.stdoutTask, this.stderrTask]), READER_JOIN_DEADLINE_MS)
    } catch (cause) {
      this.reportError(toError(cause))
    }
  }

  private async readStdout(stdout: StdioPipes["stdout"]): Promise<void> {
    const reader = stdout.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffered += decoder.decode(chunk.value, { stream: true })
        if (buffered.length > MAX_RECORD_CHARS && !buffered.includes("\n")) {
          this.protocolOverflow("stdout")
          return
        }
        let newline = buffered.indexOf("\n")
        while (newline >= 0) {
          const line = buffered.slice(0, newline).replace(/\r$/, "")
          buffered = buffered.slice(newline + 1)
          if (line.length > MAX_RECORD_CHARS) {
            this.protocolOverflow("stdout")
            return
          }
          if (line) this.parseLine(line)
          newline = buffered.indexOf("\n")
        }
      }
      buffered += decoder.decode()
      if (buffered) this.reportError(new Error("MCP stdout ended with an unterminated JSON-RPC record"))
    } catch (cause) {
      this.reportError(toError(cause))
    } finally {
      reader.releaseLock()
    }
  }

  private async readStderr(stderr: StdioPipes["stderr"]): Promise<void> {
    const reader = stderr.getReader()
    const decoder = new TextDecoder()
    let buffered = ""
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffered += decoder.decode(chunk.value, { stream: true })
        if (buffered.length > MAX_RECORD_CHARS && !buffered.includes("\n")) {
          this.protocolOverflow("stderr")
          return
        }
        let newline = buffered.indexOf("\n")
        while (newline >= 0) {
          const record = buffered.slice(0, newline).replace(/\r$/, "")
          buffered = buffered.slice(newline + 1)
          if (record.length > MAX_RECORD_CHARS) {
            this.protocolOverflow("stderr")
            return
          }
          if (record) this.options.onStderrRecord?.(record)
          newline = buffered.indexOf("\n")
        }
      }
      buffered += decoder.decode()
      if (buffered) this.options.onStderrRecord?.(buffered)
    } catch (cause) {
      this.reportError(toError(cause))
    } finally {
      reader.releaseLock()
    }
  }

  private parseLine(line: string): void {
    try {
      this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)))
    } catch (cause) {
      this.reportError(toError(cause))
    }
  }

  private protocolOverflow(channel: "stdout" | "stderr"): void {
    this.reportError(new Error(`MCP ${channel} record exceeded ${MAX_RECORD_CHARS} characters`))
    void this.close()
  }

  private reportError(error: Error): void {
    try {
      this.onerror?.(error)
    } catch {
      // Observers cannot participate in transport settlement.
    }
  }

  private notifyClose(): void {
    try {
      this.onclose?.()
    } catch (cause) {
      this.reportError(toError(cause))
    }
  }
}

function pipesOf(owned: OwnedProcess): StdioPipes | undefined {
  const { stdin, stdout, stderr } = owned
  return stdin && stdout && stderr ? { stdin, stdout, stderr } : undefined
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}

/** Read through a call so neither abort check narrows the other away: the
 *  signal can abort between them. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error ? reason : new Error("MCP stdio transport start was aborted")
}