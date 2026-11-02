import type { Socket as BunSocket } from "bun"
import { Effect, Fiber, FiberSet, Layer, Scope } from "effect"
import { Socket, SocketServer } from "effect/unstable/socket"
import { ACCOUNT_ATTACH_LATER_MAX_BYTES, createAccountAttachResponseReader } from "../../protocol/account-attach.js"
import type { RuntimeStartupPhase } from "../../protocol/app-service-types.js"
import { AccountAttachFailedError } from "../../protocol/app-service-types.js"

/** The accepted client handle Bun hands each handler. Held as a map key and
 *  never inspected, but named so the release path states what it owns. */
type ClientSocket = BunSocket<undefined>

/** Bun adapters for Effect's socket RPC transport, one per side of the
 *  channel. Effect core ships the platform-neutral `Socket` and `SocketServer`
 *  contracts and the RPC protocol over them, but no Bun implementation; the
 *  server layer is that implementation over `Bun.listen` and the client layer
 *  over `Bun.connect`, the same way `bun-worker-rpc.ts` is that implementation
 *  over the Web Worker API. One stream adapter serves both sides, so a
 *  connection reads and writes with the same backpressure whichever end of it
 *  this process holds.
 *
 *  The address is a filesystem path, so the filesystem is the access control:
 *  a socket created under a directory only its owner can enter is reachable
 *  only by that owner. No port is bound, so nothing is reachable off-host and
 *  no token has to be minted, held, or rotated to keep it that way. */

/** Bun hands `data` a view it is free to reuse once the callback returns, while
 *  the reader that consumes it is an async stream that outlives the callback by
 *  construction. Every chunk is therefore copied at the boundary. This costs one
 *  copy per read on a local socket, and buys the reader the only thing that
 *  makes it correct: bytes that stay the bytes that arrived. */
function retainedChunk(chunk: Uint8Array): Uint8Array {
  return new Uint8Array(chunk)
}

interface BunSocketLike {
  write(data: Uint8Array): number
  end(): void
  terminate(): void
  pause(): void
  resume(): void
}

/** One accepted connection: the streams the RPC protocol reads and writes, and
 *  the three socket events this side has to feed back into them. The owner is
 *  the listener callback set, which has no other way to reach a connection's
 *  stream state. */
interface AcceptedConnection {
  readonly streams: Socket.InputTransformStream
  /** The socket's one writer, which the writable stream also writes through. */
  readonly write: (chunk: Uint8Array) => Promise<void>
  readonly onData: (chunk: Uint8Array) => void
  readonly onDrain: () => void
  readonly onClose: (cause?: unknown) => void
}

interface LiveConnection {
  readonly transport: AcceptedConnection
  readonly handler: Fiber.Fiber<unknown, unknown>
}

/** One accepted connection as the two web streams `Socket.fromTransformStream`
 *  consumes. Both directions carry real backpressure rather than an unbounded
 *  buffer, because the runtime publishes output deltas onto this lane and a
 *  client that stops reading must slow the writer down instead of growing a
 *  backlog in runtime memory. */
function connectionStreams(socket: BunSocketLike): AcceptedConnection {
  let readController: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false
  // Set while a write was accepted only in part. Bun reports the byte count it
  // took, and the rest is this socket's obligation until `drain` says the
  // kernel buffer has room again.
  let pendingDrain: (() => void) | undefined

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      readController = controller
    },
    // The reader drained what it had, so more bytes are welcome again.
    pull() {
      socket.resume()
    },
    cancel() {
      socket.end()
    },
  })

  // Partial write: park the writer until Bun reports drain. The stream contract
  // turns that wait into backpressure for whoever is producing.
  const drained = (): Promise<void> =>
    new Promise<void>((resolve) => {
      pendingDrain = resolve
    })

  // A write after the peer is gone completes without delivering. The RPC
  // server ends every client with a final frame and opens its shutdown latch
  // only after that write settles, so a failure here would leave a stopping
  // service waiting forever on a client that already left. The readable has
  // already reported the close, so nothing mistakes the discard for delivery.
  const writeWhole = async (chunk: Uint8Array): Promise<void> => {
    let offset = 0
    while (offset < chunk.length) {
      if (closed) return
      const written = socket.write(chunk.subarray(offset))
      if (written < 0) return
      offset += written
      if (offset >= chunk.length) return
      await drained()
    }
  }
  // Every write to this socket queues behind the one before it, so the bytes
  // of two frames never interleave and only one writer waits for drain.
  let writing = Promise.resolve()
  const write = (chunk: Uint8Array): Promise<void> => {
    writing = writing.then(() => writeWhole(chunk))
    return writing
  }
  const writable = new WritableStream<Uint8Array>({
    write,
    close() {
      socket.end()
    },
    abort() {
      socket.terminate()
    },
  })

  return {
    streams: { readable, writable },
    write,
    onData(chunk) {
      readController?.enqueue(retainedChunk(chunk))
      // A reader that has stopped keeping up leaves no room in the queue.
      // Stop reading from the kernel rather than buffering without bound.
      if ((readController?.desiredSize ?? 1) <= 0) socket.pause()
    },
    onDrain() {
      const resume = pendingDrain
      pendingDrain = undefined
      resume?.()
    },
    onClose(cause) {
      if (closed) return
      closed = true
      // A parked writer must not outlive its socket, or the fiber holding it
      // never settles and the connection's scope never closes.
      const resume = pendingDrain
      pendingDrain = undefined
      resume?.()
      if (cause === undefined) readController?.close()
      else readController?.error(cause)
    },
  }
}

