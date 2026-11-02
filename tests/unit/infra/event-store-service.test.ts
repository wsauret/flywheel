import { createHash } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import { ManagedRuntime } from "effect"
import type { EventPayload, EventStoreAppend, EventStoreItemSettlement } from "../../../src/infra/event-store-types.js"
import { EventReaderService, EventStoreLive, EventStoreService, EventStoreWriterLaneService } from "../../../src/infra/event-store-effect.js"
import { createRuntimeEventStore, createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { createEventStoreWriterLane } from "../../../src/infra/event-store-writer-lane.js"
import type { EventStoreBatchWriter } from "../../../src/infra/event-store-writer-lane-types.js"
import type { ToolContentRow } from "../../../src/infra/tool-content.js"

const tempDirs: string[] = []

function tempDbPath(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return join(dir, "flywheel.sqlite")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

interface CyclicPayload extends EventPayload {
  readonly text: string
  self?: CyclicPayload
}

function appendFor(sessionId: string, text: string): EventStoreAppend {
  return {
    aggregateId: `session:${sessionId}`,
    type: "fact.recorded",
    version: 1,
    timestamp: 123,
    actor: "test",
    sessionId,
    payload: { text },
  }
}

function contentRowFor(text: string): ToolContentRow {
  return {
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    content: text,
    bytes: Buffer.byteLength(text),
  }
}

function stalledWriter(): EventStoreBatchWriter {
  return {
    commitItems() {
      throw new Error("unexpected commitItems")
    },
  }
}

function gatedWriter(store: EventStoreBatchWriter) {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const writer: EventStoreBatchWriter = {
    commitItems: async (items) => {
      await gate
      return store.commitItems(items)
    },
  }
  return { writer, release }
}
describe("EventStore services", () => {
  it("keeps blocking schema acquisition and scopes zero busy timeout to runtime lane commits", async () => {
    const exec = spyOn(Database.prototype, "exec")
    const store = createRuntimeEventStore(tempDbPath("fw-runtime-lock-posture-"))
    try {
      const opening = exec.mock.calls.map(([sql]) => sql)
      expect(opening[0]).toBe("PRAGMA busy_timeout = 5000")
      expect(opening).toContain("PRAGMA journal_mode = WAL")
      expect(opening.some((sql) => sql.includes("create table if not exists event_sequence"))).toBe(true)
      expect(opening).not.toContain("PRAGMA busy_timeout = 0")
      const db = exec.mock.contexts[0]
      if (!(db instanceof Database)) throw new Error("expected the runtime connection")
      const notifications: unknown[] = []
      store.onStored((events) => {
        notifications.push({
          timeout: db.query("PRAGMA busy_timeout").get(),
          events,
          read: store.read({ aggregateId: "session:s1" }),
        })
      })
      const stored = await store.append(appendFor("s1", "runtime"))
      expect(notifications).toEqual([{
        timeout: { timeout: 5000 },
        events: [stored],
        read: [stored],
      }])
      expect(exec.mock.calls.slice(opening.length).map(([sql]) => sql)).toEqual([
        "PRAGMA busy_timeout = 0",
        "PRAGMA busy_timeout = 5000",
      ])
    } finally {
      await store.close()
      exec.mockRestore()
    }

    const offlineExec = spyOn(Database.prototype, "exec")
    const offline = createSqliteEventStore(tempDbPath("fw-offline-lock-posture-"))
    try {
      offline.commitItems([{ sessionId: "s1", events: [appendFor("s1", "offline")] }])
      expect(offlineExec.mock.calls[0]?.[0]).toBe("PRAGMA busy_timeout = 5000")
      expect(offlineExec.mock.calls.map(([sql]) => sql)).not.toContain("PRAGMA busy_timeout = 0")
    } finally {
      offline.close()
      offlineExec.mockRestore()
    }
  })

  it("keeps the event loop live under a real write lock and commits after its release", async () => {
    const dbPath = tempDbPath("fw-runtime-lock-")
    const exec = spyOn(Database.prototype, "exec")
    const store = createRuntimeEventStore(dbPath)
    const db = exec.mock.contexts[0]
    exec.mockRestore()
    if (!(db instanceof Database)) throw new Error("expected the runtime connection")
    const blocker = new Database(dbPath)
    blocker.exec("BEGIN IMMEDIATE")
    let locked = true
    let timerElapsed = 0
    let pendingAtRelease = false
    let timeoutAfterRefusal: unknown
    let notifications = 0
    let notificationsAtRelease = -1
    store.onStored(() => { notifications += 1 })
    let committed = false
    const started = performance.now()
    const timer = setTimeout(() => {
      timerElapsed = performance.now() - started
      pendingAtRelease = !committed
      timeoutAfterRefusal = db.query("PRAGMA busy_timeout").get()
      notificationsAtRelease = notifications
      blocker.exec("ROLLBACK")
      locked = false
    }, 1)
    try {
      const stored = await store.appendBatch([appendFor("s1", "first"), appendFor("s1", "second")])
      committed = true
      expect(pendingAtRelease).toBe(true)
      expect(timeoutAfterRefusal).toEqual({ timeout: 5000 })
      expect(notificationsAtRelease).toBe(0)
      expect(notifications).toBe(1)
      expect(timerElapsed).toBeLessThan(500)
      expect(stored.map((event) => event.seq)).toEqual([0, 1])
      expect(store.read({ aggregateId: "session:s1" })).toEqual(stored)
    } finally {
      clearTimeout(timer)
      if (locked) blocker.exec("ROLLBACK")
      blocker.close()
      await store.close()
    }
    const reopened = createSqliteEventStore(dbPath)
    try {
      expect(reopened.read({ aggregateId: "session:s1" }).map((event) => event.payload)).toEqual([{ text: "first" }, { text: "second" }])
    } finally {
      reopened.close()
    }
  }, 10_000)

  it("restores the native busy timeout after a runtime transaction rolls back without notifying", async () => {
    const exec = spyOn(Database.prototype, "exec")
    const store = createRuntimeEventStore(tempDbPath("fw-runtime-rollback-posture-"))
    const db = exec.mock.contexts[0]
    exec.mockRestore()
    if (!(db instanceof Database)) throw new Error("expected the runtime connection")
    const commit = spyOn(db.query("commit"), "run").mockImplementationOnce(() => {
      throw new Error("commit refused")
    })
    let notifications = 0
    store.onStored(() => { notifications += 1 })
    try {
      await expect(store.append(appendFor("s1", "rolled back"))).rejects.toThrow("commit refused")
      expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
      expect(store.read({ aggregateId: "session:s1" })).toEqual([])
      expect(notifications).toBe(0)
    } finally {
      commit.mockRestore()
      await store.close()
    }
  })

  it("works through store, split reader, and lane services", async () => {
    const runtime = ManagedRuntime.make(EventStoreLive(tempDbPath("fw-event-store-service-")))

    try {
      const reader = runtime.runSync(EventReaderService)
      const store = runtime.runSync(EventStoreService)
      const lane = runtime.runSync(EventStoreWriterLaneService)
      const stored = await store.append({
        aggregateId: "aggregate-1",
        type: "fact.recorded",
        version: 1,
        timestamp: 123,
        actor: "test",
        sessionId: "session-1",
        payload: { fact: "recorded" },
      })
      const lease = lane.lease({ kind: "session", sessionId: "session-1" })
      expect(lease.enqueue(appendFor("session-1", "queued")).kind).toBe("accepted")
      const drained = await lease.drain()
      lease.dispose()

      expect(drained.kind).toBe("drained")
      expect((await reader.readSlice({ aggregateId: "aggregate-1" })).facts).toEqual([stored])
      expect((await reader.readSlice({ aggregateId: "session:session-1" })).facts).toHaveLength(1)
      // One object serves both services, and it offers no synchronous read:
      // only LocalEventStoreService reaches the connection directly.
      expect(reader).toBe(store)
      expect(["read", "readTolerant", "currentPosition", "toolContent"].filter((member) => member in store)).toEqual([])
    } finally {
      await runtime.dispose()
    }
  })

  it("returns typed pressure instead of growing past queue limits", async () => {
    const lane = createEventStoreWriterLane(stalledWriter(), { maxQueuedEvents: 1, maxQueuedBytes: 10_000 })
    try {
      const lease = lane.lease({ kind: "session", sessionId: "s1" })
      expect(lease.enqueue(appendFor("s1", "one")).kind).toBe("accepted")

      const pressure = lease.enqueue(appendFor("s1", "two"))
      expect(pressure).toEqual({
        kind: "pressure",
        reason: "queued_events",
        queuedEvents: 1,
        queuedBytes: lane.snapshot().queuedBytes,
        maxQueuedEvents: 1,
        maxQueuedBytes: 10_000,
        retryAfterMs: 25,
      })
      expect(lane.snapshot().queuedEvents).toBe(1)
      lease.dispose()
    } finally {
      await lane.dispose().catch(() => {})
    }
  })

  it("rejects an unserializable payload at enqueue instead of poisoning a later batch", async () => {
    const lane = createEventStoreWriterLane(stalledWriter(), { maxQueuedEvents: 10, maxQueuedBytes: 10_000 })
    try {
      const payload: CyclicPayload = { text: "one" }
      payload.self = payload
      const lease = lane.lease({ kind: "session", sessionId: "s1" })

      expect(() => lease.enqueue({ ...appendFor("s1", "one"), payload })).toThrow("cyclic")
      expect(lane.snapshot().queuedEvents).toBe(0)
      lease.dispose()
    } finally {
      await lane.dispose()
    }
  })

  it("serializes once at enqueue, so the durable row is the enqueue-time snapshot", async () => {
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-snapshot-"))
    const lane = createEventStoreWriterLane(store)
    try {
      const payload = { text: "before" }
      const lease = lane.lease({ kind: "session", sessionId: "s1" })
      const accepted = lease.enqueue({ ...appendFor("s1", "one"), payload })
      expect(accepted.kind).toBe("accepted")
      payload.text = "after"

      const drained = await lease.drain()
      expect(drained.kind).toBe("drained")
      expect(store.read({ aggregateId: "session:s1" })[0]?.payload).toEqual({ text: "before" })
      lease.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("re-commits a batch the store refused for the write lock, so a foreign lock delays a fact instead of losing it", async () => {
    // The failure this reproduces: startup maintenance (or any second process)
    // holds the write lock, the commit throws SQLITE_BUSY, and the user's own
    // chat message is rejected with no producer left to re-offer it.
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-busy-"))
    let attempts = 0
    const contendedWriter: EventStoreBatchWriter = {
      commitItems: (items) => {
        attempts += 1
        if (attempts === 1) throw Object.assign(new Error("database is locked"), { name: "SQLiteError", code: "SQLITE_BUSY" })
        return store.commitItems(items)
      },
    }
    const lane = createEventStoreWriterLane(contendedWriter)
    try {
      const lease = lane.lease({ kind: "session", sessionId: "s1" })
      const accepted = lease.enqueue(appendFor("s1", "survives the lock"))
      if (accepted.kind !== "accepted") throw new Error("expected an accepted enqueue")

      const fact = await accepted.commit

      expect(attempts).toBe(2)
      expect(fact.payload).toEqual({ text: "survives the lock" })
      expect(store.read({ aggregateId: "session:s1" }).map((event) => event.payload)).toEqual([{ text: "survives the lock" }])
      lease.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("fails a batch whose error is not lock contention without retrying it", async () => {
    let attempts = 0
    const brokenWriter: EventStoreBatchWriter = {
      commitItems: () => {
        attempts += 1
        throw new Error("disk I/O error")
      },
    }
    const lane = createEventStoreWriterLane(brokenWriter)
    try {
      const lease = lane.lease({ kind: "session", sessionId: "s1" })
      const accepted = lease.enqueue(appendFor("s1", "one"))
      if (accepted.kind !== "accepted") throw new Error("expected an accepted enqueue")

      await expect(accepted.commit).rejects.toThrow("disk I/O error")
      expect(attempts).toBe(1)
      lease.dispose()
    } finally {
      await lane.dispose().catch(() => {})
    }
  })

  it("commits concurrent enqueues from many producers in one flush transaction, resolving each with its stored fact in position order", async () => {
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-group-"))
    let commitCalls = 0
    const countingWriter: EventStoreBatchWriter = {
      commitItems: (items) => {
        commitCalls += 1
        return store.commitItems(items)
      },
    }
    const lane = createEventStoreWriterLane(countingWriter)
    try {
      const leaseA = lane.lease({ kind: "session", sessionId: "a" })
      const leaseB = lane.lease({ kind: "session", sessionId: "b" })
      // One synchronous burst across producers and item kinds: the microtask
      // flush must coalesce all of it into a single transaction.
      const first = leaseA.enqueue(appendFor("a", "a1"))
      const second = leaseB.enqueue(appendFor("b", "b1"))
      const batch = lane.appendBatch([appendFor("a", "a2"), appendFor("a", "a3")])
      const third = lane.append(appendFor("b", "b2"))
      if (first.kind !== "accepted" || second.kind !== "accepted") throw new Error("expected accepted enqueues")

      const [firstFact, secondFact, batchFacts, thirdFact] = await Promise.all([first.commit, second.commit, batch, third])
      expect(commitCalls).toBe(1)
      const positions = [firstFact.position, secondFact.position, ...batchFacts.map((fact) => fact.position), thirdFact.position]
      expect(positions).toEqual([...positions].sort((left, right) => left - right))
      expect(firstFact.payload).toEqual({ text: "a1" })
      expect(batchFacts.map((fact) => fact.payload)).toEqual([{ text: "a2" }, { text: "a3" }])
      leaseA.dispose()
      leaseB.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("commits an item's content rows atomically with it and resolves the exact bytes", async () => {
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-content-"))
    const lane = createEventStoreWriterLane(store)
    try {
      const text = "tool output ".repeat(400)
      const row = contentRowFor(text)

      const stored = await lane.append({ ...appendFor("s1", "ref"), contentRows: [row] })

      expect(store.toolContent.resolve("s1", row.sha256)).toBe(text)
      expect("contentRows" in stored).toBe(false)
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("rolls a failing item's content rows back while peers in the same flush commit", async () => {
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-content-rollback-"))
    const lane = createEventStoreWriterLane(store)
    try {
      await lane.append(appendFor("s1", "existing"))
      const doomedRow = contentRowFor(`doomed ${"x".repeat(4096)}`)
      const peerRow = contentRowFor(`peer ${"y".repeat(4096)}`)

      // Same synchronous burst: the doomed item and its peer share one flush.
      const doomed = lane.appendGuarded({ ...appendFor("s1", "stale"), expectedSeq: 0, contentRows: [doomedRow] })
      const peer = lane.append({ ...appendFor("s2", "peer"), contentRows: [peerRow] })

      await expect(doomed).resolves.toMatchObject({ kind: "conflict" })
      expect((await peer).payload).toEqual({ text: "peer" })
      expect(store.toolContent.resolve("s1", doomedRow.sha256)).toBeNull()
      expect(store.toolContent.resolve("s2", peerRow.sha256)).toBe(peerRow.content)
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("returns a conflict for a stale guarded item while the rest of its flush commits", async () => {
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-guard-"))
    const lane = createEventStoreWriterLane(store)
    try {
      await lane.append(appendFor("s1", "existing"))

      const stale = lane.appendGuarded({ ...appendFor("s1", "stale"), expectedSeq: 0 })
      const peer = lane.append(appendFor("s2", "peer"))

      await expect(stale).resolves.toMatchObject({ kind: "conflict" })
      expect((await peer).payload).toEqual({ text: "peer" })
      expect(store.read({ aggregateId: "session:s1" }).map((event) => event.payload)).toEqual([{ text: "existing" }])
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("rejects an atomic item as a unit when a middle append fails, and later items still commit", async () => {
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-atomic-"))
    const lane = createEventStoreWriterLane(store)
    try {
      await lane.append(appendFor("s1", "existing"))

      // Same synchronous burst: the doomed atomic item and the later item
      // share one flush. The middle event's stale guard voids the whole item.
      const doomed = lane.appendBatchGuarded([
        appendFor("s1", "first"),
        { ...appendFor("s1", "middle"), expectedSeq: 0 },
        appendFor("s1", "last"),
      ])
      const later = lane.append(appendFor("s1", "later"))

      await expect(doomed).resolves.toMatchObject({ kind: "conflict" })
      const laterFact = await later
      expect(store.read({ aggregateId: "session:s1" }).map((event) => event.payload)).toEqual([{ text: "existing" }, { text: "later" }])
      // The rolled-back item's seqs are reclaimed: the survivor extends the
      // aggregate contiguously.
      expect(laterFact.seq).toBe(1)
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("rejects the failed batch's commits with the real error and keeps the lane open for later events", async () => {
    // One bad batch must not poison the shared per-workspace lane: the
    // batch's own callers see the real rejection, and the next enqueue
    // flows normally once the writer recovers.
    let failuresLeft = 1 // fail batch one; no retry, a local write failure is a real substrate error
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-recover-"))
    const writer: EventStoreBatchWriter = {
      commitItems(items) {
        if (failuresLeft > 0) {
          failuresLeft -= 1
          throw new Error("disk full")
        }
        return store.commitItems(items)
      },
    }
    const lane = createEventStoreWriterLane(writer)
    try {
      const lease = lane.lease({ kind: "session", sessionId: "s1" })
      const accepted = lease.enqueue(appendFor("s1", "one"))
      expect(accepted.kind).toBe("accepted")
      if (accepted.kind !== "accepted") throw new Error("expected accepted enqueue")

      const drained = await lease.drain()
      expect(drained.kind).toBe("failed")
      await expect(accepted.commit).rejects.toThrow("disk full")

      const later = lease.enqueue(appendFor("s1", "two"))
      expect(later.kind).toBe("accepted")
      if (later.kind !== "accepted") throw new Error("expected accepted enqueue after batch failure")
      const recovered = await lease.drain()
      expect(recovered.kind).toBe("drained")
      expect(recovered.acked).toHaveLength(1)
      expect((await later.commit).payload).toEqual({ text: "two" })
      lease.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("dispose is one durable drain settlement, reported to every caller", async () => {
    // The shutdown barrier joins this settlement, and a repeat request must not
    // report a clean drain over a final batch that failed: the events are lost
    // either way, and only the first outcome is the truth about them.
    let committedBatches = 0
    const writer: EventStoreBatchWriter = {
      commitItems() {
        committedBatches += 1
        throw new Error("substrate refused the final batch")
      },
    }
    const lane = createEventStoreWriterLane(writer)
    const lease = lane.lease({ kind: "session", sessionId: "s1" })
    const accepted = lease.enqueue(appendFor("s1", "unwritten"))
    if (accepted.kind !== "accepted") throw new Error("expected accepted enqueue")

    const first = await lane.dispose()
    const repeated = await lane.dispose()

    expect(first.kind).toBe("failed")
    expect(repeated).toBe(first)
    expect(committedBatches).toBe(1)
    await expect(accepted.commit).rejects.toThrow("substrate refused the final batch")
    expect(lane.state()).toBe("disposed")
  })


  it("rejects lease enqueues while drain snapshots accepted facts", async () => {
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-drain-"))
    const gated = gatedWriter(store)
    const lane = createEventStoreWriterLane(gated.writer)
    try {
      const lease = lane.lease({ kind: "session", sessionId: "s1" })
      expect(lease.enqueue(appendFor("s1", "one")).kind).toBe("accepted")

      const draining = lease.drain()
      expect(lease.enqueue(appendFor("s1", "late"))).toEqual({ kind: "closed", state: "draining", scope: "lease", message: "session event writer draining" })

      gated.release()
      const drained = await draining
      expect(drained.kind).toBe("drained")
      expect(lease.enqueue(appendFor("s1", "after-drain")).kind).toBe("accepted")
      lease.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("keeps lease enqueues open while flush settles queued facts", async () => {
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-flush-"))
    const gated = gatedWriter(store)
    const lane = createEventStoreWriterLane(gated.writer)
    try {
      const lease = lane.lease({ kind: "session", sessionId: "s1" })
      expect(lease.enqueue(appendFor("s1", "one")).kind).toBe("accepted")

      const flushing = lease.flush()
      const late = lease.enqueue(appendFor("s1", "late"))
      expect(late.kind).toBe("accepted")

      gated.release()
      const flushed = await flushing
      expect(flushed.kind).toBe("drained")
      expect(store.read({ aggregateId: "session:s1" }).map((event) => event.payload)).toEqual([{ text: "one" }, { text: "late" }])
      lease.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("flushes a lone enqueue without a timer: the fact commits after only microtask turns", async () => {
    // Two properties in one: an idle lane flushes a lone enqueue promptly with
    // no wait for a batch peer, and the lane must not depend on the timer
    // wheel for durability -- a starved event loop wedges timers minutes past
    // due while microtasks still drain (2026-07-07 incident). Await the commit
    // directly; no clock advances here, so a timer-scheduled or peer-awaiting
    // flush would never fire inside this test.
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-microtask-"))
    const lane = createEventStoreWriterLane(store)
    try {
      const lease = lane.lease({ kind: "session", sessionId: "s1" })
      const accepted = lease.enqueue(appendFor("s1", "one"))
      expect(accepted.kind).toBe("accepted")
      if (accepted.kind !== "accepted") throw new Error("expected accepted enqueue")

      expect((await accepted.commit).payload).toEqual({ text: "one" })
      expect(store.read({ aggregateId: "session:s1" }).map((event) => event.payload)).toEqual([{ text: "one" }])
      lease.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("flushes an enqueue that lands between flushLoop's final check and the flushing clear", async () => {
    // A continuation awaiting the first commit runs before the flush's
    // finally clears `flushing`; an enqueue there used to see the in-flight
    // flush, skip scheduling, and hang its commit forever once the flush
    // cleared without rescheduling.
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-wakeup-"))
    const lane = createEventStoreWriterLane(store)
    try {
      const lease = lane.lease({ kind: "session", sessionId: "s1" })
      const first = lease.enqueue(appendFor("s1", "one"))
      if (first.kind !== "accepted") throw new Error("expected accepted enqueue")
      await first.commit

      const second = lease.enqueue(appendFor("s1", "two"))
      if (second.kind !== "accepted") throw new Error("expected accepted enqueue")
      expect((await second.commit).payload).toEqual({ text: "two" })
      lease.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("lets each lease drain only its accepted facts while the workspace lane owns disposal", async () => {
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-"))
    const lane = createEventStoreWriterLane(store, { maxBatchEvents: 10 })
    try {
      const leaseA = lane.lease({ kind: "session", sessionId: "a" })
      const leaseB = lane.lease({ kind: "session", sessionId: "b" })
      expect(leaseA.enqueue(appendFor("a", "a1")).kind).toBe("accepted")
      expect(leaseB.enqueue(appendFor("b", "b1")).kind).toBe("accepted")

      const drainedA = await leaseA.drain()
      expect(drainedA.kind).toBe("drained")
      if (drainedA.kind !== "drained") throw new Error("expected drained lease")
      expect(drainedA.acked.map((event) => event.sessionId)).toEqual(["a"])
      expect(store.read({ aggregateId: "session:a" })).toHaveLength(1)
      expect(store.read({ aggregateId: "session:b" })).toHaveLength(1)

      const disposed = await lane.dispose()
      expect(disposed.kind).toBe("drained")
      expect(leaseA.enqueue(appendFor("a", "late"))).toEqual({ kind: "closed", state: "disposed", scope: "lane", message: "event writer lane is disposed" })
      leaseA.dispose()
      leaseB.dispose()
    } finally {
      store.close()
    }
  })

  it("settles items individually inside one flush: a rejected settlement fails only its own item", async () => {
    // Writer-level per-item settlement (as commitItems produces for a seq
    // conflict) must map one-to-one onto the queued items.
    const store = createSqliteEventStore(tempDbPath("fw-event-store-lane-settle-"))
    const writer: EventStoreBatchWriter = {
      commitItems: (items) => store.commitItems(items).map((settlement, index): EventStoreItemSettlement =>
        index === 0 ? { kind: "rejected", error: new Error("first item refused") } : settlement),
    }
    const lane = createEventStoreWriterLane(writer)
    try {
      const doomed = lane.append(appendFor("s1", "doomed"))
      const survivor = lane.append(appendFor("s2", "survivor"))

      await expect(doomed).rejects.toThrow("first item refused")
      await doomed.catch(() => {})
      expect((await survivor).payload).toEqual({ text: "survivor" })
    } finally {
      await lane.dispose()
      store.close()
    }
  })
})
