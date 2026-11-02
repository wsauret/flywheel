import type { Server, ServerWebSocket } from "bun"
import { Effect, Fiber, FiberSet, Layer, Scope } from "effect"
import { Socket, SocketServer } from "effect/unstable/socket"

import { Log } from "../../infra/log.js"
import { isServedOrigin } from "./web-serving/origin-check.js"
import { authorizeToken } from "./web-serving/token-auth.js"

/** The loopback browser placement of the runtime protocol server: a
 *  `SocketServer` whose accepted connections are WebSocket upgrades from a
 *  browser on this machine.
 *
 *  `bun-socket-rpc.ts` accepts from a bound unix socket and
 *  `relay-socket-server.ts` from relay channels. This binds one HTTP listener
 *  on `127.0.0.1`, at the project's own port when that port is free: every
 *  path but `/socket` serves the web client's static files, and `/socket`
 *  becomes a protocol connection only when the page's Origin is this
 *  listener's own and it presents the runtime's token as the WebSocket
 *  subprotocol. From the RPC protocol's side the three servings are the same
 *  thing: one accepted socket is one client with one handler fiber. */

const HOSTNAME = "127.0.0.1"
const SOCKET_PATH = "/socket"

const log = Log.create({ service: "web-socket-server" })

/** Bytes a socket may hold unsent before its writer parks. Bun drops every
 *  send made while a socket buffers more than its `backpressureLimit`
 *  (16 MiB by default), so the writer must stop well below it. One large
 *  frame into a buffer under the mark always goes through. The relay
 *  channel's writer parks at the same 1 MiB. */
const WRITE_HIGH_WATER_BYTES = 1024 * 1024
/** Try Again Later: the server cannot serve this lane now, and a new one
 *  will. The relay closes a lane whose peer does not drain with it too. */
const DROPPED_FRAME_CLOSE_CODE = 1013
const DROPPED_FRAME_CLOSE_REASON = "frame dropped under backpressure"

export interface WebSocketServerOptions {
  readonly token: string
  /** The port to bind when it is free. Another program holding it is not a
   *  failure: the listener binds an ephemeral port instead and reports the
   *  one it got, and the identity record carries that to the browser. */
  readonly port: number
  readonly staticResponse: (request: Request) => Response | Promise<Response>
  readonly onListening?: (endpoint: { readonly origin: string; readonly port: number }) => void
  readonly onConnectionCountChanged?: (open: number) => void
}

interface AcceptedWebSocket {
  readonly streams: Socket.InputTransformStream
  readonly receive: (message: string | ArrayBuffer | Uint8Array) => void
  readonly drain: () => void
  readonly close: () => void
}

interface LiveWebSocket {
  readonly transport: AcceptedWebSocket
  readonly handler: Fiber.Fiber<unknown, unknown>
}

/** Adapts one accepted WebSocket to the stream pair Effect's `Socket` reads
 *  and writes. The readable ends exactly once, whichever side ends it first:
 *  the reader cancelling closes the socket, and the socket closing ends the
 *  reader, and neither may touch a controller the other already settled. */
function websocketStreams(socket: ServerWebSocket<undefined>): AcceptedWebSocket {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let readableOpen = true
  let closed = false
  let pendingDrain: (() => void) | undefined
  const resumeDrain = (): void => {
    const resume = pendingDrain
    pendingDrain = undefined
    resume?.()
  }
  const drained = (): Promise<void> => new Promise<void>((resolve) => { pendingDrain = resolve })
  const readable = new ReadableStream<Uint8Array>({
    start(value) { controller = value },
    cancel() {
      readableOpen = false
      socket.close()
    },
  })
  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      // A write after the peer is gone completes without delivering, for the
      // same reason as the unix transport: the RPC server's final frame to a
      // departed client must settle for the server's disposal to settle.
      if (closed) return
      // Bun's send returns the bytes written, -1 when the frame was queued
      // under backpressure, and 0 when it was dropped. Bun drops a send only
      // when the socket already buffers more than its backpressure limit, so
      // with the park below a 0 on an open socket means that invariant broke.
      // The lane cannot continue with a frame missing, so it ends as an
      // ordinary close, and the client reconnects and reads everything again.
      if (socket.send(chunk, true) === 0) {
        log.info("browser socket dropped a frame; closing the connection", { frameBytes: chunk.byteLength, bufferedBytes: socket.getBufferedAmount() })
        socket.close(DROPPED_FRAME_CLOSE_CODE, DROPPED_FRAME_CLOSE_REASON)
        return
      }
      // Drain fires as the buffer shrinks, not only when it empties, so the
      // mark is rechecked after each one.
      while (socket.getBufferedAmount() > WRITE_HIGH_WATER_BYTES) {
        await drained()
        if (closed) return
      }
    },
    close() { socket.close() },
    abort() { socket.close() },
  })
  return {
    streams: { readable, writable },
    receive(message) {
      if (typeof message === "string") {
        socket.close(1003, "binary messages required")
        return
      }
      if (readableOpen) controller?.enqueue(new Uint8Array(message))
    },
    drain: resumeDrain,
    close() {
      if (closed) return
      closed = true
      resumeDrain()
      if (readableOpen) {
        readableOpen = false
        controller?.close()
      }
    },
  }
}