/** How long a connection attempt waits before the address counts as dead.
 *  This only ever dials a local socket, where a live listener accepts at once
 *  and a dead one refuses at once; the bound exists so a listener whose owner
 *  is wedged cannot hang the client. */
const CONNECT_TIMEOUT_MS = 5_000

/** One outbound connection to the runtime listening at `path`, as the two web
 *  streams `Socket.fromTransformStream` consumes. The connection is acquired
 *  when the effect runs and ended when its scope closes, so a reconnecting
 *  client builds this afresh for every attach and a dead socket is never
 *  retried. `before` runs first on every attempt: the terminal uses it to find
 *  or start the runtime, so an address nobody serves becomes a runtime start
 *  rather than a refused dial.
 *
 *  The wait for the runtime's answer can be abandoned. A stopped account
 *  service still accepts a connection into its kernel backlog and answers
 *  nothing, so an attach can wait for as long as the service stays stopped.
 *  A scope that closes during that wait ends the dial at once, so the client
 *  that gave up on the attach disposes it and dials again instead of waiting
 *  in the disposal for an answer that may never come. Once the dial settles,
 *  its release is registered before anything can interrupt it. */
function connectBunSocket(
  path: string,
  before?: () => Promise<void>,
  initialBytes?: () => Uint8Array | Promise<Uint8Array>,
  onStartupPhase?: (phase: RuntimeStartupPhase) => void,
): Effect.Effect<Socket.InputTransformStream, Socket.SocketError, Scope.Scope> {
  return Effect.uninterruptibleMask((restore) =>
    restore(Effect.tryPromise({
      try: async (signal) => {
        await before?.()
        signal.throwIfAborted()
        return await dial(path, initialBytes, onStartupPhase, signal)
      },
      catch: (cause) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) }),
    })).pipe(
      Effect.tap((connection) => Effect.addFinalizer(() => Effect.sync(() => connection.socket.end()))),
      Effect.map((connection) => connection.transport.streams),
    ))
}

interface DialedConnection {
  readonly socket: BunSocket<undefined>
  readonly transport: AcceptedConnection
}

