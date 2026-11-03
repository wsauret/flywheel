import net from "node:net"
import { Duplex } from "node:stream"

import { Effect, FiberSet, Layer, ManagedRuntime, Queue, Schema, Scope, Stream } from "effect"
import { Rpc, RpcGroup, RpcServer } from "effect/rpc"
import { layerMsgPack } from "../../../../src/protocol/rpc-msgpack.js"
import { NetAddress } from "effect/net"
import { Socket, SocketServer } from "effect/socket"
import { runtimeProtocolSocketServer } from "../../../../src/orchestration/app-service/runtime-protocol-socket-server.js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { runtimeHandlers, type RuntimeHandlerOptions } from "../../../../src/orchestration/app-service/runtime-protocol-handlers.js"
import { createOutputWatches } from "../../../../src/orchestration/app-service/output-watches.js"
import { RuntimeProtocolError, RuntimeProtocolRpc } from "../../../../src/protocol/runtime-protocol-schemas.js"

/** The smallest real transport: a unix socket wrapped as an Effect `Socket`.
 *  The connection under test is transport-agnostic, so the test supplies the
 *  same shape an editor host does, without depending on that host's module. */
export function unixSocketLayer(socketPath: string): Layer.Layer<Socket.Socket> {
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
    const { readable, writable } = Duplex.toWeb(connection)
    // Bun's node:stream/web stream is the global class, which the declarations of node:stream/web do not state.
    if (!(readable instanceof ReadableStream)) throw new Error("node:stream/web returned a foreign ReadableStream")
    return { readable, writable }
  }))
  return Layer.effect(Socket.Socket)(Socket.fromTransformStream(connect))
}

/** One direction of an in-memory pipe whose close settles at once, as a real
 *  socket's does. `sever` makes it a dead socket: writes fail and nothing
 *  arrives, with no close event to either side. `mute` makes it a half-open
 *  socket: writes succeed and nothing arrives. */
function pipe() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  let closed = false
  let severed = false
  let muted = false
  const readable = new ReadableStream<Uint8Array>({
    start(c) { controller = c },
    cancel() { closed = true },
  })
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (severed) throw new Error("the socket is gone")
      if (!closed && !muted) controller?.enqueue(chunk)
    },
    close() { if (!closed) { closed = true; try { controller?.close() } catch { /* the reader already left */ } } },
    abort(reason) { if (!closed) { closed = true; try { controller?.error(reason) } catch { /* the reader already left */ } } },
  })
  return {
    readable,
    writable,
    sever: () => { severed = true },
    mute: () => { muted = true },
    /** The writer ends the stream, and the reader hears its end. */
    end: (cause?: unknown) => { if (!closed) { closed = true; try { if (cause === undefined) controller?.close(); else controller?.error(cause) } catch { /* the reader already left */ } } },
  }
}

/** A server over in-memory sockets: `serve` builds it on the socket server
 *  given, and every client acquisition is a fresh socket pair. */
