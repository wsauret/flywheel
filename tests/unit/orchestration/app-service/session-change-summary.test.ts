import { expect, mock, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Schema } from "effect"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { RpcTest } from "effect/rpc"
import { RuntimeBackgroundRpc, RuntimeProtocolRpc, RuntimeUiPatchSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { changesCursor, type SessionFileChangeCounts } from "../../../../src/protocol/session-changes-protocol-types.js"
import { runtimeDeliveryPolicy } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { runtimeCallPolicies } from "../../../../src/protocol/runtime-client-deadlines.js"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { runtimeHandlers } from "../../../../src/orchestration/app-service/runtime-protocol-handlers.js"
import { createOutputWatches } from "../../../../src/orchestration/app-service/output-watches.js"
import { readSessionChangeSummary } from "../../../../src/orchestration/app-service/runtime-background-worker.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createRuntimeBackgroundLane } from "../../../../src/orchestration/app-service/runtime-background-lane.js"
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"
import { withStore } from "../session/file-mutation-recovery-fixture.js"
import { mutation } from "../session/_session-change-fixtures.js"

test("the runtime query RPC accepts a session-only change summary", () => {
  const rpc = RuntimeProtocolRpc.requests.get("RuntimeQuery")!
  const query = { type: "sessionChangeSummary" as const, sessionId: "s" }
  expect(Schema.decodeUnknownSync(rpc.payloadSchema)(query)).toEqual(query)
  const result = { fileCount: 4, unknownFileMutationGaps: 1, snapshotPosition: 9 }
  expect(Schema.decodeUnknownSync(rpc.successSchema)(result)).toEqual(result)
  const background = RuntimeBackgroundRpc.requests.get("RuntimeBackgroundSessionChangeSummary")!
  expect(Schema.decodeUnknownSync(background.payloadSchema)({ projectRoot: "/workspace", sessionId: "s" })).toEqual({ projectRoot: "/workspace", sessionId: "s" })
  expect(Schema.decodeUnknownSync(background.successSchema)(result)).toEqual({ fileCount: 4, unknownFileMutationGaps: 1 })
  const patch = { cursor: changesCursor("s"), payload: { kind: "changes.changed" as const }, position: 9, prevPosition: 0 }
  expect(Schema.decodeUnknownSync(RuntimeUiPatchSchema)(patch)).toEqual(patch)
  expect(runtimeDeliveryPolicy("changes")).toBe("durable-resnapshot")
  expect(runtimeCallPolicies.sessionChangeSummary).toBe(runtimeCallPolicies.outputRange)
  expect(runtimeCallPolicies.dispatch._tag).toBe("Lossless")
})

function serviceWithSummary(read: (sessionId: string) => Promise<SessionFileChangeCounts>) {
  const store = fakeSessionStore(new Map())
  const manager = fakeManager()
  const bus = createRuntimeUiBus()
  const doubles = fakeProjections()
  const review = mock(doubles.sessionChanges)
  const service = createFlywheelAppService({
    ...doubles, sessionChanges: review,
    projectRoot: "/workspace",
    projection: createFrontendProjection({ projectRoot: "/workspace", sessionStore: store, manager }),
    runtimeSupervisor: runtimeSupervisor(), bus,
    backgroundLane: { ...doubles.backgroundLane, sessionChangeSummary: read },
  })
  return { service, bus, review }
}

test("construction, catalog, and subscription never acquire a summary or review", async () => {
  const read = mock(async () => ({ fileCount: 1, unknownFileMutationGaps: 0 }))
  const { service, bus, review } = serviceWithSummary(read)
  const unsubscribe = service.subscribe(() => {})
  await service.query({ type: "snapshot" })
  expect(read).not.toHaveBeenCalled()
  expect(review).not.toHaveBeenCalled()
  unsubscribe()
  await bus.clear()
})

test("a delayed background summary returns the Changes anchor from before await", async () => {
  const pending = Promise.withResolvers<SessionFileChangeCounts>()
  const read = mock(() => pending.promise)
  const { service, bus, review } = serviceWithSummary(read)
  const first = bus.publish({ cursor: changesCursor("s"), payload: { kind: "changes.changed" } })
  const result = service.query({ type: "sessionChangeSummary", sessionId: "s" })
  expect(read).toHaveBeenCalledWith("s")
  const later = bus.publish({ cursor: changesCursor("s"), payload: { kind: "changes.changed" } })
  pending.resolve({ fileCount: 1, unknownFileMutationGaps: 0 })
  expect(await result).toEqual({ fileCount: 1, unknownFileMutationGaps: 0, snapshotPosition: first.position })
  expect(later.position).toBeGreaterThan(first.position)
  expect(review).not.toHaveBeenCalled()
  await bus.clear()
})

test("background failure propagates without foreground review acquisition", async () => {
  const { service, bus, review } = serviceWithSummary(async () => { throw new Error("Worker failed") })
  await expect(service.query({ type: "sessionChangeSummary", sessionId: "s" })).rejects.toThrow("Worker failed")
  expect(review).not.toHaveBeenCalled()
  await bus.clear()
})

test("the registered runtime RPC calls the app-service summary boundary", async () => {
  const read = mock(async () => ({ fileCount: 3, unknownFileMutationGaps: 1 }))
  const { service, bus } = serviceWithSummary(read)
  const value = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
    return yield* client.RuntimeQuery({ type: "sessionChangeSummary", sessionId: "s" })
  })).pipe(Effect.provide(runtimeHandlers({ client: { ...service, disconnect: () => {} }, outputWatches: createOutputWatches({ onUnionChange: () => {} }) }, { debug() {}, info() {}, error() {}, warn() {} }, { version: "0.1.0" }))))
  expect(value).toEqual({ fileCount: 3, unknownFileMutationGaps: 1, snapshotPosition: 0 })
  expect(read).toHaveBeenCalledWith("s")
  await bus.clear()
})

