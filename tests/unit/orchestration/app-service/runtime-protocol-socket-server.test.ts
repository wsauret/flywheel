import { describe, expect, test } from "bun:test"
import { type Cause, Effect, Layer, ManagedRuntime, Queue, Schema, Stream } from "effect"
import { Rpc, RpcClient, RpcGroup, type RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Socket, SocketServer } from "effect/unstable/socket"

import { runtimeProtocolSocketServer } from "../../../../src/orchestration/app-service/runtime-protocol-socket-server.js"
import { socketProtocolLayer } from "../../../../src/protocol/client/socket-protocol.js"

/** The runtime's server protocol lets a stream's chunks travel ahead of the
 *  client's acknowledgements up to a byte window, and holds the stream only
 *  while a full window is unacknowledged. These tests drive it over in-memory
 *  pipes: a raw client encodes its own frames when the test must decide when
 *  each acknowledgement goes, and the shipped client copy reads the lane when
 *  the test needs a real consumer. */

/** The runtime's stream window: 128 KiB. With 16 KiB frames, eight chunks fill it. */
const FRAME_BYTES = 16 * 1024
const CHUNKS_PER_WINDOW = 8

const Probe = RpcGroup.make(
  Rpc.make("Frames", { payload: Schema.Struct({ count: Schema.Number }), success: Schema.String, stream: true }),
  Rpc.make("Latest", { payload: Schema.Struct({ count: Schema.Number }), success: Schema.String, stream: true }),
  Rpc.make("Echo", { payload: Schema.Struct({ text: Schema.String }), success: Schema.String }),
)

function frame(index: number): string {
  return `${index}:`.padEnd(FRAME_BYTES, "x")
}

function frameIndex(value: unknown): number {
  return Number(String(value).split(":")[0])
}

const SLIDING_CAPACITY = 16

function probeHandlers(finalized: { count: number }) {
  return Probe.toLayer(Effect.succeed(Probe.of({
    Frames: ({ count }) => Stream.range(1, count).pipe(
      Stream.rechunk(1),
      Stream.map(frame),
      Stream.ensuring(Effect.sync(() => { finalized.count += 1 })),
    ),
    // A producer that outruns the lane, as the runtime's event stream does:
    // values enter a sliding queue that keeps only the newest ones.
    Latest: ({ count }) => Stream.unwrap(Effect.gen(function*() {
      const queue = yield* Queue.sliding<number, Cause.Done>(SLIDING_CAPACITY)
      yield* Effect.forkScoped(Effect.gen(function*() {
        for (let value = 1; value <= count; value++) {
          Queue.offerUnsafe(queue, value)
          yield* Effect.yieldNow
        }
        yield* Queue.end(queue)
      }))
      return Stream.fromQueue(queue).pipe(Stream.map(frame))
    })),
    Echo: ({ text }) => Effect.succeed(`echo:${text}`),
  })))
}

/** One direction of an in-memory pipe that reports every frame written to it. */
function pipe(observe?: (bytes: Uint8Array) => void) {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      controller?.close()
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
      observe?.(chunk)
      if (!closed) controller?.enqueue(chunk)
    },
    close,
  })
  return { readable, writable, close }
}

interface ServerMessage {
  readonly _tag: string
  readonly requestId?: string
  readonly values?: ReadonlyArray<unknown>
}

/** The msgpack parser decodes untyped values; every frame the server writes is tagged. */
function isServerMessage(raw: unknown): raw is ServerMessage {
  return typeof raw === "object" && raw !== null && "_tag" in raw && typeof raw._tag === "string"
    && (!("requestId" in raw) || typeof raw.requestId === "string")
    && (!("values" in raw) || Array.isArray(raw.values))
}

