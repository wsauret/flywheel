import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { RpcTest } from "effect/rpc"
import { TestClock } from "effect/testing"
import type { FrontendEvent, RuntimeEventFrame } from "../../../../src/protocol/app-service-types.js"
import { runtimeHandlers, type RuntimeHandlerOptions } from "../../../../src/orchestration/app-service/runtime-protocol-handlers.js"
import { createOutputWatches } from "../../../../src/orchestration/app-service/output-watches.js"
import { runtimeEventDelivery } from "../../../../src/orchestration/app-service/runtime-event-delivery.js"
import { RuntimeEventFrameSchema, RuntimeProtocolRpc } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { RUNTIME_EVENT_HEARTBEAT_INTERVAL_MS, RUNTIME_LIVENESS_POLICY, RUNTIME_PROTOCOL_VERSION } from "../../../../src/protocol/runtime-liveness.js"
import { createFamilyIntake } from "../../../../src/protocol/client/family-intake.js"
import { createCursorIntake } from "../../../../src/protocol/client/cursor-intake.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import { sessionCursor } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { catalogRow, readyCatalogRow } from "../../../helpers/session-catalog.js"
import { DebugLog, listDebugLogFiles, resolveDebugLogDirectory, scanDebugLogFiles } from "../../../../src/infra/debug-log.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

/** The per-connection outbound queue policy: a client that stops draining
 *  keeps its lane. Past the bound the oldest frames are dropped rather than
 *  the connection, the backlog stays bounded in runtime memory, and the
 *  receiver answers the explicit invalidation with an ordinary resnapshot. A phone that is slow
 *  to draw must never see its runtime hang up on it. */

function stubService() {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const unused = () => Promise.reject(new Error("not under test"))
  const disconnected: object[] = []
  const service: Parameters<typeof runtimeHandlers>[0]["client"] = {
    query: unused,
    dispatch: unused,
    disconnect: (connection) => { disconnected.push(connection) },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    service,
    disconnected,
    listenerCount: () => listeners.size,
    emit: (event: FrontendEvent) => { for (const listener of listeners) listener(event) },
  }
}

/** An ordinary workspace patch whose position the test reads back. */
function markerEvent(position: number): FrontendEvent {
  return { type: "patch", patch: { cursor: { scope: "workspace", domain: "executor" }, position, prevPosition: 0, payload: { kind: "executor.changed", executor: { kind: "serving" } } } }
}

function markerPosition(event: { readonly type: string }): number | undefined {
  return event.type === "patch" && "patch" in event && typeof event.patch === "object" && event.patch !== null && "position" in event.patch && typeof event.patch.position === "number" && "payload" in event.patch && typeof event.patch.payload === "object" && event.patch.payload !== null && "kind" in event.patch.payload && event.patch.payload.kind === "executor.changed" ? event.patch.position : undefined
}

const VERSION = "0.1.0"
/** The attach of a client of this runtime's protocol that runs no bundle. */
const ATTACH = { protocolVersion: RUNTIME_PROTOCOL_VERSION }

function harness(options: Omit<RuntimeHandlerOptions, "version"> = {}) {
  const stub = stubService()
  const warnings: Array<{ message: unknown; fields: unknown }> = []
  const infos: Array<{ message: unknown; fields: unknown }> = []
  const log = { debug: () => {}, info: (message: unknown, fields?: unknown) => { infos.push({ message, fields }) }, error: () => {}, warn: (message: unknown, fields?: unknown) => { warnings.push({ message, fields }) } }
  const layer = runtimeHandlers({ client: stub.service, outputWatches: createOutputWatches({ onUnionChange: () => {} }) }, log, { version: VERSION, ...options })
  return { stub, layer, warnings, infos }
}

const identity = "a".repeat(64)
const otherIdentity = "b".repeat(64)
const makeDirectory = temporaryDirectories()

type HandlerLayer = ReturnType<typeof harness>["layer"]
type AttachStatement = { readonly protocolVersion?: number; readonly clientIdentity?: string }

/** The first frame the runtime sends for one attach, or the error it fails
 *  the stream with instead. The handlers are built for this attach alone. */
async function attach(layer: HandlerLayer, _stub: ReturnType<typeof stubService>, stated: AttachStatement = ATTACH) {
  const transport = ManagedRuntime.make(layer)
  try {
    return await attachTo(transport, stated)
  } finally {
    await transport.dispose()
  }
}

