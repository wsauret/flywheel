import { describe, expect, test } from "bun:test";
import { Effect, FiberSet, Layer, ManagedRuntime, Redacted, Schema, Scope, Stream } from "effect";
import { Rpc, RpcClient, type RpcClientError, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc";
import { Socket, SocketServer } from "effect/unstable/socket";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type BunRawSocketConnection, bunSocketClientLayer, bunSocketServerLayer, createBunRawSocketServer } from "../../../../src/orchestration/app-service/bun-socket-rpc.js";
import { runtimeProtocolSocketServer } from "../../../../src/orchestration/app-service/runtime-protocol-socket-server.js";
import { createAccountSocketRouter } from "../../../../src/orchestration/app-service/account-socket-router.js";
import { encodeAccountAttach, newAccountAttachCredential } from "../../../../src/protocol/account-attach.js";

/** The socket placement of the runtime protocol server carries the three shapes
 *  the protocol itself is made of: unary calls, a typed error channel, and one
 *  long-lived stream. The stream is the shape a transport is most likely to get
 *  wrong, and the one whose breakage hides best, because a stalled event lane is
 *  observationally identical to an idle one from the client side.
 *
 *  These run against a stand-in protocol rather than `RuntimeProtocolRpc`, so a
 *  failure here names the transport rather than the runtime composition behind
 *  it. */

class ProtocolProbeError extends Schema.TaggedErrorClass<ProtocolProbeError>()("ProtocolProbeError", {
  message: Schema.String,
}) {}

const ProbeRpc = RpcGroup.make(
  Rpc.make("Echo", { payload: Schema.Struct({ text: Schema.String }), success: Schema.String, error: ProtocolProbeError }),
  Rpc.make("Boom", { success: Schema.Void, error: ProtocolProbeError }),
  Rpc.make("Ticks", { payload: Schema.Struct({ count: Schema.Number }), success: Schema.Number, error: ProtocolProbeError, stream: true }),
  Rpc.make("Idle", { success: Schema.Number, error: ProtocolProbeError, stream: true }),
);

const probeHandlers = ProbeRpc.toLayer(Effect.succeed(ProbeRpc.of({
  Echo: ({ text }) => Effect.succeed(`echo:${text}`),
  Boom: () => Effect.fail(new ProtocolProbeError({ message: "boom" })),
  Ticks: ({ count }) => Stream.range(1, count),
  Idle: () => Stream.never,
})));

/** A connected Bun socket as the two web streams `Socket.fromTransformStream`
 *  consumes. The shipped client is a Node extension host rather than Bun, so
 *  this stands in for it to exercise the server half; the framing on the wire
 *  is Effect's own and carries no runtime assumption either way. */
function connectStreams(path: string): Effect.Effect<Socket.InputTransformStream, Socket.SocketError> {
  return Effect.tryPromise({
    try: async () => {
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      const readable = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      const socket = await Bun.connect<undefined>({
        unix: path,
        socket: {
          data(_socket, chunk) {
            controller?.enqueue(new Uint8Array(chunk));
          },
          close() {
            controller?.close();
          },
          error(_socket, cause) {
            controller?.error(cause);
          },
        },
      });
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          socket.write(chunk);
        },
        close() {
          socket.end();
        },
      });
      return { readable, writable };
    },
    catch: (cause) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) }),
  });
}

/** Binds a server on a private socket, runs one client program against it, and
 *  settles both plus the directory the socket lived in. */
