import { describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventReaderService, EventStoreService, EventStoreWriterLaneService, EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import type { EventStoreAppend, StoredFact } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createRuntimeEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createProjectExecutionState } from "../../../../src/orchestration/app-service/project-execution-state.js"
import { createProjectStateClient, ProjectStateRefusedError } from "../../../../src/orchestration/app-service/project-state-client.js"
import { decodeProjectStateRequest, decodeProjectStateStored, encodeProjectStateResponseFrame, encodeProjectStateStored, operationUnits, type ProjectStateResponseFrame } from "../../../../src/orchestration/app-service/project-state-protocol.js"
import { createProjectStateSessionsService } from "../../../../src/orchestration/app-service/project-state-sessions.js"
import { createProjectStateService } from "../../../../src/orchestration/app-service/project-state-worker.js"
import { createSessionManager, type SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { prepareFileMutationOperation } from "../../../../src/orchestration/session/file-mutation-fact-writers.js"
import { readPatchContent } from "../../../../src/orchestration/session/session-change-sources.js"

function fact(payload: { [key: string]: unknown } = {}): EventStoreAppend {
  return { aggregateId: "session:s", sessionId: "s", type: "test.fact", version: 1, timestamp: 1, actor: "test", payload }
}

function fixture() {
  const projectRoot = mkdtempSync(join(tmpdir(), "execution-state-"))
  const store = createRuntimeEventStore(resolveEventStoreDbFile(projectRoot))
  const ready = Promise.withResolvers<void>()
  let receive: ((frame: ProjectStateResponseFrame) => boolean) | undefined
  let receiveStored: ((events: readonly StoredFact[]) => void) | undefined
  let receiveChange: ((change: SessionMetadataChange) => void) | undefined
  let refuse = false
  const sessions = createProjectStateSessionsService(createSessionManager({ projectRoot, executionCwd: projectRoot, store, writer: store }))
  const service = createProjectStateService({
    reader: store,
    recover: async () => { throw new Error("unexpected recovery") },
    owedRecoveries: () => [],
    settleRecovery: async () => {},
    appendWriteItem: store.writerLane.appendWriteItem,
    pruneSupersededEvents: store.pruneSupersededEvents,
    pruneSupersededKeyedEvents: (aggregate, type, key) => store.pruneSupersededKeyedEvents!(aggregate, type, key),
    pruneRetiredFamilyChunk: () => { throw new Error("unexpected retired-family prune") },
    dropRetiredIndexes: () => { throw new Error("unexpected retired-index drop") },
    retireFinalizedCheckpointPage: () => { throw new Error("unexpected checkpoint maintenance") },
    sessions,
    notifySessionChange: (change) => receiveChange?.(change),
    onStored: store.onStored,
    notifyStored(events) {
      const notification = decodeProjectStateStored(structuredClone(encodeProjectStateStored(events)))
      if (!notification) throw new Error("invalid stored notification")
      receiveStored?.(notification.events)
    },
    close: () => store.close(),
  })
  const client = createProjectStateClient({
    send(request, encoded) {
      const decoded = decodeProjectStateRequest(structuredClone(encoded), request.lane)
      if (!decoded) throw new Error("invalid request")
      void ready.promise.then(async () => {
        const served = refuse ? { result: { kind: "refused" as const, reason: "pressure" as const } } : await service.enqueue(decoded.lane, decoded.operation, { bytes: encoded.byteLength, units: operationUnits(decoded.operation) })
        if (receive?.(encodeProjectStateResponseFrame({ id: decoded.id, ...served })) === false) throw new Error("invalid response")
      })
    },
    onResponse(listener) { receive = listener },
    onClose() {},
    onStored(listener) { receiveStored = listener; return () => { receiveStored = undefined } },
    onSessionChange(listener) { receiveChange = listener; return () => { receiveChange = undefined } },
    close: () => service.close(),
  })
  return {
    projectRoot, store, client, ready,
    refuse(value: boolean) { refuse = value },
    async close() {
      ready.resolve()
      try { await client.close() } finally { rmSync(projectRoot, { recursive: true, force: true }) }
    },
  }
}

describe("project execution state", () => {
  test("prepares retained publication evidence through the default execution writer", async () => {
    const f = fixture()
    let execution: Awaited<ReturnType<typeof createProjectExecutionState>> | undefined
    try {
      f.ready.resolve()
      execution = await createProjectExecutionState(f.client)
      const writer = createSessionFactWriter({ sessionId: "s", writer: execution.eventWriter })
      const [prepared] = await prepareFileMutationOperation({
        sessionEventWriter: writer,
        origin: { kind: "tool_call", toolUseId: "edit" },
      }, [{
        change: { path: join(f.projectRoot, "created"), displayPath: "created", changeKind: "created", beforeContent: null, afterContent: "new\n" },
        evidence: { beforeSnapshot: null },
      }])
      const patch = prepared?.evidence?.patch
      if (patch?.kind !== "retained") throw new Error("Publication evidence was not retained")
      const text = await readPatchContent(execution.eventStore, "s", patch.reference)
      expect(text).toContain("+new")
      expect(await execution.eventStore.readSessionContentNode?.("s", patch.reference.root)).toBeTruthy()
    } finally {
      await execution?.eventStoreRuntime.dispose()
      await f.close()
    }
  })

  test("acquires remote history after readiness without opening SQLite and commits through the state owner", async () => {
    const f = fixture()
    let execution: Awaited<ReturnType<typeof createProjectExecutionState>> | undefined
    let connection: WeakRef<Database> | undefined
    const exec = Database.prototype.exec
    const probe = spyOn(Database.prototype, "exec").mockImplementation(function(this: Database, sql: string) {
      if (sql === "PRAGMA busy_timeout = 5000") connection = new WeakRef(this)
      return exec.call(this, sql)
    })
    try {
      const acquiring = createProjectExecutionState(f.client)
      await Promise.resolve()
      expect(connection).toBeUndefined()
      f.ready.resolve()
      execution = await acquiring
      probe.mockRestore()
      expect(connection).toBeUndefined()
      const { eventStore: store, eventStoreRuntime: runtime } = execution
      expect("commitItems" in store).toBe(false)
      expect("transaction" in store).toBe(false)
      expect(execution.sessionManager).toBe(f.client.sessions)
      // Reads go through the state client itself; the execution store serves writes.
      expect(execution.eventReader).toBe(f.client)
      expect(await runtime.runPromise(EventReaderService)).toBe(f.client)
      expect(await runtime.runPromise(EventStoreService)).toBe(store)
      expect(await runtime.runPromise(EventStoreWriterService)).toBe(store)
      expect(await runtime.runPromise(EventStoreWriterLaneService)).toBe(store.writerLane)

      const observed: StoredFact[] = []
      let stoppedCalls = 0
      const stop = store.onStored(() => { stoppedCalls += 1 })
      stop()
      store.onStored((events) => observed.push(...events))
      await store.putInFlight!("s", "tool", "k", { running: true })
      expect(observed).toHaveLength(0)
      expect(await store.readInFlight("s", "tool")).toHaveLength(1)
      const terminalResult = await store.appendGuarded({ ...fact(), expectedSeq: 0, inFlight: [{ op: "drop", kind: "tool", key: "k" }] })
      if (terminalResult.kind !== "stored" || !terminalResult.events[0]) throw new Error("terminal append did not store")
      const terminal = terminalResult.events[0]
      expect(await store.readInFlight("s", "tool")).toHaveLength(0)
      expect(observed.map((event) => event.id)).toEqual([terminal.id])
      await expect(store.appendGuarded({ ...fact(), expectedSeq: 0, inFlight: [{ op: "put", kind: "tool", key: "rolled-back", payload: {} }] })).resolves.toMatchObject({ kind: "conflict" })
      expect(await store.readInFlight("s", "tool")).toHaveLength(0)
      expect(observed).toHaveLength(1)
      await expect(store.appendBatchGuarded([
        { ...fact(), expectedSeq: 1 },
        { ...fact(), expectedSeq: 1 },
      ])).resolves.toMatchObject({ kind: "conflict" })
      expect(observed).toHaveLength(1)
      expect(await store.aggregateSeq("session:s")).toBe(0)

      await store.putInFlight!("s", "tool", "a", { value: 1 })
      await store.putInFlight!("s", "tool", "b", { value: 1 })
      expect(await store.swapInFlightBatch!("s", [
        { op: "swap", kind: "tool", key: "a", expectedRaw: '{"value":1}', payload: { value: 2 } },
        { op: "swap", kind: "tool", key: "b", expectedRaw: "wrong", payload: null },
      ])).toBe(false)
      expect((await store.readInFlight("s", "tool")).map((cell) => cell.raw)).toEqual(['{"value":1}', '{"value":1}'])
      expect(await store.swapInFlight!("s", "tool", "a", '{"value":1}', { value: 2 })).toBe(true)
      await store.dropInFlight!("s", "tool", "b")
      f.refuse(true)
      await expect(store.swapInFlight!("s", "tool", "a", '{"value":2}', null)).rejects.toBeInstanceOf(ProjectStateRefusedError)
      f.refuse(false)

      await execution.sessionManager.createChat({ id: "chat", initialState: "inactive" })
      const other = await f.client.writer.append(fact({ other: true }))
      expect(observed.at(-1)?.id).toBe(other.id)
      expect(observed.some((event) => event.aggregateId === "session:chat")).toBe(true)
      const slice = await store.readSlice({})
      expect(slice.facts).toEqual(f.store.read())
      expect(slice.facts).toEqual(observed)
      expect(new Set(observed.map((event) => event.id)).size).toBe(observed.length)
      expect(stoppedCalls).toBe(0)
      expect(await store.pruneSupersededEvents("session:s", "queue.state.changed")).toBe(0)
      expect(await store.pruneSupersededKeyedEvents!("session:s", "step.resume_revert.recorded", "$.attemptId")).toBe(0)

      const pending = store.append(fact({ draining: true }))
      await runtime.dispose()
      const final = await pending
      expect(observed.at(-1)?.id).toBe(final.id)
      const count = observed.length
      await f.client.writer.append(fact({ survives: true }))
      expect(f.client.available).toBe(true)
      expect(observed).toHaveLength(count)
      expect(await store.capturePosition()).toBe(await f.client.capturePosition())
      await runtime.dispose()
    } finally {
      probe.mockRestore()
      await execution?.eventStoreRuntime.dispose()
      await f.close()
    }
  })

  test("a later transport refusal never retries an already committed atomic item", async () => {
    const f = fixture()
    f.ready.resolve()
    const execution = await createProjectExecutionState(f.client)
    try {
      const stop = execution.eventStore.onStored(() => f.refuse(true))
      const first = execution.eventStore.append(fact({ first: true }))
      const second = execution.eventStore.append(fact({ second: true }))
      const outcomes = await Promise.allSettled([first, second])
      expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: { seq: 0 } })
      expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { reason: "pressure" } })
      stop()
      f.refuse(false)
      expect(f.store.read()).toHaveLength(1)
      expect(f.store.read()[0]?.payload).toEqual({ first: true })
    } finally {
      await execution.eventStoreRuntime.dispose()
      await f.close()
    }
  })
})