/** One attach to handlers a transport built once and serves every attach with. */
function attachTo(transport: ManagedRuntime.ManagedRuntime<Layer.Success<HandlerLayer>, never>, stated: AttachStatement = ATTACH) {
  return transport.runPromise(Effect.gen(function*() {
    const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
    const reading = yield* Stream.runCollect(client.RuntimeEvents(stated).pipe(Stream.take(1))).pipe(Effect.forkScoped)
    return yield* Fiber.join(reading).pipe(Effect.map((events) => ({ admitted: true as const, first: decodeFrame(events[0]) })), Effect.catchTag("RuntimeProtocolError", (error) => Effect.succeed({ admitted: false as const, kind: error.kind, message: error.message, ...(error.runtime === undefined ? {} : { runtime: error.runtime }) })))
  }).pipe(Effect.scoped))
}

const decodeFrame = Schema.decodeUnknownSync(RuntimeEventFrameSchema)

const awaitListener = (stub: ReturnType<typeof stubService>) =>
  Effect.gen(function*() {
    while (stub.listenerCount() === 0) yield* Effect.yieldNow
  })

describe("RuntimeEvents client identity", () => {
  test("a client of another build fails the stream at once with client-mismatch", async () => {
    const { stub, layer } = harness({ clientIdentity: async () => identity })
    expect(await attach(layer, stub, { ...ATTACH, clientIdentity: otherIdentity })).toEqual({ admitted: false, kind: "client-mismatch", message: "the runtime serves another client than this page runs" })
    expect(stub.listenerCount()).toBe(0)
    // The refused lane ends the connection, so every session it held is let go.
    expect(stub.disconnected).toHaveLength(1)
  })

  test("the end of a connection's event lane lets go of the sessions that connection held", async () => {
    const { stub, layer } = harness()
    const holders: object[] = []
    const activate = runtimeDispatch({ "session.activate": async () => ({ ok: true }) })
    stub.service.dispatch = (mutation, connection) => {
      if (connection !== undefined) holders.push(connection)
      return activate(mutation)
    }
    await attach(layer, stub)
    expect(stub.disconnected).toHaveLength(1)
    await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      yield* client.RuntimeDispatch({ type: "session.activate", sessionId: "chat" })
    }).pipe(Effect.scoped, Effect.provide(layer)))
    expect(holders).toHaveLength(1)
    expect(stub.disconnected).not.toContain(holders[0])
  })

  test("the runtime's own client and a client of its protocol that runs no bundle are admitted", async () => {
    const { stub, layer } = harness({ clientIdentity: async () => identity })
    expect(await attach(layer, stub, { ...ATTACH, clientIdentity: identity })).toMatchObject({ admitted: true, first: { type: "runtime.connected" } })
    expect(await attach(layer, stub)).toMatchObject({ admitted: true, first: { type: "runtime.connected" } })
  })

  test("a runtime that serves no client admits every identity of its protocol", async () => {
    const { stub, layer } = harness()
    expect(await attach(layer, stub, { ...ATTACH, clientIdentity: otherIdentity })).toMatchObject({ admitted: true, first: { type: "runtime.connected" } })
  })

  test("a client of another protocol, or one from before clients stated it, is refused with the runtime's release", async () => {
    const { stub, layer, infos } = harness()
    const transport = ManagedRuntime.make(layer)
    const refused = { admitted: false, kind: "protocol-mismatch", runtime: { version: VERSION, protocolVersion: RUNTIME_PROTOCOL_VERSION } }
    try {
      expect(await attachTo(transport, { protocolVersion: RUNTIME_PROTOCOL_VERSION + 1 })).toMatchObject(refused)
      expect(await attachTo(transport, { protocolVersion: RUNTIME_PROTOCOL_VERSION - 1 })).toMatchObject(refused)
      // A terminal of an earlier release states nothing at all.
      expect(await attachTo(transport, {})).toMatchObject(refused)
      // A refused client attaches again until the versions agree, and its
      // repeats only count.
      expect(await attachTo(transport, { protocolVersion: RUNTIME_PROTOCOL_VERSION + 1 })).toMatchObject(refused)
    } finally {
      await transport.dispose()
    }
    expect(stub.listenerCount()).toBe(0)
    expect(stub.disconnected).toHaveLength(4)
    expect(infos.filter((record) => record.message === "runtime event stream refused a client of another protocol").map((record) => record.fields)).toEqual([
      { offered: String(RUNTIME_PROTOCOL_VERSION + 1), own: RUNTIME_PROTOCOL_VERSION },
      { offered: String(RUNTIME_PROTOCOL_VERSION - 1), own: RUNTIME_PROTOCOL_VERSION },
      { offered: "none", own: RUNTIME_PROTOCOL_VERSION },
    ])
    // The transport's end reports the repeat it counted.
    expect(infos.filter((record) => record.message === "runtime event stream refused a client of another protocol again").map((record) => record.fields)).toEqual([
      { offered: String(RUNTIME_PROTOCOL_VERSION + 1), own: RUNTIME_PROTOCOL_VERSION, count: 1, windowMs: expect.any(Number) },
    ])
  })

  test("a page loaded before clients stated their protocol is refused as another bundle, so it reloads", async () => {
    const { stub, layer } = harness({ clientIdentity: async () => identity })
    expect(await attach(layer, stub, { clientIdentity: otherIdentity })).toMatchObject({ admitted: false, kind: "client-mismatch" })
  })
})

