import { Cause, Effect, Layer, Result } from "effect"
import { RpcClient, RpcClientError, type RpcMessage, RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { RuntimeLaneLost } from "./connection-failures.js"

/** The RPC client's transport over the current `Socket`, with no liveness
 *  clock of its own.
 *
 *  Effect's `RpcClient.layerProtocolSocket` is this same pump plus a pinger:
 *  it writes a request-level ping every five seconds and fails the whole
 *  socket when the pong has not arrived by the next tick. That clock is not
 *  configurable, and five seconds is less than a phone on a relay takes to
 *  answer while it is painting a turn: the pong sits behind the frames it is
 *  decrypting and rendering, the socket is declared dead, and a healthy lane
 *  reconnects from scratch about once a minute. The lane already has one
 *  liveness authority, the runtime heartbeat and the client's silence deadline
 *  (ARCH-PROTOCOL-021), and a second, stricter one only manufactures failures.
 *
 *  This layer is that protocol with the pinger removed and nothing else
 *  changed: the same serialization, the same request-to-client routing, the
 *  same broadcast of a socket failure to every client so an in-flight request
 *  and the event subscription fail together. Recovery belongs to the
 *  reconnecting connection above, which disposes this whole runtime and builds
 *  a new one, so the protocol makes no attempt to redial on its own either. A
 *  pong that a server still sends is ignored.
 *
 *  `supportsAck` stays true. `RpcClient` then sends one `Ack` for each stream
 *  chunk, in chunk order, after the chunk enters its bounded stream buffer.
 *  The runtime's server protocol counts each `Ack` as credit for its stream
 *  byte window, so a client without them stalls its lane at the window. The
 *  counterpart that keeps this contract on the runtime side is
 *  `src/orchestration/app-service/runtime-protocol-socket-server.ts`
 *  (ARCH-PROTOCOL-022). */

type FromServer = RpcMessage.FromServerEncoded
type FromClient = RpcMessage.FromClientEncoded

export interface SocketProtocolOptions {
  /** Called once a request's frame is written to an open socket: the
   *  socket's writer waits for the socket to open (and, over the relay, for
   *  the sealed channel to establish) before it writes. The connection
   *  opens a lane when its event subscription is written. */
  readonly onRequestWritten?: (request: Extract<FromClient, { readonly _tag: "Request" }>) => void
}

/** The RPC client's `Protocol` service over the current `Socket` and
 *  `RpcSerialization`. Build it afresh for every attach: a socket is acquired
 *  when its layer is built, and a dead one is never retried. */
export function socketProtocolLayer(options: SocketProtocolOptions = {}): Layer.Layer<RpcClient.Protocol, never, Socket.Socket | RpcSerialization.RpcSerialization> {
  return Layer.effect(RpcClient.Protocol)(RpcClient.Protocol.make(Effect.fnUntraced(function*(writeResponse, clientIds) {
    const socket = yield* Socket.Socket
    const serialization = yield* RpcSerialization.RpcSerialization
    const requestClientMap = new Map<string, number>()
    const write = yield* socket.writer
    let parser = serialization.makeUnsafe()
    let currentError: RpcClientError.RpcClientError | undefined

    const broadcast = (response: FromServer) => Effect.forEach(clientIds, (clientId) => writeResponse(clientId, response), { discard: true })

    const deliver = (response: unknown): Effect.Effect<void> => {
      // SAFETY: The RPC serialization parser validates the server frame before
      // it returns the decoded protocol message.
      const message = response as FromServer // oxlint-disable-line typescript/consistent-type-assertions -- boundary: decoded wire frame from the runtime's RPC server
      if (message._tag === "Pong") return Effect.void
      if ("requestId" in message) {
        const clientId = requestClientMap.get(message.requestId)
        if (clientId !== undefined) {
          if (message._tag === "Exit") requestClientMap.delete(message.requestId)
          return writeResponse(clientId, message)
        }
      }
      return broadcast(message)
    }

    const onMessage = (data: string | Uint8Array): Effect.Effect<void> => {
      let responses: ReadonlyArray<unknown>
      try {
        responses = parser.decode(data)
      } catch (defect) {
        return broadcast({ _tag: "ClientProtocolError", error: new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message: "Error decoding message", cause: defect }) }) })
      }
      return Effect.forEach(responses, deliver, { discard: true })
    }

    yield* Effect.suspend(() => {
      parser = serialization.makeUnsafe()
      currentError = undefined
      return socket.runRaw(onMessage)
    }).pipe(
      // A run that returns is a socket that closed cleanly; to the requests
      // still waiting on it that is a failure like any other.
      Effect.flatMap(() => Effect.fail(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) }))),
      // A run that ends with no typed error, by a defect such as a relay
      // channel that breaks under a dropped connection, or by interruption,
      // stopped reading the socket all the same: the lane is gone, and each
      // request on it was lost with the lane. The cause stays inside, so a
      // lane-end record still names what ended the lane.
      Effect.tapCause((cause) => {
        const error = Cause.findError(cause)
        currentError = new RpcClientError.RpcClientError({
          reason: Result.isSuccess(error) ? error.success.reason : new RpcClientError.RpcClientDefect({ message: "the socket stopped", cause: new RuntimeLaneLost(Cause.squash(cause)) }),
        })
        return broadcast({ _tag: "ClientProtocolError", error: currentError })
      }),
      Effect.ignore,
      Effect.forkScoped,
    )

    return {
      send(clientId: number, request: FromClient) {
        if (currentError) return Effect.fail(currentError)
        if (request._tag === "Request") requestClientMap.set(request.id, clientId)
        const encoded = parser.encode(request)
        if (encoded === undefined) return Effect.void
        const written = Effect.orDie(write(encoded))
        const onRequestWritten = options.onRequestWritten
        if (request._tag !== "Request" || onRequestWritten === undefined) return written
        return Effect.tap(written, () => Effect.sync(() => onRequestWritten(request)))
      },
      supportsAck: true,
      supportsTransferables: false,
    }
  })))
}
