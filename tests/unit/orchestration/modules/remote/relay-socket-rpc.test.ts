import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, ManagedRuntime, Schema, type Scope, Stream } from "effect"
import { Rpc, RpcClient, type RpcClientError, RpcGroup, RpcServer } from "effect/rpc"
import { layerMsgPack } from "../../../../../src/protocol/rpc-msgpack.js"
import { Socket } from "effect/socket"

import { relaySocketServerLayer } from "../../../../../src/orchestration/modules/remote/relay-socket-server.js"
import { runtimeProtocolSocketServer } from "../../../../../src/orchestration/app-service/runtime-protocol-socket-server.js"
import { socketProtocolLayer } from "../../../../../src/protocol/client/socket-protocol.js"
import { sealedSocket, type SealedIdentity } from "../../../../../src/protocol/modules/remote/sealed-socket.js"
import { asKeyPair, ownedBytes } from "../../../../../src/protocol/modules/remote/relay-protocol.js"
import type { RemoteAccess, RemoteChannelAccept } from "../../../../../src/orchestration/modules/remote/remote-access.js"
import type { RuntimeRemoteView } from "../../../../../src/protocol/modules/remote.js"
import { stringRequestId } from "../../../../../src/protocol/rpc-request-id.js"

/** The relay placement of the protocol server is a `SocketServer` whose
 *  accepts come from the remote-access service. These tests hand it in-memory
 *  sockets in place of sealed relay channels and check the three shapes the
 *  protocol is made of, plus the count the idle reaper reads. */

class ProbeError extends Schema.TaggedError<ProbeError>()("ProbeError", { message: Schema.String }) {}

const ProbeRpc = RpcGroup.make(
  Rpc.make("Echo", { payload: Schema.Struct({ text: Schema.String }), success: Schema.String, error: ProbeError }),
  Rpc.make("Boom", { success: Schema.Void, error: ProbeError }),
  Rpc.make("Ticks", { payload: Schema.Struct({ count: Schema.Number }), success: Schema.Number, error: ProbeError, stream: true }),
  Rpc.make("Pages", { payload: Schema.Struct({ count: Schema.Number }), success: Schema.String, error: ProbeError, stream: true }),
)

const probeHandlers = ProbeRpc.toLayer(Effect.succeed(ProbeRpc.of({
  Echo: ({ text }) => Effect.succeed(`echo:${text}`),
  Boom: () => Effect.fail(new ProbeError({ message: "boom" })),
  Ticks: ({ count }) => Stream.range(1, count),
  // One 16 KiB page per chunk, so a few pages fill the runtime's stream window.
  Pages: ({ count }) => Stream.range(1, count).pipe(Stream.rechunk(1), Stream.map((page) => `${page}:`.padEnd(16 * 1024, "x"))),
})))

const VIEW: RuntimeRemoteView = { relayUrl: "wss://relay.example.test", connection: "connected", devices: [], attachedClients: 0, pairing: null, lastError: null, pushPublicKey: null, projects: [], processInitiation: "unavailable" }

/** The service the layer registers with, reduced to the accept seam. */
function fakeRemote() {
  let accept: RemoteChannelAccept | undefined
  const remote: Pick<RemoteAccess, "acceptChannels" | "view"> = {
    view: () => VIEW,
    acceptChannels(handler) {
      accept = handler
      return () => { accept = undefined }
    },
  }
  return { remote, accept: () => accept }
}

/** One direction of an in-memory pipe. Not a `TransformStream`: closing a
 *  transform's writer waits for a reader that a disposed peer no longer runs,
 *  which hangs disposal. These streams settle their close at once, as a real
 *  socket does. */
function pipe() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false
  const settle = (action: () => void) => {
    if (closed) return
    closed = true
    try {
      action()
    } catch {
      // The reader already went away.
    }
  }
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      closed = true
    },
  })
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (!closed) controller?.enqueue(chunk)
    },
    close() {
      settle(() => controller?.close())
    },
    abort(reason) {
      settle(() => controller?.error(reason))
    },
  })
  return { readable, writable }
}

