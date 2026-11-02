import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Schema, Stream } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import type { FrontendEvent } from "../src/protocol/app-service-types.js"
import type { FlywheelAppService } from "../src/orchestration/app-service/app-service.js"
import { runtimeHandlers } from "../src/orchestration/app-service/runtime-protocol-handlers.js"
import { RuntimeEventFrameSchema, RuntimeProtocolRpc } from "../src/protocol/runtime-protocol-schemas.js"
import { createFamilyIntake } from "../src/protocol/client/family-intake.js"
import { sessionCursor } from "../src/protocol/runtime-ui-protocol-types.js"
import { catalogRow, readyCatalogRow } from "../tests/helpers/session-catalog.js"

/** A burst much larger than any reasonable per-connection bound, so the lane
 *  overflows whatever bound the runtime keeps. */
const BURST = 12_000

function stubService() {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const unused = () => Promise.reject(new Error("not under test"))
  const service: Pick<FlywheelAppService, "query" | "dispatch" | "subscribe"> = {
    query: unused,
    dispatch: unused,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return {
    service,
    listenerCount: () => listeners.size,
    emit: (event: FrontendEvent) => { for (const listener of listeners) listener(event) },
  }
}

function connectedEvent(snapshotPosition = 1): FrontendEvent {
  return { type: "runtime.connected", snapshotPosition }
}

function harness() {
  const stub = stubService()
  const log = { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} }
  const layer = runtimeHandlers(stub.service, log, {})
  return { stub, layer }
}

const decodeFrame = Schema.decodeUnknownSync(RuntimeEventFrameSchema)

const awaitListener = (stub: ReturnType<typeof stubService>) =>
  Effect.gen(function*() {
    while (stub.listenerCount() === 0) yield* Effect.yieldNow
  })

const isInvalidation = (event: ReturnType<typeof decodeFrame>): boolean =>
  event.type === "patch" && event.patch.payload.kind === "runtime.invalidate"

describe("a client that falls behind the runtime event lane", () => {
  test("session rows whose last update was dropped are hydrated again without a reconnect or a later update", async () => {
    const { stub, layer } = harness()
    const rows = Array.from({ length: BURST }, (_, index) => readyCatalogRow(`s${index}`, `Session ${index}`))
    const loading = new Map<string, boolean>()
    const recovered = Promise.withResolvers<void>()
    let reads = 0
    const intake = createFamilyIntake({
      scopeKey: () => "catalog",
      connectedScope: () => "catalog",
      accept: (patch) => patch.cursor.domain === "session" ? { cursor: patch.cursor, scope: "catalog" } : null,
      loadSnapshot: async () => ({
        rows: ++reads === 1 ? rows.map((row) => catalogRow(row.id, row.title)) : rows,
        position: reads === 1 ? 1 : 50_000,
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
      expect([...loading.values()].filter(Boolean)).toHaveLength(BURST)
      await Effect.runPromise(Effect.gen(function*() {
        const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
        const markers = new Map([[50_001, Promise.withResolvers<void>()], [50_002, Promise.withResolvers<void>()]])
        let invalidations = 0
        const fiber = yield* Stream.runForEach(client.RuntimeEvents({}), (input) => Effect.sync(() => {
          const event = decodeFrame(input)
          if (event.type === "runtime.heartbeat") return
          if (event.type === "patch" && event.patch.payload.kind === "executor.changed") markers.get(event.patch.position)?.resolve()
          if (isInvalidation(event)) invalidations += 1
          intake.handle(event)
        })).pipe(Effect.forkScoped)
        yield* awaitListener(stub)
        // Every session publishes its hydrated row once, with no later update.
        for (const [index, row] of rows.entries()) {
          stub.emit({ type: "patch", patch: { cursor: sessionCursor(row.id), position: index + 2, prevPosition: 0, payload: { kind: "session.updated", row } } })
        }
        // These markers on another domain prove the lane drained with no
        // successor patch on any session cursor.
        for (const [position, drained] of markers) {
          stub.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "executor" }, position, prevPosition: 0, payload: { kind: "executor.changed", executor: { kind: "serving" } } } })
          yield* Effect.promise(() => drained.promise)
        }
        expect(invalidations).toBeGreaterThanOrEqual(1)
        yield* Effect.promise(() => recovered.promise)
        expect(reads).toBeGreaterThanOrEqual(2)
        expect([...loading.values()].filter(Boolean)).toHaveLength(0)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.scoped, Effect.provide(layer)))
    } finally {
      intake.dispose()
    }
    expect(stub.listenerCount()).toBe(0)
  }, 30_000)

  test("each separate overflow is followed by its own recovery signal, and the lane stays open and ordered", async () => {
    const { stub, layer } = harness()
    const outcome = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      const received: number[] = []
      const invalidationsAt: number[] = []
      const fiber = yield* Stream.runForEach(client.RuntimeEvents({}).pipe(Stream.map((event) => decodeFrame(event))), (event) => Effect.sync(() => {
        if (event.type === "runtime.connected") received.push(event.snapshotPosition)
        if (isInvalidation(event)) invalidationsAt.push(received.at(-1) ?? -1)
      })).pipe(Effect.forkScoped)
      yield* awaitListener(stub)
      const afterBurst: number[] = []
      for (const offset of [0, 100_000]) {
        // The synchronous flood models a client that cannot drain during the burst.
        for (let i = 0; i < BURST; i += 1) stub.emit(connectedEvent(offset + i))
        while (received.at(-1) !== offset + BURST - 1) yield* Effect.yieldNow
        // A quiet frame after the burst proves everything queued before it has been delivered.
        stub.emit(connectedEvent(offset + 90_000))
        while (received.at(-1) !== offset + 90_000) yield* Effect.yieldNow
        afterBurst.push(invalidationsAt.length)
      }
      stub.emit(connectedEvent(900_000))
      while (received.at(-1) !== 900_000) yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      return { received, afterBurst }
    }).pipe(Effect.scoped, Effect.provide(layer)))

    // Each burst overflowed and was followed by a recovery signal of its own.
    expect(outcome.afterBurst[0]).toBeGreaterThanOrEqual(1)
    expect(outcome.afterBurst[1]).toBeGreaterThan(outcome.afterBurst[0] ?? 0)
    // The lane stayed open and bounded: the oldest frames were dropped, never reordered.
    expect(outcome.received.length).toBeLessThan(2 * BURST)
    expect(outcome.received.at(-1)).toBe(900_000)
    expect(outcome.received).toEqual([...outcome.received].sort((a, b) => a - b))
    expect(stub.listenerCount()).toBe(0)
  }, 30_000)

  test("a client that keeps up receives no recovery signal", async () => {
    const { stub, layer } = harness()
    const received = await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      const events: ReturnType<typeof decodeFrame>[] = []
      const fiber = yield* Stream.runForEach(client.RuntimeEvents({}).pipe(Stream.map((event) => decodeFrame(event))), (event) => Effect.sync(() => { events.push(event) })).pipe(Effect.forkScoped)
      yield* awaitListener(stub)
      for (let i = 0; i < 200; i += 1) stub.emit(connectedEvent(i))
      while (events.filter((event) => event.type === "runtime.connected").length < 200) yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      return events
    }).pipe(Effect.scoped, Effect.provide(layer)))
    expect(received.filter((event) => event.type === "runtime.connected").map((event) => event.type === "runtime.connected" ? event.snapshotPosition : -1))
      .toEqual(Array.from({ length: 200 }, (_, index) => index))
    expect(received.some(isInvalidation)).toBe(false)
    expect(stub.listenerCount()).toBe(0)
  })
})
