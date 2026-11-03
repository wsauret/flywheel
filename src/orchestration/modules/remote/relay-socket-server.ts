import { Effect, Fiber, FiberSet, Layer, Scope } from "effect"
import { NetAddress } from "effect/net"
import { SocketServer, type Socket } from "effect/socket"

import type { RemoteAccess } from "./remote-access.js"

/** The relay placement of the runtime protocol server: a `SocketServer`
 *  whose accepted connections are reverse connections.
 *
 *  `bun-socket-rpc.ts` accepts from a bound unix socket. This accepts from
 *  the remote-access service, which dials one outbound WebSocket per device
 *  channel the relay names and hands over the sealed `Socket`. From the RPC
 *  protocol's side the two are the same thing: one accepted socket is one
 *  client with one handler fiber for its lifetime, and every fiber belongs to
 *  this server's scope. That is what lets the ide server and the worker server
 *  serve a phone by merging one more layer, with no second runtime, no second
 *  handler set, and no new listener on the host. */

export interface RelaySocketServerOptions {
  readonly remote: Pick<RemoteAccess, "acceptChannels">
  /** Called as each device channel opens and closes. The idle reaper counts
   *  these beside local connections: a phone reading a transcript holds the
   *  runtime up the way an editor window does. */
  readonly onConnectionCountChanged?: (open: number) => void
}

export function relaySocketServerLayer(options: RelaySocketServerOptions): Layer.Layer<SocketServer.SocketServer> {
  return Layer.effect(SocketServer.SocketServer)(Effect.sync(() =>
    SocketServer.SocketServer.of({
      // No listener on this host accepts these channels, so the address is
      // the unspecified one.
      address: NetAddress.inetAddressFromIpStringUnsafe("0.0.0.0", 0),
      run: <R, E, _>(handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>) =>
        Effect.scopedWith((scope) =>
          Effect.gen(function*() {
            const fiberSet = yield* FiberSet.make<unknown, unknown>().pipe(Scope.provide(scope))
            const runFork = yield* FiberSet.runtime(fiberSet)<R>()
            let open = 0
            const unregister = options.remote.acceptChannels(async (socket) => {
              open += 1
              options.onConnectionCountChanged?.(open)
              try {
                // The handler's own end is the channel's end, whether the phone
                // left, the sealed channel refused a frame, or the runtime is
                // stopping. Its exit is the protocol's business; this only waits.
                // `Fiber.await`, not `join`: joining from a root fiber left the
                // server's scope unable to close after a channel had ended.
                await Effect.runPromise(Fiber.await(runFork(handler(socket))))
              } finally {
                open -= 1
                options.onConnectionCountChanged?.(open)
              }
            })
            yield* Scope.addFinalizer(scope, Effect.sync(unregister))
            // The server runs until its scope closes; the RPC protocol forks
            // this and owns that scope.
            return yield* Effect.never
          })
        ),
    })
  ))
}
