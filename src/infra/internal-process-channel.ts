import { chmod, unlink } from "node:fs/promises"
import { pack, unpack } from "msgpackr"

const LENGTH_BYTES = 4
const FLAG_BYTES = 1
const HEADER_BYTES = LENGTH_BYTES + FLAG_BYTES
const FLAG_COMPLETE = 0
const FLAG_FRAGMENT = 1
const FLAG_FINAL_FRAGMENT = 2
const DEFAULT_MAX_FRAME_BYTES = 1_048_576
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1_048_576
const DEFAULT_MAX_QUEUED_BYTES = 4_194_304

export type InternalProcessDecoder<Message> = (value: unknown) => Message | undefined

/** A typed, bounded point-to-point channel owned by one process generation. */
export interface InternalProcessEndpoint<Outgoing, Incoming> {
  readonly closed: Promise<void>
  send(message: Outgoing): Promise<void>
  onMessage(handler: (message: Incoming) => void | Promise<void>): () => void
  onClose(handler: (reason: Error) => void): () => void
  close(reason?: string): void
}

export interface InternalProcessFrameDecoder {
  /** Accepts retained transport bytes. False means the frame stream is invalid and must be closed. */
  push(bytes: Uint8Array): boolean
}

/** The size bounds one channel applies to its frames and messages. A frame is
 *  the unit the wire carries and the unit flow control waits on; a message is
 *  what a caller sends and receives, and may span many frames. */
export interface InternalProcessChannelLimits {
  readonly maxFrameBytes?: number
  readonly maxMessageBytes?: number
  readonly maxQueuedBytes?: number
}

/** Encodes one message as MessagePack split into frames of at most
 *  `maxFrameBytes` payload each, every frame carrying a four-byte big-endian
 *  body length and one flag byte that says whether the body completes the
 *  message. Splitting at this layer is what lets callers send a message of any
 *  size up to `maxMessageBytes` without knowing the wire's frame size. */
export function encodeInternalProcessFrames(
  message: unknown,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
): Uint8Array[] {
  const payload = pack(message)
  if (payload.byteLength === 0) throw new Error("internal process message encodes to nothing")
  if (payload.byteLength > maxMessageBytes) throw new Error(`internal process message exceeds ${maxMessageBytes} bytes`)
  const frames: Uint8Array[] = []
  for (let offset = 0; offset < payload.byteLength; offset += maxFrameBytes) {
    const chunk = payload.subarray(offset, Math.min(offset + maxFrameBytes, payload.byteLength))
    const last = offset + chunk.byteLength >= payload.byteLength
    const flag = offset === 0 && last ? FLAG_COMPLETE : last ? FLAG_FINAL_FRAGMENT : FLAG_FRAGMENT
    const frame = new Uint8Array(HEADER_BYTES + chunk.byteLength)
    new DataView(frame.buffer).setUint32(0, FLAG_BYTES + chunk.byteLength)
    frame[LENGTH_BYTES] = flag
    frame.set(chunk, HEADER_BYTES)
    frames.push(frame)
  }
  return frames
}

/** Creates a streaming decoder that enforces the frame size before allocating
 *  a body and the message size before retaining another fragment. */