async function memoryServed(serve: (sockets: Layer.Layer<SocketServer.SocketServer>) => Layer.Layer<never>) {
  const dialed: Array<{ sever: () => void; mute: () => void; end: (cause?: unknown) => void }> = []
  // The RPC protocol forks `run`; the first client must not dial before it starts.
  const accepting = Promise.withResolvers<(socket: Socket.Socket) => void>()
  const sockets = Layer.succeed(SocketServer.SocketServer)(SocketServer.SocketServer.of({
    address: NetAddress.unixPathAddress("memory"),
    run: <R, E, _>(handler: (socket: Socket.Socket) => Effect.Effect<_, E, R>) => Effect.scopedWith((scope) => Effect.gen(function*() {
      const fiberSet = yield* FiberSet.make<unknown, unknown>().pipe(Scope.provide(scope))
      const runFork = yield* FiberSet.runtime(fiberSet)<R>()
      accepting.resolve((socket) => { runFork(handler(socket)) })
      return yield* Effect.never
    })),
  }))
  const server = ManagedRuntime.make(serve(sockets))
  await server.runPromise(Effect.void)
  const accept = await accepting.promise
  const client = Layer.effect(Socket.Socket)(Effect.gen(function*() {
    const toServer = pipe()
    const toClient = pipe()
    const serverSide = yield* Socket.fromTransformStream(Effect.succeed({ readable: toServer.readable, writable: toClient.writable }))
    // A clean close ends both directions, so the runtime's side of the lane
    // ends too and stops taking events that belong to the next lane.
    let ended: { readonly cause: unknown } | undefined
    dialed.push({ sever: () => { toServer.sever(); toClient.sever() }, mute: () => { toServer.mute(); toClient.mute() }, end: (cause) => { if (cause !== undefined) ended = { cause }; toClient.end(cause); toServer.end() } })
    accept(serverSide)
    const inner = yield* Socket.fromTransformStream(Effect.succeed({ readable: toClient.readable, writable: toServer.writable }))
    // A failed web stream reaches its reader as a read error whatever failed
    // it. The cause a test ends a lane with stands for the transport's own
    // failure, so the read ends with that cause, a defect for a plain error.
    const failRead = (error: Socket.SocketError) => ended === undefined ? Effect.fail(error) : Socket.isSocketError(ended.cause) ? Effect.fail(ended.cause) : Effect.die(ended.cause)
    return Socket.make({ writer: inner.writer, reader: Effect.map(inner.reader, (reader) => ({ ...reader, pull: reader.pull.pipe(Effect.catch(failRead)) })) })
  }))
  return { client, dialed, server }
}

/** The runtime's own protocol handlers over in-memory sockets, with a
 *  service whose every read answers at once. `clientIdentity` is the
 *  runtime's own client, as the handlers take it. `arrivals` names every
 *  request in the order the handlers took it, recorded as the handler is
 *  called, which is when the runtime decides whether a call waits for a
 *  subscription. `emit` publishes an event to every lane, and `unions` is
 *  each union of watched sessions the connections' statements made. */
export async function servedRuntime(options: Omit<RuntimeHandlerOptions, "version"> = {}, dispatch: Parameters<typeof runtimeHandlers>[0]["client"]["dispatch"] = () => Promise.reject(new Error("not served"))) {
  const answer = runtimeQuery({ commandUsageSnapshot: async () => ({ usage: { uses: [] }, snapshotPosition: 0 }) })
  const listeners = new Set<(event: FrontendEvent) => void>()
  const service: Parameters<typeof runtimeHandlers>[0]["client"] = {
    query: answer,
    dispatch,
    disconnect: () => {},
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const unions: (readonly string[])[] = []
  const outputWatches = createOutputWatches({ onUnionChange: (sessionIds) => { unions.push(sessionIds) } })
  const log = { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} }
  const arrivals: string[] = []
  const observed = RuntimeProtocolRpc.toLayer(Effect.gen(function*() {
    const query = yield* RuntimeProtocolRpc.accessHandler("RuntimeQuery")
    const dispatched = yield* RuntimeProtocolRpc.accessHandler("RuntimeDispatch")
    const events = yield* RuntimeProtocolRpc.accessHandler("RuntimeEvents")
    const diagnostic = yield* RuntimeProtocolRpc.accessHandler("RuntimeClientDiagnostic")
    return RuntimeProtocolRpc.of({
      RuntimeQuery: (payload, request) => { arrivals.push(`query:${payload.type}`); return query(payload, request) },
      RuntimeDispatch: (payload, request) => { arrivals.push(`dispatch:${payload.type}`); return dispatched(payload, request) },
      RuntimeEvents: (payload, request) => { arrivals.push("events"); return events(payload, request) },
      RuntimeClientDiagnostic: diagnostic,
    })
  })).pipe(Layer.provide(runtimeHandlers({ client: service, outputWatches }, log, { version: SERVED_VERSION, ...options })))
  const { client, server } = await memoryServed((sockets) => RpcServer.layer(RuntimeProtocolRpc).pipe(
    Layer.provide(observed),
    Layer.provide(runtimeProtocolSocketServer),
    Layer.provide(layerMsgPack),
    Layer.provide(sockets),
  ))
  return {
    client, arrivals, unions,
    emit: (event: FrontendEvent) => { for (const listener of listeners) listener(event) },
    close: () => server.dispose(),
  }
}

