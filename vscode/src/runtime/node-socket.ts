import net from "node:net"
import { Duplex } from "node:stream"
import { Effect, Layer, Scope } from "effect"
import { Socket } from "effect/socket"
import {
  createAccountAttachResponseReader,
  encodeAccountAttach,
} from "../../../src/protocol/account-attach.js"

export interface RuntimeSocketTarget {
  readonly socketPath: string
  readonly projectRoot: string
  readonly credential: string
}

/** Client side of the Flywheel runtime transport, for a host that is Node
 *  rather than Bun. Effect ships the platform-neutral `Socket` contract and the
 *  RPC protocol over it, but no Node implementation, so this is that
 *  implementation over `node:net`.
 *
 *  The runtime binds a unix socket (a named pipe on Windows) at an address both
 *  sides derive from the project root, so connecting takes no discovery step
 *  and no port. */

/** Node's own duplex-to-web-stream bridge already carries backpressure in both
 *  directions, which is the only property this boundary needs: the runtime
 *  publishes transcript deltas onto this connection, and a client that stops
 *  reading has to slow the runtime rather than let it queue without bound. */
/** Opens one project target after account admission and returns every protocol
 * byte, including bytes coalesced with the server's readiness write. */
export function openNodeSocket(target: RuntimeSocketTarget): Effect.Effect<Socket.InputTransformStream, Socket.SocketError, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<net.Socket>((resolve, reject) => {
          const pending = net.connect(target.socketPath)
          const readiness = createAccountAttachResponseReader()
          const fail = (cause: Error): void => {
            pending.destroy()
            reject(cause)
          }
          const onData = (chunk: Buffer): void => {
            const result = readiness.push(chunk)
            if (result.kind === "pending" || result.kind === "starting") return
            pending.pause()
            pending.removeListener("data", onData)
            pending.removeListener("error", fail)
            if (result.kind === "failed") {
              fail(new Error(result.error))
              return
            }
            // This connection offers no client identity, so a mismatch is as
            // out of place here as a cutover answer.
            if (result.kind !== "ready") {
              fail(new Error(`account service returned a ${result.kind} response to a project attach`))
              return
            }
            if (result.remainder.length > 0) pending.unshift(Buffer.from(result.remainder))
            resolve(pending)
          }
          pending.on("data", onData)
          pending.once("connect", () => {
            pending.setNoDelay(true)
            pending.write(
              encodeAccountAttach({ intent: "runtime", projectRoot: target.projectRoot, credential: target.credential }),
            )
          })
          pending.once("error", fail)
        }),
      catch: (cause) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) }),
    }),
    (connection) => Effect.sync(() => connection.destroy()),
  ).pipe(
    Effect.map((connection) => {
      const web = Duplex.toWeb(connection)
      // oxlint-disable-next-line typescript/consistent-type-assertions, anti-slop/no-chained-type-assertions -- boundary: node:stream/web declares getReader overloads in an order the lib's ReadableStream rejects (TS2352), though both are the same global class at runtime
      const readable = web.readable as unknown as ReadableStream<Uint8Array>
      return { readable, writable: web.writable }
    }),
  )
}

/** A `Socket` connected to one project through the account service. */
export function nodeSocketLayer(target: RuntimeSocketTarget): Layer.Layer<Socket.Socket> {
  return Layer.effect(Socket.Socket)(Socket.fromTransformStream(openNodeSocket(target)))
}