async function withProbeServer<A>(run: (client: RpcClient.RpcClient<RpcGroup.Rpcs<typeof ProbeRpc>, RpcClientError.RpcClientError>) => Effect.Effect<A, unknown>): Promise<A> {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-socket-rpc-"));
  const path = join(dir, "ide.sock");
  let onBound: (() => void) | undefined;
  const bound = new Promise<void>((resolve) => {
    onBound = resolve;
  });

  const server = ManagedRuntime.make(
    RpcServer.layer(ProbeRpc).pipe(
      Layer.provide(probeHandlers),
      Layer.provide(runtimeProtocolSocketServer),
      Layer.provide(RpcSerialization.layerNdjson),
      Layer.provide(bunSocketServerLayer({ path, onListening: () => onBound?.() })),
    ),
  );

  try {
    await server.runPromise(Effect.void);
    await bound;
    const client = ManagedRuntime.make(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(Layer.effect(Socket.Socket)(Socket.fromTransformStream(connectStreams(path)))),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    );
    try {
      return await client.runPromise(Effect.scoped(Effect.flatMap(RpcClient.make(ProbeRpc), run)));
    } finally {
      await client.dispose();
    }
  } finally {
    await server.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("runtime protocol over a Bun unix socket", () => {
  test.each([false, true])("bounds input while authenticated project admission waits (overflow: %s)", async (overflow) => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-socket-admission-"));
    const path = join(dir, "serve.sock");
    const credential = newAccountAttachCredential();
    const opening = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const received: Uint8Array[] = [];
    let receivedBytes = 0;
    let opens = 0;
    let releases = 0;
    let rawCalls = 0;
    let peerClosed = false;
    const router = createAccountSocketRouter<BunRawSocketConnection>({
      credential: Redacted.make(credential),
      canonicalizeProjectRoot: (root) => root,
      answerCutover: async () => "busy",
      answerRestart: async () => "busy",
      moduleRequest: async () => { throw new Error("no module service in this test") },
      client: async () => ({ kind: "failed", error: "unused" }),
      send: async (connection, bytes) => { await connection.send(bytes); },
      openProject: async () => {
        opens += 1;
        started.resolve();
        await opening.promise;
        return {
          receive: (bytes) => {
            received.push(bytes);
            receivedBytes += bytes.length;
            if (receivedBytes === 65536) delivered.resolve();
          },
          release: () => { releases += 1; },
        };
      },
    });
    const server = createBunRawSocketServer({
      path,
      onOpen() {},
      onData: async (connection, bytes) => {
        rawCalls += 1;
        if (await router.receive(connection, bytes) === "rejected") connection.close();
      },
      onClose: (connection) => { router.close(connection); },
    });
    const attach = new TextEncoder().encode(encodeAccountAttach({ intent: "runtime", credential, projectRoot: "/project" }));
    let socket: Awaited<ReturnType<typeof Bun.connect<undefined>>> | undefined;
    try {
      socket = await Bun.connect<undefined>({
        unix: path,
        socket: { data() {}, close() { peerClosed = true; closed.resolve(); }, error() {} },
      });
      socket.write(attach);
      await started.promise;
      for (let index = 0; index < (overflow ? 9 : 8); index += 1) {
        if (peerClosed) break;
        socket.write(new Uint8Array(8192).fill(index + 1));
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (overflow) {
        await Promise.race([
          closed.promise,
          new Promise<void>((resolve) => setTimeout(resolve, 25)),
        ]);
      }
      expect(peerClosed).toBe(overflow);
      expect(rawCalls).toBe(1);
      opening.resolve();
      if (overflow) {
        // Released sockets must stay closed after admission and its queued promise jobs settle.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(rawCalls).toBe(1);
      } else {
        await delivered.promise;
      }
      await server.dispose();
      const expected = new Uint8Array(overflow ? 0 : 65536);
      if (!overflow) {
        for (let index = 0; index < 8; index += 1) expected.fill(index + 1, index * 8192, (index + 1) * 8192);
      }
      expect(Buffer.concat(received)).toEqual(Buffer.from(expected));
      expect(opens).toBe(1);
      expect(releases).toBe(1);
    } finally {
      opening.resolve();
      socket?.terminate();
      await server.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a control frame the socket takes only in part is finished after drain", async () => {
    // The account router answers an attach through `send`. A peer that is not
    // reading fills the kernel buffer, so the socket takes a large frame only
    // in part, and the rest must follow once the peer drains.
    const dir = mkdtempSync(join(tmpdir(), "flywheel-socket-control-"));
    const path = join(dir, "serve.sock");
    const frame = new Uint8Array(1024 * 1024).map((_, index) => index % 251);
    const sent = Promise.withResolvers<void>();
    const all = Promise.withResolvers<void>();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;
    const server = createBunRawSocketServer({
      path,
      onOpen: (connection) => { void Promise.resolve(connection.send(frame)).then(() => sent.resolve()); },
      onData() {},
      onClose() {},
    });
    let socket: Awaited<ReturnType<typeof Bun.connect<undefined>>> | undefined;
    try {
      socket = await Bun.connect<undefined>({
        unix: path,
        socket: {
          data(_socket, chunk) {
            chunks.push(new Uint8Array(chunk));
            receivedBytes += chunk.length;
            if (receivedBytes >= frame.length) all.resolve();
          },
        },
      });
      await all.promise;
      await sent.promise;
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(frame));
    } finally {
      socket?.terminate();
      await server.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a client whose attach a wedged account service never answers disposes at once", async () => {
    // A stopped account service still accepts connections into its kernel
    // backlog and answers nothing. The attach that dialed it must end with its
    // scope; a dial that cannot be abandoned holds the reconnecting client in
    // its disposal until the service answers, and no fault or retry follows.
    const dir = mkdtempSync(join(tmpdir(), "flywheel-socket-wedged-"));
    const path = join(dir, "serve.sock");
    const prefaced = Promise.withResolvers<void>();
    let peerClosed = false;
    const listener = Bun.listen<undefined>({
      unix: path,
      socket: { data() { prefaced.resolve(); }, close() { peerClosed = true; } },
    });
    const client = ManagedRuntime.make(
      RpcClient.layerProtocolSocket().pipe(
        Layer.provide(bunSocketClientLayer(path, undefined, () => new Uint8Array([1]))),
        Layer.provide(RpcSerialization.layerNdjson),
      ),
    );
    try {
      client.runFork(Effect.scoped(Effect.flatMap(RpcClient.make(ProbeRpc), (rpc) => rpc.Echo({ text: "x" }))));
      await prefaced.promise;
      await client.dispose();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(peerClosed).toBe(true);
    } finally {
      listener.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 2_000);

  test("carries a unary call", async () => {
    const reply = await withProbeServer((rpc) => rpc.Echo({ text: "hello" }));
    expect(reply).toBe("echo:hello");
  });

  test("carries a typed failure as a failure, not a wire fault", async () => {
    const exit = await withProbeServer((rpc) => Effect.exit(rpc.Boom()));
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(exit)).toContain("ProtocolProbeError");
  });

  test("carries a stream in order", async () => {
    const ticks = await withProbeServer((rpc) => Stream.runCollect(rpc.Ticks({ count: 5 })));
    expect([...ticks]).toEqual([1, 2, 3, 4, 5]);
  });

  test("carries a stream past the kernel buffer, so the drain path runs", async () => {
    // Small enough to stay a unit test, large enough that the socket cannot
    // take it in one write: partial writes are what exercise the parked-writer
    // and drain handling, and that path is otherwise never reached locally.
    const ticks = await withProbeServer((rpc) => Stream.runCollect(rpc.Ticks({ count: 20_000 })));
    const received = [...ticks];
    expect(received.length).toBe(20_000);
    expect(received[0]).toBe(1);
    expect(received.at(-1)).toBe(20_000);
  });

  test("reports the open count back to zero when a client disconnects", async () => {
    // The idle reaper arms on this number reaching zero. `error` used to tear a
    // connection down without decrementing while `close` decremented whether or
    // not the socket was still held, so the two could disagree and a runtime
    // that never saw zero would never reap.
    const dir = mkdtempSync(join(tmpdir(), "flywheel-socket-count-"));
    const path = join(dir, "ide.sock");
    const counts: number[] = [];
    let onBound: (() => void) | undefined;
    const bound = new Promise<void>((resolve) => { onBound = resolve; });

    const server = ManagedRuntime.make(
      RpcServer.layer(ProbeRpc).pipe(
        Layer.provide(probeHandlers),
        Layer.provide(runtimeProtocolSocketServer),
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(bunSocketServerLayer({
          path,
          onListening: () => onBound?.(),
          onConnectionCountChanged: (open) => { counts.push(open); },
        })),
      ),
    );

    try {
      await server.runPromise(Effect.void);
      await bound;
      const client = ManagedRuntime.make(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Layer.effect(Socket.Socket)(Socket.fromTransformStream(connectStreams(path)))),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
      );
      await client.runPromise(Effect.scoped(Effect.flatMap(RpcClient.make(ProbeRpc), (rpc) => rpc.Echo({ text: "x" }))));
      await client.dispose();
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      await server.dispose();
      rmSync(dir, { recursive: true, force: true });
    }

    expect(counts[0]).toBe(1);
    expect(counts.at(-1)).toBe(0);
    // Released exactly once: no handler decrements a socket another already freed.
    expect(counts.filter((n) => n === 0)).toHaveLength(1);
    expect(Math.min(...counts)).toBe(0);
  });

  test("a per-connection protocol disposes after its listener closed the socket", async () => {
    // The account service closes its listener first and disposes each
    // connection's protocol afterwards. The RPC server ends every client with a
    // final frame and opens its shutdown latch only once that write settles, so
    // a write to the closed socket must complete rather than fail, or the
    // protocol's disposal never settles and the stopping service never exits.
    const dir = mkdtempSync(join(tmpdir(), "flywheel-socket-drain-"));
    const path = join(dir, "serve.sock");
    let protocol: ManagedRuntime.ManagedRuntime<never, never> | undefined;
    let protocolDisposal: Promise<void> | undefined;
    const bound = Promise.withResolvers<void>();
    const server = createBunRawSocketServer({
      path,
      onOpen: (connection: BunRawSocketConnection) => {
        const singletonSocketServer = Layer.succeed(SocketServer.SocketServer, SocketServer.SocketServer.of({
          address: { _tag: "UnixAddress", path },
          run: <R, E, A>(handler: (socket: Socket.Socket) => Effect.Effect<A, E, R>) =>
            Effect.scopedWith((scope) =>
              Effect.gen(function*() {
                const fibers = yield* FiberSet.make<unknown, unknown>().pipe(Scope.provide(scope));
                const runFork = yield* FiberSet.runtime(fibers)<R>();
                runFork(Effect.flatMap(Socket.Socket, handler).pipe(Effect.provide(connection.socketLayer)));
                return yield* Effect.never;
              }),
            ),
        }));
        protocol = ManagedRuntime.make(
          RpcServer.layer(ProbeRpc).pipe(
            Layer.provide(probeHandlers),
            Layer.provide(runtimeProtocolSocketServer),
            Layer.provide(RpcSerialization.layerNdjson),
            Layer.provide(singletonSocketServer),
          ),
        );
        void protocol.runPromise(Effect.void).then(() => bound.resolve());
      },
      onData: (connection, bytes) => { connection.receive(bytes); },
      // The account service disposes a connection's protocol from this very
      // callback, in the same tick as the socket close.
      onClose: () => { protocolDisposal = protocol?.dispose(); },
    });
    try {
      await server.ready;
      const client = ManagedRuntime.make(
        RpcClient.layerProtocolSocket().pipe(
          Layer.provide(Layer.effect(Socket.Socket)(Socket.fromTransformStream(connectStreams(path)))),
          Layer.provide(RpcSerialization.layerNdjson),
        ),
      );
      // The client's socket opens with its first call, and the connection's
      // protocol is built as that socket is accepted. An idle subscription is
      // open when the listener closes, the way a client's event lane is on the
      // account service; the server's farewell for that request is the write
      // that must settle.
      client.runFork(Effect.scoped(Effect.gen(function*() {
        const rpc = yield* RpcClient.make(ProbeRpc);
        expect(yield* rpc.Echo({ text: "x" })).toBe("echo:x");
        yield* Stream.runDrain(rpc.Idle());
      })));
      await bound.promise;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await server.dispose();
      await protocolDisposal;
      await client.dispose();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 3_000);
});
