import { Option, Schema } from "effect"
import { errorMessage } from "../../../../infra/diagnostics/error-message.js"
import { Log } from "../../../../infra/diagnostics/log.js"
import { coalesceRepeats } from "../../../../infra/diagnostics/repeat-coalescer.js"
import {
  ACP_METHOD_NOT_FOUND,
  agentRequestSessionId,
  decodeAcpResult,
  decodeInboundFrame,
  decodeSessionNotification,
  type AcpInboundFrame,
  type AcpJsonRpcError,
  type AcpJsonRpcId,
  type AcpMethod,
  type AcpNotifications,
  type AcpRequests,
  type AcpSessionNotification,
} from "./schema.js"

const log = Log.create({ service: "provider-google-antigravity" })

/** The largest inbound frame, in characters. agy writes one JSON-RPC frame per
 *  line; the largest Flywheel reads is a `tool_call` whose arguments a model
 *  wrote, which its output limit bounds far below this. A line that grows past
 *  it is not a frame Flywheel can use, so the connection stops buffering it. */
const DEFAULT_MAX_FRAME_CHARS = 8 * 1024 * 1024

/** The window in which repeats of one unserved frame kind coalesce. */
const UNSERVED_REPEAT_WINDOW_MS = 60_000

/** One kind of inbound frame that the connection did not pass on, named by its
 *  protocol method or update kind. */
interface UnservedFrame {
  readonly condition: string
  readonly subject: string
}

/** Why a connection ended. `ended`: agy closed its stdout. `closed`: the owner
 *  called `close`. The others are failures: a line over the frame limit, an
 *  inbound frame that does not decode (named by its method or kind, never by
 *  its content), or a failed read, write, or observer. */
export type AcpCloseReason =
  | { readonly kind: "ended" }
  | { readonly kind: "closed" }
  | { readonly kind: "frame-too-large"; readonly limitChars: number }
  | { readonly kind: "malformed"; readonly frame: string }
  | { readonly kind: "failed"; readonly detail: string }

/** Counts of the inbound frames that a connection did not pass on. */
interface AcpUnservedCounts {
  /** `session/update` notifications of a kind this agy version was not qualified with. */
  readonly unknownUpdates: number
  /** Notifications of a method other than `session/update`. */
  readonly unknownNotifications: number
  /** Agent-to-client requests answered with a JSON-RPC error. */
  readonly refusedAgentRequests: number
  /** Responses whose id names no pending request, such as one the caller aborted. */
  readonly unmatchedResponses: number
}

interface AcpClose {
  readonly reason: AcpCloseReason
  readonly unserved: AcpUnservedCounts
}

/** A pending request that the connection's end settled. */
export class AcpConnectionClosed extends Error {
  constructor(readonly method: AcpMethod, readonly close: AcpCloseReason) {
    super(`ACP request ${method} ended with the connection (${close.kind})`)
    this.name = "AcpConnectionClosed"
  }
}

/** A JSON-RPC error that agy answered a request with. */
export class AcpRequestError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(readonly method: AcpMethod, error: AcpJsonRpcError) {
    super(`ACP request ${method} failed (${error.code}): ${error.message}`)
    this.name = "AcpRequestError"
    this.code = error.code
    this.data = error.data
  }
}

/** An agent-to-client request that the connection refused. */
export interface AcpRefusedAgentRequest {
  readonly method: string
  readonly sessionId: string | undefined
}

/** The pipes of one `agy acp` process. The process owner keeps the process
 *  itself: this connection only ends stdin and stops reading stdout. */
interface AcpPipes {
  readonly stdin: {
    write(chunk: string): number | Promise<number>
    flush(): number | Promise<number>
    end(): number | Promise<number>
  }
  readonly stdout: ReadableStream<Uint8Array>
}