/** The release a served runtime runs. */
export const SERVED_VERSION = "0.1.0"

/** The event that makes the lane it reaches fail. */
const LANE_FAILS = Symbol("lane fails")

/** A runtime that serves the protocol over in-memory sockets and sends on the
 *  event lane only what the test puts there, so the test decides when the
 *  client last heard from it. Every client acquisition is a fresh socket pair.
 *  With `identity`, it is a runtime that serves that client and refuses an
 *  attach that states another. `serve` sets the release it runs; while that
 *  release speaks another protocol than the attach states, it refuses the
 *  attach as the runtime does. */
/** A fake runtime whose lanes carry the frames a test emits. With `greets`,
 *  every lane also answers at once with `runtime.connected`, as the real
 *  runtime does, so each lane is heard without a frame the test emits. */
export async function heartbeatRuntime(options: { readonly identity?: string; readonly answersQueries?: boolean; readonly greets?: boolean } = {}) {
  let serving: { version: string; protocolVersion: number } | undefined
  // A newer server can send variants outside this client's current schema.
  const protocol = RpcGroup.make(
    Rpc.make("RuntimeQuery", { payload: Schema.Unknown, success: Schema.Unknown, error: RuntimeProtocolError }),
    Rpc.make("RuntimeDispatch", { payload: Schema.Unknown, success: Schema.Unknown, error: RuntimeProtocolError }),
    // The attach shape the client sends: the protocol and identity the fake refuses on.
    Rpc.make("RuntimeEvents", { payload: Schema.Struct({ protocolVersion: Schema.optional(Schema.Number), clientIdentity: Schema.optional(Schema.String) }), success: Schema.Unknown, error: RuntimeProtocolError, stream: true }),
    Rpc.make("RuntimeClientDiagnostic", { payload: Schema.Unknown, error: RuntimeProtocolError }),
  )
  const events = await Effect.runPromise(Queue.unbounded<unknown>())
  const reports: unknown[] = []
  const attaches: Array<string | undefined> = []
  // Every request in the order the runtime's handlers took it, with the
  // discriminant of a query or a mutation.
  const arrivals: string[] = []
  const typeOf = (payload: unknown): string => typeof payload === "object" && payload !== null && "type" in payload ? String(payload.type) : "?"
  const handlers = protocol.toLayer(Effect.succeed(protocol.of({
    RuntimeQuery: (query) => {
      arrivals.push(`query:${typeOf(query)}`)
      // A runtime that takes a read and never answers it, while its lane
      // still heartbeats.
      return options.answersQueries === false ? Effect.never : Effect.succeed({ usage: { uses: [] }, snapshotPosition: 0 })
    },
    RuntimeDispatch: (mutation) => {
      const watched = typeof mutation === "object" && mutation !== null && "sessionIds" in mutation && Array.isArray(mutation.sessionIds) ? `:${mutation.sessionIds.join(",")}` : ""
      arrivals.push(`dispatch:${typeOf(mutation)}${watched}`)
      return Effect.fail(new RuntimeProtocolError({ message: "not served", kind: "internal" }))
    },
    RuntimeEvents: (attach) => {
      arrivals.push("events")
      attaches.push(attach.clientIdentity)
      if (options.identity !== undefined && attach.clientIdentity !== undefined && attach.clientIdentity !== options.identity) {
        return Stream.fail(new RuntimeProtocolError({ kind: "client-mismatch", message: "the runtime serves another client than this page runs" }))
      }
      return serving !== undefined && attach.protocolVersion !== serving.protocolVersion
        ? Stream.fail(new RuntimeProtocolError({ kind: "protocol-mismatch", message: `the runtime speaks protocol ${serving.protocolVersion}`, runtime: serving }))
        : Stream.concat(options.greets === true ? Stream.make<[unknown]>({ type: "runtime.connected" }) : Stream.empty, Stream.fromQueue(events).pipe(Stream.mapEffect((event) => event === LANE_FAILS
          ? Effect.fail(new RuntimeProtocolError({ kind: "internal", message: "the runtime could not serve this lane" }))
          : Effect.succeed(event))))
    },
    RuntimeClientDiagnostic: (report) => Effect.sync(() => { reports.push(report) }),
  })))
  const { client, dialed, server } = await memoryServed((sockets) => RpcServer.layer(protocol).pipe(
    Layer.provide(handlers),
    Layer.provide(runtimeProtocolSocketServer),
    Layer.provide(layerMsgPack),
    Layer.provide(sockets),
  ))
  return {
    client,
    emit: (event: unknown) => Effect.runPromise(Queue.offer(events, event)),
    reports,
    /** The client identity each event attach stated, in order. */
    attaches,
    serve: (release: { version: string; protocolVersion: number }) => { serving = release },
    /** Each request as the runtime took it: `events`, `query:<type>`, or
     *  `dispatch:<type>`, which an `output.watch` follows with its sessions,
     *  as `dispatch:output.watch:a,b`. */
    arrivals,
    heartbeat: () => Effect.runPromise(Queue.offer(events, { type: "runtime.heartbeat" })),
    /** Ends the lane now serving with an error, as a runtime that accepts an
     *  attach and then cannot serve it does. */
    failLane: () => Effect.runPromise(Queue.offer(events, LANE_FAILS)),
    connections: () => dialed.length,
    /** Kills the newest socket the way a suspended phone's dies: silently. */
    severLatest: () => dialed.at(-1)?.sever(),
    /** Leaves the newest socket half open: the client's writes succeed, and
     *  nothing reaches either side. */
    muteLatest: () => dialed.at(-1)?.mute(),
    /** Closes the newest socket, cleanly unless the boundary reports a cause. */
    endLatest: (cause?: unknown) => dialed.at(-1)?.end(cause),
    close: () => server.dispose(),
  }
}