export function createInternalProcessFrameDecoder<Message>(options: {
  readonly maxFrameBytes?: number
  readonly maxMessageBytes?: number
  readonly decode: InternalProcessDecoder<Message>
  readonly onMessage: (message: Message) => void
}): InternalProcessFrameDecoder {
  const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
  const header = new Uint8Array(LENGTH_BYTES)
  let headerBytes = 0
  let body: Uint8Array | undefined
  let bodyBytes = 0
  let fragments: Uint8Array[] = []
  let fragmentBytes = 0
  let failed = false
  const fail = (): false => {
    failed = true
    return false
  }
  const deliver = (payload: Uint8Array): boolean => {
    let value: unknown
    try {
      value = unpack(payload)
    } catch {
      return fail()
    }
    const message = options.decode(value)
    if (message === undefined) return fail()
    options.onMessage(message)
    return true
  }
  return {
    push(bytes) {
      if (failed) return false
      let offset = 0
      while (offset < bytes.byteLength) {
        if (body === undefined) {
          const copied = Math.min(LENGTH_BYTES - headerBytes, bytes.byteLength - offset)
          header.set(bytes.subarray(offset, offset + copied), headerBytes)
          headerBytes += copied
          offset += copied
          if (headerBytes < LENGTH_BYTES) continue
          const length = new DataView(header.buffer).getUint32(0)
          if (length <= FLAG_BYTES || length > FLAG_BYTES + maxFrameBytes) return fail()
          body = new Uint8Array(length)
          bodyBytes = 0
        }
        const copied = Math.min(body.byteLength - bodyBytes, bytes.byteLength - offset)
        body.set(bytes.subarray(offset, offset + copied), bodyBytes)
        bodyBytes += copied
        offset += copied
        if (bodyBytes < body.byteLength) continue
        const flag = body[0]
        const chunk = body.subarray(FLAG_BYTES)
        body = undefined
        headerBytes = 0
        if (flag === FLAG_COMPLETE) {
          if (fragments.length > 0) return fail()
          if (!deliver(chunk)) return false
          continue
        }
        if (flag !== FLAG_FRAGMENT && flag !== FLAG_FINAL_FRAGMENT) return fail()
        if (fragmentBytes + chunk.byteLength > maxMessageBytes) return fail()
        fragments.push(chunk)
        fragmentBytes += chunk.byteLength
        if (flag === FLAG_FRAGMENT) continue
        const payload = new Uint8Array(fragmentBytes)
        let at = 0
        for (const fragment of fragments) {
          payload.set(fragment, at)
          at += fragment.byteLength
        }
        fragments = []
        fragmentBytes = 0
        if (!deliver(payload)) return false
      }
      return true
    },
  }
}

interface EndpointState<Incoming> {
  readonly messages: Set<(message: Incoming) => void | Promise<void>>
  readonly closes: Set<(reason: Error) => void>
  readonly closed: PromiseWithResolvers<void>
  reason?: Error
}

function endpointState<Incoming>(): EndpointState<Incoming> {
  return { messages: new Set(), closes: new Set(), closed: Promise.withResolvers<void>() }
}

function closeState<Incoming>(state: EndpointState<Incoming>, reason: string): void {
  if (state.reason) return
  state.reason = new Error(reason)
  for (const handler of state.closes) handler(state.reason)
  state.messages.clear()
  state.closes.clear()
  state.closed.resolve()
}

function publicEndpoint<Outgoing, Incoming>(
  state: EndpointState<Incoming>,
  send: (message: Outgoing) => Promise<void>,
  close: (reason: string) => void,
): InternalProcessEndpoint<Outgoing, Incoming> {
  return {
    closed: state.closed.promise,
    send(message) {
      if (state.reason) return Promise.reject(state.reason)
      return send(message)
    },
    // Dispatch iterates a copy of the handler set: a handler that subscribes
    // another handler while it runs (the credential check that attaches the
    // channel it just authenticated) hands that handler the next message, not
    // the one being dispatched.
    onMessage(handler) {
      if (!state.reason) state.messages.add(handler)
      return () => state.messages.delete(handler)
    },
    onClose(handler) {
      if (state.reason) handler(state.reason)
      else state.closes.add(handler)
      return () => state.closes.delete(handler)
    },
    close(reason = "internal process endpoint closed") {
      if (state.reason) return
      close(reason)
      closeState(state, reason)
    },
  }
}

/** Adapts an existing MessagePort without changing its structured-clone behavior. */
export function createMessagePortProcessEndpoint<Outgoing = unknown, Incoming = unknown>(options: {
  readonly port: MessagePort
  readonly decode: InternalProcessDecoder<Incoming>
}): InternalProcessEndpoint<Outgoing, Incoming> {
  const state = endpointState<Incoming>()
  const { port } = options
  port.addEventListener("message", (event) => {
    const message = options.decode(event.data)
    if (message === undefined) {
      port.close()
      closeState(state, "internal process endpoint received an invalid message")
      return
    }
    for (const handler of Array.from(state.messages)) void handler(message)
  })
  port.addEventListener("messageerror", () => {
    port.close()
    closeState(state, "internal process endpoint could not decode a message")
  })
  port.addEventListener("close", () => closeState(state, "internal process endpoint peer closed"))
  port.start()
  return publicEndpoint(
    state,
    async (message) => { port.postMessage(message) },
    () => port.close(),
  )
}