export interface AcpConnectionOptions extends AcpPipes {
  /** Each decoded `session/update`, in wire order. A throw fails the connection. */
  readonly onNotification: (notification: AcpSessionNotification) => void
  /** Each agent-to-client request, after the connection answered it with a
   *  JSON-RPC error. Flywheel serves none but the permission of its own tools
   *  (`allowedTools`): its agent has no default tools and it advertises no fs
   *  or terminal capability, so a request is a defect signal for the caller to
   *  act on. */
  readonly onAgentRequestRefused: (request: AcpRefusedAgentRequest) => void
  /** The names, as agy names them in a `session/request_permission`, of the
   *  tools of Flywheel's own MCP server, which the connection allows. agy asks
   *  permission for each MCP tool call, and a call it was refused never reaches
   *  Flywheel. Every other permission request stays refused. */
  readonly allowedTools?: ReadonlySet<string>
  readonly limits?: { readonly maxFrameChars?: number }
}

export interface AcpConnection {
  /** Sends one request and settles with its decoded result. It rejects with
   *  `AcpRequestError` when agy answers with an error, with
   *  `AcpConnectionClosed` when the connection ends first, and with the
   *  signal's reason when the signal aborts first. An abort writes nothing:
   *  agy keeps working on the request until the caller sends its own cancel,
   *  such as `session/cancel`, and its later response is dropped. */
  request<M extends AcpMethod>(method: M, params: AcpRequests[M]["params"], signal?: AbortSignal): Promise<AcpRequests[M]["result"]>
  /** Writes one notification. It rejects when the connection has ended. */
  notify<M extends keyof AcpNotifications>(method: M, params: AcpNotifications[M]): Promise<void>
  /** Settles once, when the connection ends for any reason. */
  readonly closed: Promise<AcpClose>
  /** Stops reading stdout, settles every pending request, and ends stdin
   *  after the notifications and replies already accepted, which asks agy to
   *  exit. It settles without waiting for agy to read them, so a stuck agy
   *  never holds it; its process stays with the owner. Repeated calls join
   *  the first. */
  close(): Promise<AcpClose>
}

/** A request awaiting its response. `accept` decodes the frame's result for the
 *  request's own method and settles it, or answers false when the result does
 *  not have that method's shape. */
interface PendingRequest {
  readonly method: AcpMethod
  readonly accept: (frame: Extract<AcpInboundFrame, { readonly kind: "result" }>) => boolean
  readonly reject: (error: Error) => void
}

/** The part of a `session/request_permission` that the connection reads, as agy
 *  1.5.14 sends it: `params.toolCall.name` names the tool, and `params.options`
 *  lists the answers, each with its `optionId` and `kind`. */
const PermissionRequestSchema = Schema.Struct({
  toolCall: Schema.Struct({ name: Schema.String }),
  options: Schema.Array(Schema.Struct({ optionId: Schema.String, kind: Schema.String })),
})
const decodePermissionRequest = Schema.decodeUnknownOption(PermissionRequestSchema)

/** The option that allows the request `frame` once, when it is a permission
 *  request for a tool of `allowedTools` that offers one. */
function allowOnceOption(frame: Extract<AcpInboundFrame, { readonly kind: "agent-request" }>, allowedTools: ReadonlySet<string>): string | undefined {
  if (frame.method !== "session/request_permission") return undefined
  const request = decodePermissionRequest(frame.params)
  if (Option.isNone(request) || !allowedTools.has(request.value.toolCall.name)) return undefined
  return request.value.options.find(({ kind }) => kind === "allow_once")?.optionId
}

/** Every frame the connection writes. */
type OutboundFrame =
  | { readonly jsonrpc: "2.0"; readonly id: number; readonly method: AcpMethod; readonly params: AcpRequests[AcpMethod]["params"] }
  | { readonly jsonrpc: "2.0"; readonly method: keyof AcpNotifications; readonly params: AcpNotifications[keyof AcpNotifications] }
  | { readonly jsonrpc: "2.0"; readonly id: AcpJsonRpcId; readonly error: { readonly code: number; readonly message: string } }
  | { readonly jsonrpc: "2.0"; readonly id: AcpJsonRpcId; readonly result: { readonly outcome: { readonly outcome: "selected"; readonly optionId: string } } }

/** Opens a JSON-RPC 2.0 client over the newline-delimited pipes of one `agy
 *  acp` process. Every inbound frame is decoded at this boundary; a frame that
 *  does not decode fails the connection, because the bridge cannot account
 *  for a step whose frames it lost. */
