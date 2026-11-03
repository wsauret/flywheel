import { describe, expect, test } from "bun:test"
import { Effect, ManagedRuntime, Stream } from "effect"
import { NetAddress } from "effect/net"
import { Socket, SocketServer } from "effect/socket"

import { webSocketServerLayer } from "../../../../src/orchestration/app-service/web-socket-server"

/** A port nothing else on this machine is listening on, found by letting the
 *  OS hand one out and releasing it. */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = probe.port
  probe.stop(true)
  if (port === undefined) throw new Error("probe bound without a port")
  return port
}

describe("authenticated loopback web socket server", () => {
  test("binds loopback only and separates exact-origin token admission from socket readiness", async () => {
    const listening = Promise.withResolvers<{ origin: string; port: number }>()
    const preferred = freePort()
    const runtime = ManagedRuntime.make(webSocketServerLayer({
      token: "secret",
      port: preferred,
      staticResponse: async () => new Response("static"),
      onListening: listening.resolve,
    }))

    try {
      await runtime.runPromise(Effect.scoped(Effect.gen(function*() {
        const server = yield* SocketServer.SocketServer
        const endpoint = yield* Effect.promise(() => listening.promise)
        expect(endpoint.port).toBe(preferred)
        expect(server.address).toEqual(NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", endpoint.port))
        // The IPv6 loopback is another address; nothing answers there.
        const ipv6 = yield* Effect.promise(() => fetch(`http://[::1]:${endpoint.port}/`).then(() => "answered", () => "refused"))
        expect(ipv6).toBe("refused")

        const status = (headers: HeadersInit, path = "/socket") =>
          Effect.promise(async () => (await fetch(`${endpoint.origin}${path}`, { method: "POST", headers })).status)
        const token = { "Sec-WebSocket-Protocol": "secret" }
        for (const ready of [false, true]) {
          if (ready) yield* Effect.forkScoped(server.run(() => Effect.never))
          // No Origin at all: not a browser page.
          expect(yield* status(token)).toBe(403)
          // A page on another site holds the token only if it was leaked; the
          // Origin rule refuses it regardless.
          expect(yield* status({ Origin: "https://example.com", ...token })).toBe(403)
          // Another program on this machine, even with the token.
          expect(yield* status({ Origin: "http://127.0.0.1:1", ...token })).toBe(403)
          expect(yield* status({ Origin: `http://localhost:${endpoint.port}`, ...token })).toBe(403)
          // The served page with the wrong token, no token, or the token where
          // the runtime does not read it.
          expect(yield* status({ Origin: endpoint.origin, "Sec-WebSocket-Protocol": "wrong" })).toBe(403)
          expect(yield* status({ Origin: endpoint.origin })).toBe(403)
          expect(yield* status({ Origin: endpoint.origin }, "/socket?token=secret")).toBe(403)
          // Authorization does not depend on readiness. Only an authorized
          // page can receive the transient response before sockets are accepted.
          expect(yield* status({ Origin: endpoint.origin, Authorization: "Bearer secret" })).toBe(ready ? 204 : 503)
          expect(yield* status({ Origin: endpoint.origin, Authorization: "Bearer wrong" })).toBe(403)
          expect(yield* status({ Origin: "http://127.0.0.1:1", Authorization: "Bearer secret" })).toBe(403)
        }
        // Everything else is the static page.
        expect(yield* Effect.promise(async () => (await fetch(`${endpoint.origin}/anything`)).text())).toBe("static")
      })))
    } finally {
      await runtime.dispose()
    }
  })

  test("delivers every large frame in order to a slow reader on an open connection", async () => {
    // Bun drops a send whose socket already buffers more than its
    // backpressure limit (16 MiB) and reports it only as a 0 return. Frames
    // this large to a page that reads slowly cross that limit unless the
    // writer parks well below it.
    const frameBytes = 6 * 2 ** 20
    const frames = 10
    const listening = Promise.withResolvers<{ origin: string; port: number }>()
    const runtime = ManagedRuntime.make(webSocketServerLayer({
      token: "secret",
      port: 0,
      staticResponse: async () => new Response("static"),
      onListening: listening.resolve,
    }))
    const received: number[] = []
    const done = Promise.withResolvers<void>()
    let closeCode: number | undefined
    let client: WebSocket | undefined
    try {
      await runtime.runPromise(Effect.scoped(Effect.gen(function*() {
        const server = yield* SocketServer.SocketServer
        const endpoint = yield* Effect.promise(() => listening.promise)
        yield* Effect.forkScoped(server.run((socket) => Effect.gen(function*() {
          const { write } = yield* socket.writer
          yield* Effect.forkScoped(Stream.runDrain(Socket.toStream(socket)))
          for (let index = 0; index < frames; index += 1) yield* write(new Uint8Array(frameBytes).fill(index + 1))
          yield* Effect.never
        }).pipe(Effect.scoped)))
        // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the DOM WebSocket type hides Bun's options overload, which sets the Origin header that a page sends and this server checks
        client = new WebSocket(`${endpoint.origin.replace("http", "ws")}/socket`, ({ headers: { Origin: endpoint.origin }, protocols: ["secret"] } satisfies Bun.WebSocketOptions) as never)
        client.binaryType = "arraybuffer"
        client.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
          const bytes = new Uint8Array(event.data)
          expect(bytes.byteLength).toBe(frameBytes)
          received.push(bytes[0] ?? 0)
          // A busy page: the reader holds the event loop for each frame.
          const until = performance.now() + 20
          while (performance.now() < until) { /* busy */ }
          if (received.length === frames) done.resolve()
        })
        client.addEventListener("close", (event) => { closeCode = event.code; done.resolve() })
        yield* Effect.promise(() => done.promise)
        expect(received).toEqual(Array.from({ length: frames }, (_, index) => index + 1))
        expect(closeCode).toBeUndefined()
        expect(client.readyState).toBe(WebSocket.OPEN)
      })))
    } finally {
      client?.close()
      await runtime.dispose()
    }
  })

  test("binds an ephemeral port when the project's own port is taken", async () => {
    const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("other program") })
    const taken = holder.port
    if (taken === undefined) throw new Error("holder bound without a port")
    const listening = Promise.withResolvers<{ origin: string; port: number }>()
    const runtime = ManagedRuntime.make(webSocketServerLayer({
      token: "secret",
      port: taken,
      staticResponse: async () => new Response("static"),
      onListening: listening.resolve,
    }))
    try {
      await runtime.runPromise(Effect.gen(function*() {
        const server = yield* SocketServer.SocketServer
        const endpoint = yield* Effect.promise(() => listening.promise)
        expect(endpoint.port).not.toBe(taken)
        expect(server.address).toEqual(NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", endpoint.port))
        // The other program keeps its port; nothing was displaced.
        expect(yield* Effect.promise(async () => (await fetch(`http://127.0.0.1:${taken}/`)).text())).toBe("other program")
      }))
    } finally {
      await runtime.dispose()
      holder.stop(true)
    }
  })
})