export interface SocketWriter {
  write(bytes: Uint8Array): number
  end(): void
}

export interface SocketConnection<Outgoing, Incoming> {
  readonly endpoint: InternalProcessEndpoint<Outgoing, Incoming>
  receive(bytes: Uint8Array): boolean
  drain(): void
  lost(reason: string): void
}

/** One socket-backed endpoint. The queue bound is a memory ceiling, not a
 *  reason to fail a message: a sender that would exceed it waits for the peer
 *  to drain, so a slow reader slows its writer the way a pipe does. Messages
 *  reach the wire in the order they were sent, whatever their sizes. Only an
 *  oversize frame, a failed write, or a closed endpoint rejects a send, and a
 *  lost peer releases every waiter through the closed state. */
export function createSocketProcessEndpoint<Outgoing, Incoming>(options: {
  readonly socket: SocketWriter
  readonly decode: InternalProcessDecoder<Incoming>
  readonly maxFrameBytes: number
  readonly maxMessageBytes: number
  readonly maxQueuedBytes: number
}): SocketConnection<Outgoing, Incoming> {
  const state = endpointState<Incoming>()
  let queuedBytes = 0
  let tail = Promise.resolve()
  let resumeDrain: (() => void) | undefined
  const waitForDrain = () => new Promise<void>((resolve) => { resumeDrain = resolve })
  const spaceWaiters = new Set<() => void>()
  const releaseSpace = (): void => {
    const waiters = [...spaceWaiters]
    spaceWaiters.clear()
    for (const resume of waiters) resume()
  }
  // Every close path settles `closed`, so waiters wake after the reason is set.
  void state.closed.promise.then(releaseSpace)
  const decoder = createInternalProcessFrameDecoder({
    maxFrameBytes: options.maxFrameBytes,
    maxMessageBytes: options.maxMessageBytes,
    decode: options.decode,
    onMessage(message) {
      for (const handler of Array.from(state.messages)) void handler(message)
    },
  })
  // A message larger than the whole queue still goes, alone, once the queue
  // is empty; the bound orders senders, it never refuses one.
  const hasRoom = (bytes: number): boolean => queuedBytes === 0 || queuedBytes + bytes <= options.maxQueuedBytes
  const waitForRoom = async (bytes: number): Promise<void> => {
    while (!hasRoom(bytes)) {
      if (state.reason) throw state.reason
      await new Promise<void>((resolve) => { spaceWaiters.add(resolve) })
    }
  }
  // The last send still waiting for room, or undefined when none waits.
  // Sends take room in the order they were made, so a small message never
  // overtakes a large one that waits: callers order their messages by
  // sending them, as the execution channel orders an output watch before
  // the reads that follow it.
  let admission: Promise<unknown> | undefined
  const enqueue = (frames: readonly Uint8Array[], bytes: number): Promise<void> => {
    queuedBytes += bytes
    const write = tail.then(async () => {
      for (const frame of frames) {
        let offset = 0
        while (offset < frame.byteLength) {
          if (state.reason) throw state.reason
          const written = options.socket.write(frame.subarray(offset))
          if (written < 0) throw new Error("internal process endpoint write failed")
          offset += written
          if (offset < frame.byteLength) await waitForDrain()
        }
      }
    }).finally(() => {
      queuedBytes -= bytes
      releaseSpace()
    })
    tail = write.catch(() => {})
    return write
  }
  const endpoint = publicEndpoint<Outgoing, Incoming>(state, async (message) => {
    const frames = encodeInternalProcessFrames(message, options.maxFrameBytes, options.maxMessageBytes)
    const bytes = frames.reduce((sum, frame) => sum + frame.byteLength, 0)
    if (admission === undefined && hasRoom(bytes)) return enqueue(frames, bytes)
    // The write joins the tail inside the turn, so the next waiting send
    // measures its room only after this one holds its bytes.
    const turn = (admission ?? Promise.resolve()).then(async () => {
      await waitForRoom(bytes)
      if (state.reason) throw state.reason
      return { write: enqueue(frames, bytes) }
    })
    const settled = turn.catch(() => {})
    admission = settled
    void settled.then(() => { if (admission === settled) admission = undefined })
    return turn.then(({ write }) => write)
  }, () => options.socket.end())
  return {
    endpoint,
    receive(bytes) {
      const accepted = decoder.push(bytes)
      if (!accepted) endpoint.close("internal process endpoint received an invalid frame")
      return accepted
    },
    drain() {
      const resume = resumeDrain
      resumeDrain = undefined
      resume?.()
    },
    lost(reason) {
      const resume = resumeDrain
      resumeDrain = undefined
      resume?.()
      closeState(state, reason)
    },
  }
}