describe("RuntimeEvents bounded per-connection queue", () => {
  test.each([0, 5000])("gracefully stops admission and drains %s queued events without waiting for heartbeat", async (count) => {
    const { stub, infos } = harness()
    const log = { debug: () => {}, info: (message: unknown, fields?: unknown) => { infos.push({ message, fields }) }, error: () => {}, warn: () => {} }
    const received: RuntimeEventFrame[] = []
    await Effect.runPromise(Effect.gen(function*() {
      const blocked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const drain = yield* Deferred.make<void>()
      const fiber = yield* runtimeEventDelivery(stub.service, log, RUNTIME_LIVENESS_POLICY, () => {}, { drain: Deferred.await(drain) }).pipe(
        Stream.runForEach((frame) => Effect.gen(function*() {
          received.push(frame)
          if (frame.type === "runtime.connected") {
            yield* Deferred.succeed(blocked, undefined)
            yield* Deferred.await(release)
          }
        })),
        Effect.forkScoped,
      )
      yield* Deferred.await(blocked)
      for (let position = 0; position < count; position++) stub.emit(markerEvent(position))
      yield* Deferred.succeed(drain, undefined)
      while (stub.listenerCount() !== 0) yield* Effect.yieldNow
      stub.emit(markerEvent(count))
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(fiber)
    }).pipe(Effect.scoped))
    const retained = received.filter((frame) => frame.type !== "runtime.connected" && !(frame.type === "patch" && frame.patch.payload.kind === "runtime.invalidate"))
    expect(retained.length).toBeLessThanOrEqual(2048)
    if (count > 0) expect(retained.map(markerPosition)).toContain(count - 1)
    if (count > 2048) expect(received.at(-1)).toMatchObject({ type: "patch", patch: { payload: { kind: "runtime.invalidate", reason: "overflow" } } })
    expect(received.filter((frame) => frame.type === "runtime.heartbeat").length).toBeLessThanOrEqual(1)
    expect(stub.listenerCount()).toBe(0)
    expect(infos.filter((entry) => entry.message === "runtime event stream unsubscribed")).toHaveLength(1)
  })

  test("a blocked delivery consumer admits a bounded newest batch before recovery and unsubscribes on interruption", async () => {
    const { stub, infos } = harness()
    const subscribed = Promise.withResolvers<void>()
    const log = { debug: () => {}, info: (message: unknown, fields?: unknown) => { infos.push({ message, fields }) }, error: () => {}, warn: () => {} }
    const received: RuntimeEventFrame[] = []
    await Effect.runPromise(Effect.gen(function*() {
      const blocked = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const recovered = yield* Deferred.make<void>()
      const stream = runtimeEventDelivery(stub.service, log, RUNTIME_LIVENESS_POLICY, () => subscribed.resolve())
      const fiber = yield* Stream.runForEach(stream, (event) => Effect.gen(function*() {
        received.push(event)
        if (event.type === "runtime.connected") {
          yield* Deferred.succeed(blocked, undefined)
          yield* Deferred.await(release)
        }
        if (event.type === "patch" && event.patch.payload.kind === "runtime.invalidate") {
          yield* Deferred.succeed(recovered, undefined)
        }
      })).pipe(Effect.forkScoped)
      yield* Effect.promise(() => subscribed.promise)
      yield* Deferred.await(blocked)
      for (let position = 0; position < 5000; position += 1) stub.emit(markerEvent(position))
      expect(received.map((event) => event.type)).toEqual(["runtime.connected"])
      expect(stub.listenerCount()).toBe(1)
      yield* Deferred.succeed(release, undefined)
      yield* Deferred.await(recovered)
      expect(received.map(markerPosition).filter((position) => position !== undefined)).toEqual(
        Array.from({ length: 2048 }, (_, index) => 2952 + index),
      )
      expect(received.at(-1)).toMatchObject({
        type: "patch",
        patch: { cursor: { scope: "workspace", domain: "runtime" }, payload: { kind: "runtime.invalidate", reason: "overflow" } },
      })
      yield* Fiber.interrupt(fiber)
      expect(stub.listenerCount()).toBe(0)
      stub.emit(markerEvent(5000))
    }).pipe(Effect.scoped))
    expect(infos.filter((entry) => entry.message === "runtime event stream unsubscribed")).toHaveLength(1)
    expect(infos.filter((entry) => entry.message === "runtime event stream overflowed; invalidating after the retained batch")).toHaveLength(1)
  })

  test("a 654-session hydration-sized burst fits without dropping frames", async () => {
    const { stub, layer } = harness()
    const received = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      const positions: number[] = []
      const fiber = yield* Stream.runForEach(client.RuntimeEvents(ATTACH), (input) => Effect.sync(() => {
        const position = markerPosition(decodeFrame(input))
        if (position !== undefined) positions.push(position)
      })).pipe(Effect.forkScoped)
      yield* awaitListener(stub)
      for (let position = 0; position < 1308; position += 1) stub.emit(markerEvent(position))
      while (positions.at(-1) !== 1307) yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      return positions
    }).pipe(Effect.scoped, Effect.provide(layer)))
    expect(received).toEqual(Array.from({ length: 1308 }, (_, position) => position))
    expect(stub.listenerCount()).toBe(0)
  })

  test("overflow recovers quiet session cursors and ordered cursors without waiting for successor patches", async () => {
    const { stub, layer } = harness()
    // A transcript seeded from a read answered before the dropped frames.
    // Its intake orders by position, so the invalidation must name a
    // position past what it holds for it to read again.
    const transcriptRecoveries: unknown[] = []
    const transcript = createCursorIntake({ cursor: outputCursor("s0"), onApply: () => {}, onRecover: (request) => { transcriptRecoveries.push(request.invalidation) } })
    transcript.seed(1)
    // A receiver whose read already covers every dropped frame lost nothing.
    const current: unknown[] = []
    const covered = createCursorIntake({ cursor: outputCursor("s1"), onApply: () => {}, onRecover: (request) => { current.push(request.invalidation) } })
    covered.seed(1_000_000)
    const rows = Array.from({ length: 2200 }, (_, index) => readyCatalogRow(`s${index}`, `Session ${index}`))
    const loading = new Map<string, boolean>()
    const recovered = Promise.withResolvers<void>()
    let reads = 0
    const intake = createFamilyIntake({
      scopeKey: () => "catalog",
      connectedScope: () => "catalog",
      accept: (patch) => patch.cursor.domain === "session" ? { cursor: patch.cursor, scope: "catalog" } : null,
      loadSnapshot: async () => ({
        rows: ++reads === 1 ? rows.map((row) => catalogRow(row.id, row.title)) : rows,
        position: reads === 1 ? 1 : 5000,
      }),
      applySnapshot: (snapshot) => {
        for (const row of snapshot.rows) loading.set(row.id, row.totalsLoading)
        if (reads > 1) recovered.resolve()
        return { snapshotPosition: snapshot.position, clearHeld: true, cursors: snapshot.rows.map((row) => sessionCursor(row.id)) }
      },
      applyPayload: (patch) => {
        if (patch.payload.kind === "session.updated") loading.set(patch.payload.row.id, patch.payload.row.totalsLoading)
      },
    })
    try {
      await intake.resnapshot("catalog")
      await Effect.runPromise(Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
        const markers = new Map([[5001, Promise.withResolvers<void>()], [5002, Promise.withResolvers<void>()]])
        let invalidations = 0
        const fiber = yield* Stream.runForEach(client.RuntimeEvents(ATTACH), (input) => Effect.sync(() => {
          const event = decodeFrame(input)
          if (event.type === "runtime.heartbeat" || event.type === "runtime.connected") return
          if (event.type === "patch" && event.patch.payload.kind === "executor.changed") markers.get(event.patch.position)?.resolve()
          if (event.type === "patch" && event.patch.payload.kind === "runtime.invalidate") invalidations += 1
          intake.handle(event)
          if (event.type === "patch" && event.patch.cursor.domain === "runtime") {
            transcript.accept(event.patch)
            covered.accept(event.patch)
          }
        })).pipe(Effect.forkScoped)
        yield* awaitListener(stub)
        for (const [index, row] of rows.entries()) {
          stub.emit({ type: "patch", patch: { cursor: sessionCursor(row.id), position: index + 2, prevPosition: 0, payload: { kind: "session.updated", row } } })
        }
        // These ignored-domain markers prove the lane drained without a successor on any session cursor.
        for (const [position, drained] of markers) {
          stub.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "executor" }, position, prevPosition: 0, payload: { kind: "executor.changed", executor: { kind: "serving" } } } })
          yield* Effect.promise(() => drained.promise)
        }
        expect(invalidations).toBe(1)
        expect(reads).toBe(2)
        expect(transcriptRecoveries).toEqual(["overflow"])
        expect(current).toEqual([])
        yield* Effect.promise(() => recovered.promise)
        expect([...loading.values()].filter(Boolean)).toHaveLength(0)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.scoped, Effect.provide(layer)))
    } finally {
      intake.dispose()
    }
    expect(stub.listenerCount()).toBe(0)
  })

  test("the first frame says only that the runtime answers, and an unsupported event is logged with its session identity", async () => {
    const { layer, warnings } = harness()
    const logHome = makeDirectory("runtime-input-diagnostic-")
    await DebugLog.init({ dir: logHome })
    try {
      const frame = await Effect.runPromise(Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
        const reading = yield* Stream.runCollect(client.RuntimeEvents(ATTACH).pipe(Stream.take(1), Stream.map((event) => decodeFrame(event)))).pipe(Effect.forkScoped)
        const events = yield* Fiber.join(reading)
        yield* client.RuntimeClientDiagnostic({
          kind: "unsupported_patch",
          cursor: { scope: "session", domain: "future-changes", sessionId: "session-a" },
          payloadKind: "future.changed",
        })
        yield* client.RuntimeClientDiagnostic({
          kind: "input_responsiveness", clientInstanceId: "client-a", sessionId: "session-a",
          connection: "connected", screen: "sessions", paneInert: true, dragging: false,
          phase: "first", anomaly: "unmatched_tap", dispatchDelayed: 0, frameDelayed: 0, unmatchedTap: 1,
          recent: [{ event: "pointerup", input: "touch", control: "session", area: "sessions", atMs: 100, dispatchDelayMs: 0, defaultPrevented: false }],
        })
        yield* client.RuntimeClientDiagnostic({ kind: "background_read", reader: "workflow_view", errorKind: "RuntimeCallTimeout", phase: "failed", repeats: 0 })
        yield* client.RuntimeClientDiagnostic({ kind: "background_read", reader: "workflow_view", errorKind: "RuntimeCallTimeout", phase: "recovered", repeats: 3 })
        return events[0]
      }).pipe(Effect.scoped, Effect.provide(layer)))
      expect(frame).toEqual({ type: "runtime.connected" })
      expect(warnings).toEqual([{
        message: "runtime client skipped an unsupported event",
        fields: { scope: "session", domain: "future-changes", sessionId: "session-a", eventType: "patch", payloadKind: "future.changed" },
      }])
      await DebugLog.close()
      const records = [...scanDebugLogFiles(listDebugLogFiles(resolveDebugLogDirectory(logHome)), { sessionId: "session-a", types: ["runtime.client.input_responsiveness"] })]
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ sessionId: "session-a", type: "runtime.client.input_responsiveness", payload: { clientInstanceId: "client-a", unmatchedTap: 1 } })
      const readRecords = [...scanDebugLogFiles(listDebugLogFiles(resolveDebugLogDirectory(logHome)), { types: ["runtime.client.background_read"] })]
      expect(readRecords.map(record => record.payload)).toEqual([
        { reader: "workflow_view", errorKind: "RuntimeCallTimeout", phase: "failed", repeats: 0 },
        { reader: "workflow_view", errorKind: "RuntimeCallTimeout", phase: "recovered", repeats: 3 },
      ])
    } finally {
      await DebugLog.close()
    }
  })

  test("a draining client receives events in order", async () => {
    const { stub, layer, warnings } = harness()
    const received = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      const events: { type: string }[] = []
      const fiber = yield* Stream.runForEach(client.RuntimeEvents(ATTACH).pipe(Stream.map((event) => decodeFrame(event))), (event) => Effect.sync(() => { events.push(event) })).pipe(Effect.forkScoped)
      yield* awaitListener(stub)
      for (let i = 0; i < 3; i += 1) stub.emit(markerEvent(i))
      while (events.filter((event) => markerPosition(event) !== undefined).length < 3) yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      return events
    }).pipe(Effect.scoped, Effect.provide(layer)))

    // The first frame leads, heartbeats interleave, and patches stay ordered.
    expect(received[0]?.type).toBe("runtime.connected")
    expect(received.map(markerPosition).filter((position) => position !== undefined)).toEqual([0, 1, 2])
    expect(warnings).toEqual([])
    expect(stub.listenerCount()).toBe(0)
  })

  test("an idle lane still carries heartbeat frames for the client watchdog", async () => {
    const { stub, layer } = harness()
    const received = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      const events: { type: string }[] = []
      const fiber = yield* Stream.runForEach(client.RuntimeEvents(ATTACH).pipe(Stream.map((event) => decodeFrame(event))), (event) => Effect.sync(() => { events.push(event) })).pipe(Effect.forkScoped)
      yield* awaitListener(stub)
      while (events.length < 1) yield* Effect.yieldNow
      yield* Effect.yieldNow
      const heartbeats = () => events.filter((event) => event.type === "runtime.heartbeat").length
      const beforeInterval = heartbeats()
      yield* TestClock.adjust(RUNTIME_EVENT_HEARTBEAT_INTERVAL_MS)
      while (heartbeats() === beforeInterval) yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      return events
    }).pipe(Effect.scoped, Effect.provide(layer), Effect.provide(TestClock.layer())))

    // No patch moves the lane, so every frame after the first is a heartbeat,
    // and one more arrives each interval.
    expect(received[0]?.type).toBe("runtime.connected")
    expect(received.slice(1).map((event) => event.type)).toContain("runtime.heartbeat")
    expect(received.slice(1).every((event) => event.type === "runtime.heartbeat")).toBe(true)
  })

  test("a client that cannot drain a burst keeps its lane and receives the newest frames", async () => {
    const { stub, layer, warnings, infos } = harness()
    const outcome = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      const received: number[] = []
      const recoveredAfter: number[] = []
      const fiber = yield* Stream.runForEach(client.RuntimeEvents(ATTACH).pipe(Stream.map((event) => decodeFrame(event))), (event) => Effect.sync(() => {
        const position = markerPosition(event)
        if (position !== undefined) received.push(position)
        if (event.type === "patch" && event.patch.payload.kind === "runtime.invalidate") recoveredAfter.push(received.at(-1) ?? -1)
      })).pipe(Effect.forkScoped)
      yield* awaitListener(stub)
      // The synchronous flood models a client that cannot drain during the
      // burst (no fiber runs between emits): the bound fills and the oldest
      // frames go, so what the consumer drains afterwards is the newest
      // window, ending on the last frame emitted.
      for (const offset of [0, 4000]) {
        for (let i = 0; i < 2_200; i += 1) stub.emit(markerEvent(offset + i))
        while (received.at(-1) !== offset + 2_199) yield* Effect.yieldNow
      }
      // The lane is still open: a frame emitted after the burst arrives too,
      // which a failed stream could not deliver.
      stub.emit(markerEvent(9_000))
      while (received.at(-1) !== 9_000) yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      return { received, recoveredAfter }
    }).pipe(Effect.scoped, Effect.provide(layer)))

    expect(outcome.received.length).toBeLessThanOrEqual(2 * 2_048 + 1)
    expect(outcome.received.at(-2)).toBe(6_199)
    expect(outcome.received.at(-1)).toBe(9_000)
    expect(outcome.recoveredAfter).toEqual([2199, 6199])
    expect(warnings).toEqual([1000, 1500].map((threshold) => ({
      message: "runtime event queue heavy load",
      fields: {
        streamId: expect.any(String),
        threshold,
        queuedFrames: threshold,
        highWaterMark: threshold,
        capacity: 2048,
        remainingCapacity: 2048 - threshold,
        elapsedMs: expect.any(Number),
      },
    })))
    expect(infos).toContainEqual({
      message: "runtime event stream unsubscribed",
      fields: expect.objectContaining({ streamId: expect.any(String), highWaterMark: 2048, capacity: 2048, remainingCapacity: 0 }),
    })
    // Ordered within what survived: the drop takes the oldest, never reorders.
    expect(outcome.received).toEqual([...outcome.received].sort((a, b) => a - b))
  })
})

