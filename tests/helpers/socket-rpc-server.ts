import { Effect, FiberSet, Layer, Scope } from "effect"
import { NetAddress } from "effect/net"
import { Socket, SocketServer } from "effect/socket"

import { createBunRawSocketServer } from "../../src/orchestration/app-service/account/connections/bun-socket-rpc.js"

/** A `SocketServer` over the production listener `createBunRawSocketServer`,
 *  for a test that serves one RPC protocol to every client of `path`. Each
 *  accepted connection runs the protocol's handler on its own socket layer,
 *  as the account service runs a project's protocol on an attached
 *  connection, and every handler fiber belongs to the server's scope. */
export function socketRpcServerLayer(options: { readonly path: string; readonly onListening?: () => void }): Layer.Layer<SocketServer.SocketServer> {
  return Layer.succeed(SocketServer.SocketServer, SocketServer.SocketServer.of({
    address: NetAddress.unixPathAddress(options.path),
    run: <R, E, A>(handler: (socket: Socket.Socket) => Effect.Effect<A, E, R>) =>
      Effect.scopedWith((scope) =>
        Effect.gen(function*() {
          const fibers = yield* FiberSet.make<unknown, unknown>().pipe(Scope.provide(scope))
          const runFork = yield* FiberSet.runtime(fibers)<R>()
          const server = createBunRawSocketServer({
            path: options.path,
            onOpen: (connection) => { runFork(Effect.flatMap(Socket.Socket, handler).pipe(Effect.provide(connection.socketLayer))) },
            onData: (connection, bytes) => { connection.receive(bytes) },
            onClose: () => {},
          })
          yield* Scope.addFinalizer(scope, Effect.promise(() => server.dispose()))
          options.onListening?.()
          return yield* Effect.never
        }),
      ),
  }))
}