export function openAcpConnection(options: AcpConnectionOptions): AcpConnection {
  const maxFrameChars = options.limits?.maxFrameChars ?? DEFAULT_MAX_FRAME_CHARS
  const pending = new Map<number, PendingRequest>()
  const unserved = { unknownUpdates: 0, unknownNotifications: 0, refusedAgentRequests: 0, unmatchedResponses: 0 }
  const unservedRepeats = coalesceRepeats<UnservedFrame>({
    windowMs: UNSERVED_REPEAT_WINDOW_MS,
    first: (_key, { condition, subject }) => log.warn(condition, { subject }),
    repeated: (_key, { count, events, windowMs }) => log.warn(`${events[0]?.condition} again`, { subject: events[0]?.subject, count, windowMs }),
  })
  const reportUnserved = (condition: string, subject: string): void => unservedRepeats.observe(`${condition}\0${subject}`, { condition, subject })
  const reader = options.stdout.getReader()
  let nextId = 1
  let writeTail: Promise<unknown> = Promise.resolve()
  let ending: AcpCloseReason | null = null
  let settleClosed!: (close: AcpClose) => void
  const closed = new Promise<AcpClose>((resolve) => {
    settleClosed = resolve
  })

  /** The first end decides the reason. Pending requests settle at once, so
   *  their queued frames are skipped; the notifications and replies already
   *  queued still drain before stdin ends, so a cancel sent just before the
   *  close still reaches agy. */
  const end = (reason: AcpCloseReason): Promise<AcpClose> => {
    if (ending) return closed
    ending = reason
    for (const request of pending.values()) request.reject(new AcpConnectionClosed(request.method, reason))
    pending.clear()
    unservedRepeats.end()
    // Unblocks a pending read; the read loop releases the lock when it exits.
    void reader.cancel().catch(() => {})
    void writeTail.then(() => options.stdin.end()).catch(() => {})
    const failed = reason.kind !== "ended" && reason.kind !== "closed"
    if (failed) log.warn("ACP connection failed", { reason: reason.kind, ...unserved })
    else log.debug("ACP connection ended", { reason: reason.kind, ...unserved })
    settleClosed({ reason, unserved: { ...unserved } })
    return closed
  }

  /** Queues one frame. `wanted` is asked again when the frame's turn comes,
   *  so a request that settled while it waited is never written. */
  const write = (frame: OutboundFrame, wanted: () => boolean = () => true): Promise<void> => {
    if (ending) return Promise.reject(new Error(`ACP connection has ended (${ending.kind})`))
    const record = `${JSON.stringify(frame)}\n`
    const written = writeTail.then(async () => {
      if (!wanted()) return
      await options.stdin.write(record)
      await options.stdin.flush()
    })
    writeTail = written.catch(() => {})
    return written.catch((cause: unknown) => {
      void end({ kind: "failed", detail: `write failed: ${errorMessage(cause)}` })
      throw cause
    })
  }

  const dispatch = (frame: AcpInboundFrame): void => {
    switch (frame.kind) {
      case "result":
      case "error": {
        const request = typeof frame.id === "number" ? pending.get(frame.id) : undefined
        if (request === undefined || typeof frame.id !== "number") {
          unserved.unmatchedResponses += 1
          return
        }
        if (frame.kind === "error") {
          pending.delete(frame.id)
          request.reject(new AcpRequestError(request.method, frame.error))
          return
        }
        // A result that does not decode stays pending, so the end it causes
        // settles it with the connection's reason.
        if (request.accept(frame)) pending.delete(frame.id)
        else void end({ kind: "malformed", frame: `${request.method} result` })
        return
      }
      case "agent-request": {
        const allowed = allowOnceOption(frame, options.allowedTools ?? new Set())
        if (allowed !== undefined) {
          log.debug("ACP permission request of a Flywheel tool allowed", { sessionId: agentRequestSessionId(frame.params) })
          void write({ jsonrpc: "2.0", id: frame.id, result: { outcome: { outcome: "selected", optionId: allowed } } }).catch(() => {})
          return
        }
        unserved.refusedAgentRequests += 1
        reportUnserved("ACP agent request refused", frame.method)
        void write({ jsonrpc: "2.0", id: frame.id, error: { code: ACP_METHOD_NOT_FOUND, message: `Flywheel does not serve ${frame.method}` } }).catch(() => {})
        options.onAgentRequestRefused({ method: frame.method, sessionId: agentRequestSessionId(frame.params) })
        return
      }
      case "notification": {
        if (frame.method !== "session/update") {
          unserved.unknownNotifications += 1
          reportUnserved("ACP notification of an unknown method ignored", frame.method)
          return
        }
        const notification = decodeSessionNotification(frame.params)
        if (Option.isNone(notification)) {
          void end({ kind: "malformed", frame: "session/update" })
          return
        }
        const update = notification.value.update
        if (update.sessionUpdate === "unknown") {
          unserved.unknownUpdates += 1
          reportUnserved("ACP session update of an unknown kind", update.reportedKind)
        }
        options.onNotification(notification.value)
        return
      }
    }
  }

  const parseLine = (line: string): void => {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      void end({ kind: "malformed", frame: "non-JSON line" })
      return
    }
    const frame = decodeInboundFrame(raw)
    if (Option.isNone(frame)) {
      void end({ kind: "malformed", frame: "non-JSON-RPC frame" })
      return
    }
    dispatch(frame.value)
  }

  /** Reads until stdout ends or the connection ends for another reason; the
   *  reason it returns is ignored in the second case, because `end` keeps the
   *  first. A frame that a read returns after the end began is not passed on.
   *  agy ends every frame with a newline in UTF-8, so stdout that ends inside
   *  a frame, or bytes that are not UTF-8, mean a frame was lost. */
  const read = async (): Promise<AcpCloseReason> => {
    const decoder = new TextDecoder("utf-8", { fatal: true })
    let buffered = ""
    try {
      while (true) {
        const chunk = await reader.read()
        if (ending) return ending
        try {
          buffered += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
        } catch {
          return { kind: "malformed", frame: "invalid UTF-8" }
        }
        if (chunk.done) return buffered.trim() ? { kind: "malformed", frame: "truncated frame" } : { kind: "ended" }
        const reason = drainLines()
        if (reason) return reason
      }
    } finally {
      reader.releaseLock()
    }

    /** Passes on every complete line in `buffered`, and answers the reason
     *  when a line or the remainder fails the connection. */
    function drainLines(): AcpCloseReason | undefined {
      let newline = buffered.indexOf("\n")
      while (newline >= 0) {
        const line = buffered.slice(0, newline).replace(/\r$/, "")
        buffered = buffered.slice(newline + 1)
        if (line.length > maxFrameChars) return { kind: "frame-too-large", limitChars: maxFrameChars }
        if (line.trim()) parseLine(line)
        // A frame that ended the connection, or an observer that closed it, ends the read.
        if (ending) return ending
        newline = buffered.indexOf("\n")
      }
      return buffered.length > maxFrameChars ? { kind: "frame-too-large", limitChars: maxFrameChars } : undefined
    }
  }

  void read().then(
    (reason) => end(reason),
    (cause: unknown) => end({ kind: "failed", detail: `read failed: ${errorMessage(cause)}` }),
  )

  return {
    request(method, params, signal) {
      if (ending) return Promise.reject(new AcpConnectionClosed(method, ending))
      if (signal?.aborted) return Promise.reject(abortReason(signal))
      const id = nextId++
      return new Promise((resolve, reject) => {
        const onAbort = (): void => {
          if (pending.delete(id)) reject(abortReason(signal))
        }
        const settle = (): void => signal?.removeEventListener("abort", onAbort)
        pending.set(id, {
          method,
          accept: (frame) => {
            const result = decodeAcpResult(method, frame.result)
            if (Option.isNone(result)) return false
            settle()
            resolve(result.value)
            return true
          },
          reject: (error) => {
            settle()
            reject(error)
          },
        })
        signal?.addEventListener("abort", onAbort, { once: true })
        // A failed write ends the connection, which settles this request.
        write({ jsonrpc: "2.0", id, method, params }, () => pending.has(id)).catch(() => {})
      })
    },
    notify(method, params) {
      return write({ jsonrpc: "2.0", method, params })
    },
    closed,
    close: () => end({ kind: "closed" }),
  }
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason
  return reason instanceof Error ? reason : new Error("ACP request was aborted")
}