function dial(
  path: string,
  initialBytes: (() => Uint8Array | Promise<Uint8Array>) | undefined,
  onStartupPhase: ((phase: RuntimeStartupPhase) => void) | undefined,
  signal: AbortSignal,
): Promise<DialedConnection> {
  return new Promise<DialedConnection>((resolve, reject) => {
    let transport: AcceptedConnection | undefined
    let opened: BunSocket<undefined> | undefined
    const attach = initialBytes ? createAccountAttachResponseReader(onStartupPhase) : undefined
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`no answer from ${path} within ${CONNECT_TIMEOUT_MS}ms`))
    }, CONNECT_TIMEOUT_MS)
    timer.unref?.()
    // A dial abandoned before it settled ends its own socket: its caller
    // never received the connection, so no release exists for it.
    signal.addEventListener("abort", () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opened?.end()
      reject(signal.reason)
    }, { once: true })
    Bun.connect<undefined>({
      unix: path,
      socket: {
        async open(socket) {
          if (settled) {
            socket.end()
            return
          }
          opened = socket
          transport = connectionStreams(socket)
          if (initialBytes) {
            try {
              await transport.write(await initialBytes())
            } catch (cause) {
              socket.end()
              if (!settled) {
                settled = true
                clearTimeout(timer)
                reject(cause)
              }
              return
            }
            clearTimeout(timer)
            return
          }
          if (settled) {
            socket.end()
            return
          }
          settled = true
          clearTimeout(timer)
          resolve({ socket, transport })
        },
        data(socket, chunk) {
          if (!transport) return
          if (!attach || settled) {
            transport.onData(chunk)
            return
          }
          const result = attach.push(chunk)
          if (result.kind === "pending" || result.kind === "starting") return
          if (result.kind === "failed") {
            settled = true
            socket.end()
            reject(new AccountAttachFailedError(result.error, result.refusal))
            return
          }
          // This attach names no client identity, so a cutover or client
          // response answers a question this connection never asked.
          if (result.kind !== "ready") {
            settled = true
            socket.end()
            reject(new Error(`account service answered a project attach with ${result.kind}`))
            return
          }
          settled = true
          if (result.remainder.length > 0) transport.onData(result.remainder)
          resolve({ socket, transport })
        },
        drain() {
          transport?.onDrain()
        },
        close() {
          transport?.onClose()
          if (!settled) {
            settled = true
            clearTimeout(timer)
            reject(new Error(`connection to ${path} closed before project readiness`))
          }
        },
        error(_socket, cause) {
          transport?.onClose(cause)
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(cause)
        },
        connectError(_socket, cause) {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(cause)
        },
      },
    }).catch((cause: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(cause)
    })
  })
}

/** A `Socket` connected to the runtime listening at `path`. */
export function bunSocketClientLayer(
  path: string,
  before?: () => Promise<void>,
  initialBytes?: () => Uint8Array | Promise<Uint8Array>,
  onStartupPhase?: (phase: RuntimeStartupPhase) => void,
): Layer.Layer<Socket.Socket> {
  return Layer.effect(Socket.Socket)(Socket.fromTransformStream(connectBunSocket(path, before, initialBytes, onStartupPhase)))
}

export interface BunSocketServerOptions {
  /** Filesystem path to bind. On Windows this is a named pipe path, which Bun
   *  accepts through the same option. */
  readonly path: string
  /** Called once the listener is bound, before any connection is accepted. The
   *  endpoint is only advertised after this, so a client that finds the socket
   *  always finds something listening on it. */
  readonly onListening?: () => void
  /** Called as each connection opens and closes, so the host can decide when it
   *  has been unused long enough to exit. */
  readonly onConnectionCountChanged?: (open: number) => void
}

/** Server side: a `SocketServer` over one bound Bun unix socket. Each accepted
 *  connection becomes an Effect `Socket` handed to the RPC protocol's handler,
 *  and every connection fiber belongs to this server's scope, so closing the
 *  server settles them rather than leaving orphaned readers on dead sockets. */
export function bunSocketServerLayer(options: BunSocketServerOptions): Layer.Layer<SocketServer.SocketServer> {
  return Layer.effect(SocketServer.SocketServer)(Effect.sync(() =>
    SocketServer.SocketServer.of({
      address: { _tag: "UnixAddress", path: options.path },
      run: <R, E, _>(handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>) =>
        Effect.scopedWith((scope) =>
          Effect.gen(function*() {
            const fiberSet = yield* FiberSet.make<unknown, unknown>().pipe(Scope.provide(scope))
            const runFork = yield* FiberSet.runtime(fiberSet)<R>()
            let open = 0

            const connections = new WeakMap<ClientSocket, LiveConnection>()
            /** Releases a connection exactly once, whichever handler reports it
             *  first. Map membership is the count's authority rather than a
             *  second tally: `error` used to tear the transport down without
             *  decrementing, and `close` decremented whether or not the socket
             *  was still held, so the two could disagree about how many
             *  clients were attached. The idle reaper arms on that number
             *  reaching zero, and a runtime that never sees zero never reaps. */
            const release = (socket: ClientSocket, cause?: Error): void => {
              const connection = connections.get(socket)
              if (!connection) return
              connection.transport.onClose(cause)
              Effect.runFork(Fiber.interrupt(connection.handler))
              connections.delete(socket)
              open -= 1
              options.onConnectionCountChanged?.(open)
            }
            const server = Bun.listen<undefined>({
              unix: options.path,
              socket: {
                open(socket) {
                  const transport = connectionStreams(socket)
                  const handlerFiber = runFork(Effect.flatMap(
                    Socket.fromTransformStream(Effect.succeed(transport.streams)),
                    (accepted) => handler(accepted),
                  ))
                  connections.set(socket, { transport, handler: handlerFiber })
                  open += 1
                  options.onConnectionCountChanged?.(open)
                },
                data(socket, chunk) {
                  connections.get(socket)?.transport.onData(chunk)
                },
                drain(socket) {
                  connections.get(socket)?.transport.onDrain()
                },
                close(socket) {
                  release(socket)
                },
                error(socket, cause) {
                  release(socket, cause)
                },
              },
            })
            yield* Scope.addFinalizer(scope, Effect.sync(() => server.stop(true)))
            options.onListening?.()
            // The server runs until its scope closes; the RPC protocol forks
            // this and owns that scope.
            return yield* Effect.never
          })
        ),
    })
  ))
}