async function serve() {
  const finalized = { count: 0 }
  const fromServer: Array<ServerMessage> = []
  const observer = RpcSerialization.msgPack.makeUnsafe()
  const toServer = pipe()
  const toClient = pipe((bytes) => {
    for (const raw of observer.decode(bytes)) {
      if (!isServerMessage(raw)) throw new Error("the server wrote a frame that is not an RPC message")
      fromServer.push(raw)
    }
  })
  const serverSocket = await Effect.runPromise(Socket.fromTransformStream(Effect.succeed({ readable: toServer.readable, writable: toClient.writable })))
  const socketServer = Layer.succeed(SocketServer.SocketServer, SocketServer.SocketServer.of({
    address: { _tag: "UnixAddress", path: "memory" },
    run: (handler) => Effect.flatMap(Effect.orDie(handler(serverSocket)), () => Effect.never),
  }))
  const server = ManagedRuntime.make(RpcServer.layer(Probe).pipe(
    Layer.provide(probeHandlers(finalized)),
    Layer.provide(runtimeProtocolSocketServer),
    Layer.provide(RpcSerialization.layerMsgPack),
    Layer.provide(socketServer),
  ))
  await server.runPromise(Effect.void)
  const encoder = RpcSerialization.msgPack.makeUnsafe()
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined
  return {
    finalized,
    fromServer,
    chunks: (requestId: string) => fromServer.filter((message) => message._tag === "Chunk" && message.requestId === requestId),
    exit: (requestId: string) => fromServer.find((message) => message._tag === "Exit" && message.requestId === requestId),
    /** Writes one client frame as a raw client would. */
    send: (message: RpcMessage.FromClientEncoded) => {
      const bytes = encoder.encode(message)
      if (!(bytes instanceof Uint8Array)) throw new Error("Expected binary RPC codec")
      return (writer ??= toServer.writable.getWriter()).write(bytes)
    },
    /** The client side of the socket, for the shipped client protocol. */
    clientSocket: Layer.effect(Socket.Socket)(Socket.fromTransformStream(Effect.succeed({ readable: toClient.readable, writable: toServer.writable }))),
    /** The client goes away. */
    hangUp: () => { toServer.close(); toClient.close() },
    dispose: () => server.dispose(),
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function framesRequest(id: string, count: number): RpcMessage.FromClientEncoded {
  return { _tag: "Request", id, tag: "Frames", payload: { count }, headers: [] }
}

describe("runtime protocol socket server", () => {
  test("sends further chunks before the first acknowledgement returns", async () => {
    const lane = await serve()
    try {
      await lane.send(framesRequest("1", 20))
      await settle()
      expect(lane.chunks("1").length).toBeGreaterThan(1)
    } finally {
      await lane.dispose()
    }
  })

  test("holds once a window of bytes is unacknowledged and sends one more chunk for each acknowledgement", async () => {
    const lane = await serve()
    try {
      await lane.send(framesRequest("1", 20))
      await settle()
      expect(lane.chunks("1").length).toBe(CHUNKS_PER_WINDOW)
      await lane.send({ _tag: "Ack", requestId: "1" })
      await settle()
      expect(lane.chunks("1").length).toBe(CHUNKS_PER_WINDOW + 1)
    } finally {
      await lane.dispose()
    }
  })

  test("a query reply goes out while a stream holds at the window", async () => {
    const lane = await serve()
    try {
      await lane.send(framesRequest("1", 20))
      await settle()
      expect(lane.chunks("1").length).toBe(CHUNKS_PER_WINDOW)
      await lane.send({ _tag: "Request", id: "2", tag: "Echo", payload: { text: "tap" }, headers: [] })
      await settle()
      expect(lane.exit("2")).toMatchObject({ exit: { _tag: "Success", value: "echo:tap" } })
      expect(lane.chunks("1").length).toBe(CHUNKS_PER_WINDOW)
    } finally {
      await lane.dispose()
    }
  })

  test("a client that goes away while the window is full ends the stream", async () => {
    const lane = await serve()
    try {
      await lane.send(framesRequest("1", 20))
      await settle()
      expect(lane.chunks("1").length).toBe(CHUNKS_PER_WINDOW)
      lane.hangUp()
      await settle()
      expect(lane.finalized.count).toBe(1)
    } finally {
      await lane.dispose()
    }
  })

  test("frames that arrive while the stream holds wait in the producer's sliding queue", async () => {
    const lane = await serve()
    const count = 2_000
    try {
      await lane.send({ _tag: "Request", id: "1", tag: "Latest", payload: { count }, headers: [] })
      await settle()
      // A held lane takes nothing more off the queue, so the producer's
      // backlog stays bounded by the queue, not by the link.
      const beforeAcks = lane.chunks("1").length
      let acknowledged = 0
      const deadline = Date.now() + 2_000
      while (!lane.exit("1") && Date.now() < deadline) {
        const sent = lane.chunks("1").length
        for (; acknowledged < sent; acknowledged++) await lane.send({ _tag: "Ack", requestId: "1" })
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      const values = lane.chunks("1").flatMap((chunk) => chunk.values ?? []).map(frameIndex)
      expect(lane.exit("1")).toBeDefined()
      expect(beforeAcks).toBeLessThan(count)
      expect(values.length).toBeLessThan(count)
      expect(values.at(-1)).toBe(count)
    } finally {
      await lane.dispose()
    }
  })

  test("every chunk reaches a slow client before the stream ends", async () => {
    const lane = await serve()
    const client = ManagedRuntime.make(socketProtocolLayer().pipe(Layer.provide(lane.clientSocket), Layer.provide(RpcSerialization.layerMsgPack)))
    try {
      const received = await client.runPromise(Effect.scoped(Effect.gen(function*() {
        const rpc = yield* RpcClient.make(Probe)
        // A two-value buffer and a consumer that yields after every value
        // keep chunks parked in the client while the stream's exit arrives.
        return yield* rpc.Frames({ count: 40 }, { streamBufferSize: 2 }).pipe(
          Stream.tap(() => Effect.yieldNow),
          Stream.map(frameIndex),
          Stream.runCollect,
        )
      })))
      expect([...received]).toEqual(Array.from({ length: 40 }, (_, index) => index + 1))
    } finally {
      await client.dispose()
      await lane.dispose()
    }
  })
})