describe("RuntimeEvents subscription gate", () => {
  /** A runtime whose identity check the test releases by hand, so a
   *  subscription stays unregistered while calls arrive behind it. A query
   *  answers, as its position, how many subscriptions were registered when
   *  it was served. */
  function gated() {
    const own = Promise.withResolvers<string | undefined>()
    const { stub, layer } = harness({ clientIdentity: () => own.promise })
    stub.service.query = runtimeQuery({ commandUsageSnapshot: async () => ({ usage: { uses: [] }, snapshotPosition: stub.listenerCount() }) })
    return { stub, layer, release: (clientIdentity: string | undefined) => own.resolve(clientIdentity) }
  }

  const usage = { type: "commandUsageSnapshot" } as const
  const registeredWhenServed = (result: unknown) => typeof result === "object" && result !== null && "snapshotPosition" in result ? result.snapshotPosition : undefined

  test("a read written after the subscription is served only once the subscription is registered", async () => {
    const { layer, release } = gated()
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      yield* Stream.runDrain(client.RuntimeEvents({ ...ATTACH, clientIdentity: identity })).pipe(Effect.forkScoped({ startImmediately: true }))
      const read = yield* client.RuntimeQuery(usage).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Effect.yieldNow
      release(identity)
      return registeredWhenServed(yield* Fiber.join(read))
    }).pipe(Effect.scoped, Effect.provide(layer)))
    expect(seen).toBe(1)
  })

  test("a subscription that is refused fails the calls written after it with its own failure", async () => {
    const { layer, release } = gated()
    const outcome = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      yield* Stream.runDrain(client.RuntimeEvents({ ...ATTACH, clientIdentity: otherIdentity })).pipe(Effect.ignore, Effect.forkScoped({ startImmediately: true }))
      const read = yield* client.RuntimeQuery(usage).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Effect.yieldNow
      release(identity)
      return yield* Fiber.join(read).pipe(Effect.map(() => "served"), Effect.catchTag("RuntimeProtocolError", (error) => Effect.succeed(error.kind)))
    }).pipe(Effect.scoped, Effect.provide(layer)))
    expect(outcome).toBe("client-mismatch")
  })

  test("a connection with no subscription is served at once", async () => {
    const { layer } = gated()
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      return registeredWhenServed(yield* client.RuntimeQuery(usage))
    }).pipe(Effect.scoped, Effect.provide(layer)))
    expect(seen).toBe(0)
  })

  test("a second subscription on one connection holds only the calls written after it", async () => {
    const { layer, release } = gated()
    const seen = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      // The first subscription states no identity and registers at once.
      yield* Stream.runDrain(client.RuntimeEvents(ATTACH)).pipe(Effect.forkScoped({ startImmediately: true }))
      const before = yield* client.RuntimeQuery(usage)
      yield* Stream.runDrain(client.RuntimeEvents({ ...ATTACH, clientIdentity: identity })).pipe(Effect.forkScoped({ startImmediately: true }))
      const after = yield* client.RuntimeQuery(usage).pipe(Effect.forkScoped({ startImmediately: true }))
      yield* Effect.yieldNow
      release(identity)
      return [registeredWhenServed(before), registeredWhenServed(yield* Fiber.join(after))]
    }).pipe(Effect.scoped, Effect.provide(layer)))
    expect(seen).toEqual([1, 2])
  })
})