export interface BunRawSocketConnection {
  readonly socketLayer: Layer.Layer<Socket.Socket>
  readonly receive: (bytes: Uint8Array) => void
  /** Writes one whole frame before any later write, through the same writer
   *  as the RPC stream, and settles once the socket took its last byte. */
  readonly send: (bytes: Uint8Array) => Promise<void>
  readonly close: () => void
}

export interface BunRawSocketServer {
  readonly ready: Promise<void>
  /** Stops listening and ends every accepted connection, at once. Stopping a
   *  unix listener removes its socket path by name, whoever bound that path
   *  last, so its owner stops it before a successor can bind the path and
   *  never after. */
  readonly close: () => void
  /** Closes the server if it is still open, and settles once each accepted
   *  connection's delivered data has been handled. */
  readonly dispose: () => Promise<void>
}

/** Owns one Bun unix listener while leaving admission and per-connection RPC
 * composition to the account service. The stream adapter is the same bounded,
 * backpressured transport used by the legacy socket server. Input awaiting
 * dispatch is bounded before copying while an earlier callback is pending. */
export function createBunRawSocketServer(options: {
  readonly path: string
  readonly onOpen: (connection: BunRawSocketConnection) => void
  readonly onData: (connection: BunRawSocketConnection, bytes: Uint8Array) => void | Promise<void>
  readonly onClose: (connection: BunRawSocketConnection) => void
}): BunRawSocketServer {
  const ready = Promise.withResolvers<void>()
  const live = new Map<ClientSocket, {
    readonly handle: BunRawSocketConnection
    readonly transport: AcceptedConnection
    pending: Promise<void>
    pendingBytes: number
  }>()
  const release = (socket: ClientSocket, cause?: Error): void => {
    const connection = live.get(socket)
    if (!connection) return
    live.delete(socket)
    connection.transport.onClose(cause)
    options.onClose(connection.handle)
  }
  const server = Bun.listen<undefined>({
    unix: options.path,
    socket: {
      open(socket) {
        const transport = connectionStreams(socket)
        const handle = {
          socketLayer: Layer.effect(Socket.Socket)(Socket.fromTransformStream(Effect.succeed(transport.streams))),
          receive: transport.onData,
          send: transport.write,
          close: () => socket.end(),
        }
        live.set(socket, { handle, transport, pending: Promise.resolve(), pendingBytes: 0 })
        options.onOpen(handle)
      },
      data(socket, bytes) {
        const connection = live.get(socket)
        if (!connection) return
        if (connection.pendingBytes + bytes.length > ACCOUNT_ATTACH_LATER_MAX_BYTES) {
          release(socket)
          socket.terminate()
          return
        }
        const retained = retainedChunk(bytes)
        connection.pendingBytes += retained.length
        connection.pending = connection.pending.then(
          () => {
            connection.pendingBytes -= retained.length
            if (live.get(socket) === connection) return options.onData(connection.handle, retained)
          },
        ).catch((cause: unknown) => {
          release(socket, cause instanceof Error ? cause : new Error(String(cause)))
          socket.end()
        })
      },
      drain(socket) {
        live.get(socket)?.transport.onDrain()
      },
      close(socket) {
        release(socket)
      },
      error(socket, cause) {
        release(socket, cause)
      },
    },
  })
  ready.resolve()
  let closed: Promise<void> | undefined
  const close = (): void => {
    if (closed) return
    const admitted = [...live.entries()]
    server.stop(true)
    const pending = admitted.map(([socket, connection]) => {
      socket.end()
      return connection.pending
    })
    closed = Promise.all(pending).then(() => {
      for (const socket of live.keys()) release(socket)
    })
  }
  return {
    ready: ready.promise,
    close,
    async dispose() {
      close()
      await closed
    },
  }
}