export interface InternalProcessChannelServer {
  readonly ready: Promise<void>
  dispose(): Promise<void>
}

/** Listens on an owner-only Unix socket or Windows named pipe. Each accepted connection is independently bounded. */
export function listenInternalProcessChannel<Outgoing, Incoming>(options: InternalProcessChannelLimits & {
  readonly path: string
  readonly decode: InternalProcessDecoder<Incoming>
  readonly onConnection: (endpoint: InternalProcessEndpoint<Outgoing, Incoming>) => void
}): InternalProcessChannelServer {
  const limits = resolveLimits(options)
  const live = new Map<Bun.Socket<undefined>, SocketConnection<Outgoing, Incoming>>()
  const server = Bun.listen<undefined>({
    unix: options.path,
    socket: {
      open(socket) {
        const connection = createSocketProcessEndpoint({ socket, decode: options.decode, ...limits })
        live.set(socket, connection)
        options.onConnection(connection.endpoint)
      },
      data(socket, bytes) { live.get(socket)?.receive(new Uint8Array(bytes)) },
      drain(socket) { live.get(socket)?.drain() },
      close(socket) { live.get(socket)?.lost("internal process endpoint peer closed"); live.delete(socket) },
      error(socket, cause) { live.get(socket)?.lost(`internal process endpoint failed: ${String(cause)}`); live.delete(socket) },
    },
  })
  const ready = process.platform === "win32" ? Promise.resolve() : chmod(options.path, 0o600)
  return {
    ready,
    async dispose() {
      server.stop(true)
      for (const connection of live.values()) connection.endpoint.close("internal process channel server closed")
      await Promise.all([...live.values()].map((connection) => connection.endpoint.closed))
      live.clear()
      if (process.platform !== "win32") await unlink(options.path).catch(() => {})
    },
  }
}

/** Connects to one owner-only Unix socket or Windows named pipe. */
export function connectInternalProcessChannel<Outgoing, Incoming>(options: InternalProcessChannelLimits & {
  readonly path: string
  readonly decode: InternalProcessDecoder<Incoming>
}): Promise<InternalProcessEndpoint<Outgoing, Incoming>> {
  const limits = resolveLimits(options)
  return new Promise((resolve, reject) => {
    let connection: SocketConnection<Outgoing, Incoming> | undefined
    Bun.connect<undefined>({
      unix: options.path,
      socket: {
        open(socket) {
          connection = createSocketProcessEndpoint({ socket, decode: options.decode, ...limits })
          resolve(connection.endpoint)
        },
        data(_socket, bytes) { connection?.receive(new Uint8Array(bytes)) },
        drain() { connection?.drain() },
        close() { connection?.lost("internal process endpoint peer closed") },
        error(_socket, cause) { connection?.lost(`internal process endpoint failed: ${String(cause)}`) },
        connectError(_socket, cause) { reject(cause) },
      },
    }).catch(reject)
  })
}

function resolveLimits(limits: InternalProcessChannelLimits): Required<InternalProcessChannelLimits> {
  return {
    maxFrameBytes: limits.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
    maxMessageBytes: limits.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
    maxQueuedBytes: limits.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES,
  }
}