/** A backoff the test releases by hand, so a call can be made while the
 *  connection has no lane. */
export function heldBackoff() {
  const waits: Array<() => void> = []
  return {
    waitForBackoff: (_ms: number, woken: Promise<void>) => new Promise<void>((resolve) => {
      waits.push(resolve)
      void woken.then(resolve)
    }),
    waiting: () => waits.length,
    release: () => { for (const resolve of waits.splice(0)) resolve() },
  }
}

/** Runs `body` with every timer of a `deadlineMs` deadline held until the test
 *  calls `expire`, so the deadline passes only when the test says. A deadline
 *  counted from an earlier moment schedules its timer for what remains of it,
 *  a little less on a slow host, so every timer longer than half the deadline
 *  and no longer than it is held. Other timers run as usual. */
export async function withHeldDeadlines(deadlineMs: number, body: (expire: () => void) => Promise<void>): Promise<void> {
  const original = globalThis.setTimeout
  const held: (() => void)[] = []
  const holding = (callback: (...args: unknown[]) => void, milliseconds?: number, ...args: unknown[]) => {
    if (milliseconds === undefined || milliseconds <= deadlineMs / 2 || milliseconds > deadlineMs) return original(callback, milliseconds, ...args)
    held.push(() => callback(...args))
    return original(() => {}, 2 ** 31 - 1)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: setTimeout merges DOM, Node, and Bun overloads that return number, Timeout, and Timer, so no function satisfies it, and the client takes no clock
  globalThis.setTimeout = holding as typeof setTimeout
  try {
    await body(() => { for (const expire of held.splice(0)) expire() })
  } finally {
    globalThis.setTimeout = original
  }
}

export async function waitFor(condition: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition did not settle in time")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