/** Two sockets over crossed in-memory pipes: the one the server accepts and
 *  the one the client dials. */
async function socketPair(): Promise<{ server: Socket.Socket; client: Layer.Layer<Socket.Socket> }> {
  const toServer = pipe()
  const toClient = pipe()
  const server = await Effect.runPromise(Socket.fromTransformStream(Effect.succeed({ readable: toServer.readable, writable: toClient.writable })))
  const client = Layer.effect(Socket.Socket)(Socket.fromTransformStream(Effect.succeed({ readable: toClient.readable, writable: toServer.writable })))
  return { server, client }
}

async function registered(accept: () => RemoteChannelAccept | undefined): Promise<RemoteChannelAccept> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const handler = accept()
    if (handler) return handler
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("the layer did not register an accept handler")
}

async function withRelayServer<A>(run: (client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof ProbeRpc>, RpcClientError.RpcClientError>, counts: number[]) => Effect.Effect<A, unknown>): Promise<A> {
  const { remote, accept } = fakeRemote()
  const counts: number[] = []
  const server = ManagedRuntime.make(RpcServer.layer(ProbeRpc).pipe(
    Layer.provide(probeHandlers),
    Layer.provide(runtimeProtocolSocketServer),
    Layer.provide(layerMsgPack),
    Layer.provide(relaySocketServerLayer({ remote, onConnectionCountChanged: (open) => { counts.push(open) } })),
  ))
  try {
    await server.runPromise(Effect.void)
    // `run` is forked by the RPC protocol; registration lands once it starts.
    const handler = await registered(accept)
    const pair = await socketPair()
    void handler(pair.server, { id: "dev", label: "phone", publicKey: "k", pairedAt: 0 })
    const client = ManagedRuntime.make(socketProtocolLayer().pipe(Layer.provide(pair.client), Layer.provide(layerMsgPack)))
    try {
      return await client.runPromise(Effect.scoped(Effect.flatMap(RpcClient.make(ProbeRpc, { generateRequestId: stringRequestId }), (rpc) => run(rpc, counts))))
    } finally {
      await client.dispose()
    }
  } finally {
    await server.dispose()
  }
}

async function sealedIdentity(role: "runtime" | "device"): Promise<SealedIdentity> {
  const pair = asKeyPair(await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]))
  return { role, publicKey: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)), sign: async (bytes) => new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, ownedBytes(bytes))) }
}

/** Serves the probe over a sealed relay channel and runs one client program
 *  through the device's end of it. */
async function withSealedServer<A>(run: (client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof ProbeRpc>, RpcClientError.RpcClientError>) => Effect.Effect<A, unknown, Scope.Scope>): Promise<A> {
  const runtime = await sealedIdentity("runtime")
  const device = await sealedIdentity("device")
  const { remote, accept } = fakeRemote()
  const server = ManagedRuntime.make(RpcServer.layer(ProbeRpc).pipe(
    Layer.provide(probeHandlers),
    Layer.provide(runtimeProtocolSocketServer),
    Layer.provide(layerMsgPack),
    Layer.provide(relaySocketServerLayer({ remote })),
  ))
  try {
    await server.runPromise(Effect.void)
    const handler = await registered(accept)
    const pair = await socketPair()
    void handler(sealedSocket(pair.server, runtime, { kind: "paired", publicKey: device.publicKey }).socket, { id: "dev", label: "phone", publicKey: "k", pairedAt: 0 })
    const sealedClient = Layer.effect(Socket.Socket)(Effect.map(Layer.build(pair.client).pipe(Effect.map((context) => Context.get(context, Socket.Socket))), (inner) => sealedSocket(inner, device, { kind: "paired", publicKey: runtime.publicKey }).socket))
    const client = ManagedRuntime.make(socketProtocolLayer().pipe(Layer.provide(sealedClient), Layer.provide(layerMsgPack)))
    try {
      return await client.runPromise(Effect.scoped(Effect.flatMap(RpcClient.make(ProbeRpc, { generateRequestId: stringRequestId }), run)))
    } finally {
      await client.dispose()
    }
  } finally {
    await server.dispose()
  }
}