test("the Worker summary requires real durable metadata and counts a durable New Chat", async () => {
  await withStore(async ({ store, root }) => {
    const manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
    await manager.createChat({ id: "s", name: "New Chat", initialState: "active" })
    expect(await readSessionChangeSummary(asAsyncEventReadSurface(store), "s", root)).toEqual({ fileCount: 0, unknownFileMutationGaps: 0 })
    const path = join(root, "a")
    const written = mutation(1, "request")
    written.payload.path = path
    written.payload.after = { bytes: 1, sha256: createHash("sha256").update("a").digest("hex"), preview: "a" }
    writeFileSync(path, "a")
    store.append(written)
    const reads = spyOn(store, "readTolerant")
    expect(await readSessionChangeSummary(asAsyncEventReadSurface(store), "s", root)).toEqual({ fileCount: 1, unknownFileMutationGaps: 0 })
    writeFileSync(path, "b")
    expect(await readSessionChangeSummary(asAsyncEventReadSurface(store), "s", root)).toEqual({ fileCount: 0, unknownFileMutationGaps: 0 })
    expect(reads.mock.calls.every(([query]) => query?.types?.every(type => type.startsWith("session.") || type === "file.changed"))).toBe(true)
    reads.mockClear()
    await expect(readSessionChangeSummary(asAsyncEventReadSurface(store), "missing", root)).rejects.toThrow("Session is unavailable")
    expect(reads.mock.calls.some(([query]) => query?.types?.includes("file.changed"))).toBe(false)
    reads.mockRestore()
    for (let index = 2; index <= 513; index++) {
      const changed = mutation(index, "many")
      changed.payload.path = join(root, `file-${index}`)
      changed.payload.after = written.payload.after
      writeFileSync(String(changed.payload.path), "a")
      store.append(changed)
    }
    const pages = spyOn(store, "readTolerant")
    const content = mock(async () => { throw new Error("Summary must not read patch content") })
    const reader = { ...asAsyncEventReadSurface(store), readSessionContentNode: content, readSessionContentRange: content }
    expect(await readSessionChangeSummary(reader, "s", root)).toEqual({ fileCount: 512, unknownFileMutationGaps: 0 })
    const fileReads = pages.mock.calls.filter(([query]) => query?.types?.includes("file.changed"))
    expect(fileReads).toHaveLength(3)
    expect(fileReads.every(([query]) => query?.limit !== undefined && query.limit <= 257)).toBe(true)
    expect(content).not.toHaveBeenCalled()
    pages.mockClear()
    expect(await readSessionChangeSummary(reader, "s", root)).toEqual({ fileCount: 512, unknownFileMutationGaps: 0 })
    expect(pages.mock.calls.some(([query]) => query?.types?.includes("file.changed"))).toBe(false)
    expect(content).not.toHaveBeenCalled()
    pages.mockRestore()
  })
})

test("the summary shares the lane's lazy owned client and contains no position", async () => {
  const doubles = fakeProjections()
  const read = mock(async () => ({ fileCount: 2, unknownFileMutationGaps: 0 }))
  const client = { ...doubles.backgroundLane, warm: async () => {}, close: async () => {}, sessionChangeSummary: read }
  const createClient = mock(() => client)
  const lane = createRuntimeBackgroundLane("/workspace", { createClient })
  expect(createClient).not.toHaveBeenCalled()
  expect(await lane.sessionChangeSummary("s")).toEqual({ fileCount: 2, unknownFileMutationGaps: 0 })
  expect(await lane.sessionChangeSummary("s")).toEqual({ fileCount: 2, unknownFileMutationGaps: 0 })
  expect(createClient).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledTimes(2)
  await lane.dispose()
})
