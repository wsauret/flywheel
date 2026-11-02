import { test, expect } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { Duplex } from "node:stream"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { FrontendEvent } from "../../../src/protocol/app-service-types.js"
import { RUNTIME_EVENT_HEARTBEAT_INTERVAL_MS } from "../../../src/protocol/runtime-liveness.js"
import { RuntimeProtocolRpc } from "../../../src/protocol/runtime-protocol-schemas.js"
import { bunSocketServerLayer } from "../../../src/orchestration/app-service/bun-socket-rpc.js"
import { runtimeHandlers } from "../../../src/orchestration/app-service/runtime-protocol-handlers.js"
import { createOutputWatches } from "../../../src/orchestration/app-service/output-watches.js"
import { runtimeProtocolSocketServer } from "../../../src/orchestration/app-service/runtime-protocol-socket-server.js"
import { createRuntimeConnection } from "../../../src/protocol/client/connection.js"

/** The event lane's liveness is the runtime heartbeat and the client's silence
 *  deadline, and nothing else. A phone on a relay answers a request-level ping
 *  late whenever it is busy painting a turn, so a second clock inside the RPC
 *  layer that fails the socket on a late pong reconnects a healthy lane every
 *  minute. This test starves that clock: the client's pings never reach the
 *  server, so no pong ever comes back, while heartbeats keep flowing. The lane
 *  must stay attached for longer than any request-level ping deadline. */

/** Longer than the 5 second pong deadline Effect's own socket protocol
 *  carried, with a whole tick of slack, so a reconnect driven by it lands
 *  inside the window. */
const STARVED_WINDOW_MS = 12_500

function idleService(): Parameters<typeof runtimeHandlers>[0]["client"] {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const unused = () => Promise.reject(new Error("not under test"))
  return {
    dispatch: unused,
    disconnect: () => {},
    query: unused,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function isPingOnly(chunk: Uint8Array): boolean {
  const parser = RpcSerialization.msgPack.makeUnsafe()
  const messages = parser.decode(chunk)
  return messages.length > 0 && messages.every((message) => typeof message === "object" && message !== null && "_tag" in message && message._tag === "Ping")
}

/** A unix socket as an Effect `Socket`, with every outbound chunk that holds
 *  only RPC pings dropped on the floor. Everything else crosses untouched. */
function pingStarvedSocketLayer(socketPath: string): Layer.Layer<Socket.Socket> {
  const connect = Effect.acquireRelease(
    Effect.tryPromise({
      try: () => new Promise<net.Socket>((resolve, reject) => {
        const pending = net.connect(socketPath)
        pending.once("connect", () => { pending.removeListener("error", reject); resolve(pending) })
        pending.once("error", reject)
      }),
      catch: (cause) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) }),
    }),
    (connection) => Effect.sync(() => connection.destroy()),
  ).pipe(Effect.map((connection) => {
    const { readable } = Duplex.toWeb(connection)
    // Bun's node:stream/web stream is the global class, which the declarations of node:stream/web do not state.
    if (!(readable instanceof ReadableStream)) throw new Error("node:stream/web returned a foreign ReadableStream")
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        if (isPingOnly(chunk)) return
        return new Promise<void>((resolve, reject) => {
          connection.write(chunk, (error) => {
            if (error) {
              reject(error)
              return
            }
            resolve()
          })
        })
      },
      close() {
        connection.end()
      },
    })
    return { readable, writable }
  }))
  return Layer.effect(Socket.Socket)(Socket.fromTransformStream(connect))
}

test("the event lane stays attached when request-level pings are never answered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-pong-tolerance-"))
  const socketPath = join(dir, "ide.sock")
  const listening = Promise.withResolvers<void>()
  const log = { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} }
  const server = ManagedRuntime.make(
    RpcServer.layer(RuntimeProtocolRpc).pipe(
      Layer.provide(runtimeHandlers({ client: idleService(), outputWatches: createOutputWatches({ onUnionChange: () => {} }) }, log, { version: "0.1.0" })),
      Layer.provide(runtimeProtocolSocketServer),
      Layer.provide(RpcSerialization.layerMsgPack),
      Layer.provide(bunSocketServerLayer({ path: socketPath, onListening: () => listening.resolve() })),
    ),
  )

  await server.runPromise(Effect.void)
  await listening.promise
  const diagnostics: string[] = []
  const connection = createRuntimeConnection({
    socket: pingStarvedSocketLayer(socketPath),
    onDiagnostic: (message, detail) => diagnostics.push(`${message}: ${String(detail)}`),
  })
  const connected = Promise.withResolvers<void>()
  const states: string[] = []
  const unsubscribeState = connection.onStateChange((state) => {
    states.push(state)
    if (state === "connected") connected.resolve()
  })
  const unsubscribe = connection.subscribe(() => {})

  try {
    const outcome = await Promise.race([
      connected.promise.then(() => "connected" as const),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), RUNTIME_EVENT_HEARTBEAT_INTERVAL_MS + 2_000)),
    ])
    expect(outcome).toBe("connected")
    await new Promise<void>((resolve) => { setTimeout(resolve, STARVED_WINDOW_MS) })
    // A reconnect passes through `reconnecting` and reports the lane ending;
    // one attach leaves one state and no diagnostic.
    expect(diagnostics).toEqual([])
    expect(states).toEqual(["connected"])
    expect(connection.state).toBe("connected")
  } finally {
    unsubscribe()
    unsubscribeState()
    await connection.close()
    await server.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}, STARVED_WINDOW_MS + 15_000)