describe("runtime protocol over a relay channel", () => {
  test("carries a unary call, a typed failure, and a stream", async () => {
    const outcome = await withRelayServer((rpc) => Effect.gen(function*() {
      const echo = yield* rpc.Echo({ text: "hello" })
      const boom = yield* Effect.exit(rpc.Boom())
      const ticks = yield* Stream.runCollect(rpc.Ticks({ count: 5 }))
      return { echo, boom: JSON.stringify(boom), ticks: [...ticks] }
    }))
    expect(outcome.echo).toBe("echo:hello")
    expect(outcome.boom).toContain("ProbeError")
    expect(outcome.ticks).toEqual([1, 2, 3, 4, 5])
  })

  test("counts each accepted channel while its handler runs and releases it when the channel ends", async () => {
    const counts = await withRelayServer((rpc, observed) => Effect.as(rpc.Echo({ text: "x" }), observed))
    expect(counts[0]).toBe(1)
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(counts.at(-1)).toBe(0)
  })

  test("unregisters its accept handler when the server scope closes", async () => {
    const { remote, accept } = fakeRemote()
    const server = ManagedRuntime.make(RpcServer.layer(ProbeRpc).pipe(
      Layer.provide(probeHandlers),
      Layer.provide(runtimeProtocolSocketServer),
      Layer.provide(layerMsgPack),
      Layer.provide(relaySocketServerLayer({ remote })),
    ))
    await server.runPromise(Effect.void)
    expect(await registered(accept)).toBeDefined()
    await server.dispose()
    expect(accept()).toBeUndefined()
  })

  test("carries the protocol through a sealed channel, as a relay channel does", async () => {
    // The RPC client acquires its writer and pings before it starts reading,
    // so a sealed writer that could not wait for the run deadlocked the
    // handshake. This is the shape every phone attach takes.
    const echo = await withSealedServer((rpc) => rpc.Echo({ text: "sealed" }))
    expect(echo).toBe("echo:sealed")
  })

  test("answers a query through a sealed channel while a stream holds at the window", async () => {
    // A consumer that takes nothing leaves a full window of pages
    // unacknowledged, so the stream holds. The hold must not keep the sealed
    // writer's lock, or the reply waits behind the held stream.
    const outcome = await withSealedServer((rpc) => Effect.gen(function*() {
      const pages = yield* rpc.Pages({ count: 40 }, { asQueue: true, streamBufferSize: 1 })
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)))
      const echo = yield* rpc.Echo({ text: "during a hold" })
      // Draining releases the held stream, so every page still arrives.
      const received = yield* Stream.runCount(Stream.fromQueue(pages))
      return { echo, received }
    }))
    expect(outcome).toEqual({ echo: "echo:during a hold", received: 40 })
  })

  test("serves beside a local transport of the same protocol", async () => {
    // The socket-server protocol layer is one memoized object. Merged as is, a
    // second serving reuses the first build and its transport never runs; this
    // is how the ide server and the worker server compose the relay beside
    // their local transport, so the composition is held here.
    const { remote, accept } = fakeRemote()
    const local = RpcServer.layer(ProbeRpc).pipe(
      Layer.provide(probeHandlers),
      Layer.provide(runtimeProtocolSocketServer),
      Layer.provide(layerMsgPack),
      Layer.provide(relaySocketServerLayer({ remote: fakeRemote().remote })),
    )
    const relay = RpcServer.layer(ProbeRpc).pipe(
      Layer.provide(probeHandlers),
      Layer.provide(Layer.fresh(runtimeProtocolSocketServer)),
      Layer.provide(layerMsgPack),
      Layer.provide(relaySocketServerLayer({ remote })),
    )
    const server = ManagedRuntime.make(Layer.merge(local, relay))
    try {
      await server.runPromise(Effect.void)
      expect(await registered(accept)).toBeDefined()
    } finally {
      await server.dispose()
    }
  })
})