/** The header a browser page presents the runtime's token in. A subprotocol
 *  rides the upgrade request the way a bearer header would, which the browser
 *  WebSocket API cannot set; a query string would put the token in every
 *  place a URL is recorded. The server must echo the one it selects, or the
 *  browser fails the handshake. */
const TOKEN_PROTOCOL_HEADER = "Sec-WebSocket-Protocol"

/** The token this request presents. An upgrade carries it as the
 *  subprotocol; a plain request carries it as a bearer, which is how the page
 *  asks whether its stored token still opens this runtime without opening a
 *  socket, since a browser reports a refused upgrade only as a failure. */
function presentedToken(request: Request): string | undefined {
  const bearer = request.headers.get("Authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1]
  return bearer ?? request.headers.get(TOKEN_PROTOCOL_HEADER)?.trim()
}

/** Whether this request is admitted at the socket: the page's Origin is this
 *  listener's own served origin and it presents the runtime's token. Every
 *  peer is a local client because the listener binds loopback only, so the
 *  check needs no remote address. */
function admits(request: Request, served: string, token: string): boolean {
  return isServedOrigin(request.headers.get("Origin"), served) && authorizeToken(presentedToken(request), token)
}

const forbidden = (): Response => new Response("Forbidden", { status: 403 })
const admitted = (): Response => new Response(null, { status: 204 })

/** The listener on the preferred port when it is free, else on an ephemeral
 *  one. Only the bind is retried: any other failure is the runtime's to see. */
function bindPreferring(port: number, bind: (port: number) => Server<undefined>): Server<undefined> {
  try {
    return bind(port)
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EADDRINUSE")) throw error
    return bind(0)
  }
}

export function webSocketServerLayer(options: WebSocketServerOptions): Layer.Layer<SocketServer.SocketServer> {
  return Layer.effect(SocketServer.SocketServer)(Effect.gen(function*() {
    const connections = new Map<ServerWebSocket<undefined>, LiveWebSocket>()
    // Set by `run`. An authorized request before then is transiently unavailable,
    // not an authorization refusal that would end the browser's recovery.
    let accept: ((socket: ServerWebSocket<undefined>) => void) | undefined
    const publishCount = (): void => { options.onConnectionCountChanged?.(connections.size) }
    /** Releases a connection exactly once. Map membership is the count's
     *  authority, as in the unix serving. */
    const release = (socket: ServerWebSocket<undefined>): void => {
      const connection = connections.get(socket)
      if (!connection) return
      connection.transport.close()
      Effect.runFork(Fiber.interrupt(connection.handler))
      connections.delete(socket)
      publishCount()
    }
    // Bound in the layer's own acquisition rather than inside `run`: the RPC
    // protocol forks `run` and never joins it, so a bind failure there would
    // leave startup waiting for a listener that never comes.
    const server: Server<undefined> = yield* Effect.acquireRelease(
      Effect.sync(() => bindPreferring(options.port, (port) => Bun.serve<undefined>({
        hostname: HOSTNAME,
        port,
        fetch(request, activeServer) {
          if (new URL(request.url).pathname !== SOCKET_PATH) return options.staticResponse(request)
          const served = `http://${HOSTNAME}:${activeServer.port}`
          if (!admits(request, served, options.token)) return forbidden()
          if (!accept) return new Response("Service Unavailable", { status: 503 })
          if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return admitted()
          const upgraded = activeServer.upgrade(request, { headers: { [TOKEN_PROTOCOL_HEADER]: options.token } })
          return upgraded ? undefined : forbidden()
        },
        websocket: {
          open(socket) { accept?.(socket) },
          message(socket, message) { connections.get(socket)?.transport.receive(message) },
          drain(socket) { connections.get(socket)?.transport.drain() },
          close(socket) { release(socket) },
        },
      }))),
      (bound) => Effect.sync(() => bound.stop(true)),
    )
    // Bun types the port as optional because a unix listener has none; this
    // listener is TCP and always has one.
    const port = server.port
    if (port === undefined) throw new Error("the loopback web listener bound without a port")
    options.onListening?.({ origin: `http://${HOSTNAME}:${port}`, port })

    return SocketServer.SocketServer.of({
      address: { _tag: "TcpAddress", hostname: HOSTNAME, port },
      run: <R, E, _>(handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>) =>
        Effect.scopedWith((scope) => Effect.gen(function*() {
          const fibers = yield* FiberSet.make<unknown, unknown>().pipe(Scope.provide(scope))
          const runFork = yield* FiberSet.runtime(fibers)<R>()
          accept = (socket) => {
            const transport = websocketStreams(socket)
            const handlerFiber = runFork(Effect.flatMap(
              Socket.fromTransformStream(Effect.succeed(transport.streams)),
              (accepted) => handler(accepted),
            ))
            connections.set(socket, { transport, handler: handlerFiber })
            publishCount()
          }
          yield* Scope.addFinalizer(scope, Effect.sync(() => { accept = undefined }))
          // The server runs until its scope closes; the RPC protocol forks
          // this and owns that scope.
          return yield* Effect.never
        })),
    })
  }))
}
