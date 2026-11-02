import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InFlightSwapConflictError, PersistenceWriteRefused, type EventStoreAppend } from "../../../src/infra/event-store-types.js"
import { createEventStoreWriterLane } from "../../../src/infra/event-store-writer-lane.js"
import type { EventStoreBatchWriter } from "../../../src/infra/event-store-writer-lane-types.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"

function fact(sessionId: string, inFlight?: EventStoreAppend["inFlight"]): EventStoreAppend {
  return {
    aggregateId: `session:${sessionId}`,
    sessionId,
    type: "session.label.updated",
    version: 1,
    actor: "test",
    timestamp: 1,
    payload: {},
    ...(inFlight ? { inFlight } : {}),
  }
}

function textFact(sessionId: string, text: string): EventStoreAppend {
  return { ...fact(sessionId), type: "fact.recorded", payload: { text } }
}

function withLaneStore<T>(run: (dbPath: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "writer-lane-drain-"))
  return run(join(directory, "events.sqlite")).finally(() => rmSync(directory, { recursive: true, force: true }))
}

describe("event store writer lane operation cells", () => {
  test("keeps a guarded conflict scoped to its owning lease", async () => {
    const directory = mkdtempSync(join(tmpdir(), "writer-lane-lease-conflict-"))
    const store = createSqliteEventStore(join(directory, "events.sqlite"))
    const lane = createEventStoreWriterLane(store)
    try {
      await lane.append(fact("stale"))
      const peerLease = lane.lease({ kind: "session", sessionId: "peer" })
      const stale = lane.appendGuarded({ ...fact("stale"), expectedSeq: 0 })
      const peer = peerLease.enqueue(fact("peer"))
      if (peer.kind !== "accepted") throw new Error("expected accepted write")

      const peerFlush = await peerLease.flush()

      expect(peerFlush).toMatchObject({ kind: "drained" })
      await expect(peer.commit).resolves.toMatchObject({ aggregateId: "session:peer", seq: 0 })
      await expect(stale).resolves.toEqual({
        kind: "conflict",
        conflict: { aggregateId: "session:stale", expectedSeq: 0, actualSeq: 1 },
      })
      await expect(lane.flush()).resolves.toMatchObject({ kind: "drained" })
    } finally {
      await lane.dispose()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("retains an early storage failure until the owning lease barrier observes it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "writer-lane-lease-failure-"))
    const store = createSqliteEventStore(join(directory, "events.sqlite"))
    const failure = new PersistenceWriteRefused(129, 128)
    const lane = createEventStoreWriterLane({
      ...store,
      commitItems: async (items) => items.map((item) => item.sessionId === "s1" ? { kind: "rejected", error: failure } : store.commitItems([item])[0]!),
    })
    try {
      const owner = lane.lease({ kind: "session", sessionId: "s1" })
      const enqueued = owner.enqueue(fact("s1"))
      if (enqueued.kind !== "accepted") throw new Error("expected accepted enqueue")
      await expect(enqueued.commit).rejects.toBe(failure)

      await expect(owner.flush()).resolves.toEqual({
        kind: "failed",
        error: { message: failure.message },
        acked: [],
      })
      await expect(owner.flush()).resolves.toMatchObject({ kind: "drained" })
      await expect(lane.append(fact("unrelated"))).resolves.toMatchObject({ sessionId: "unrelated" })
    } finally {
      await lane.dispose()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("keeps multi-aggregate facts and a guarded cell transition atomic in one lane item", async () => {
    const directory = mkdtempSync(join(tmpdir(), "writer-lane-item-"))
    const store = createSqliteEventStore(join(directory, "events.sqlite"))
    const lane = createEventStoreWriterLane(store)
    try {
      await lane.appendWriteItem({
        sessionId: "s1",
        events: [],
        inFlight: [{ op: "put", kind: "tool", key: "one", payload: { stage: "started" } }],
      })
      const raw = store.readInFlight("s1", "tool")[0]!.raw
      await expect(lane.appendWriteItem({
        sessionId: "s1",
        events: [
          fact("s1"),
          { ...fact("s1"), aggregateId: "workflow:s1", type: "workflow.completed" },
        ],
        inFlight: [{ op: "swap", kind: "tool", key: "one", expectedRaw: "stale", payload: null }],
      })).rejects.toBeInstanceOf(InFlightSwapConflictError)
      expect(store.currentPosition()).toBe(0)
      expect(store.readInFlight("s1", "tool")[0]?.raw).toBe(raw)

      const stored = await lane.appendWriteItem({
        sessionId: "s1",
        events: [
          fact("s1"),
          { ...fact("s1"), aggregateId: "workflow:s1", type: "workflow.completed" },
        ],
        inFlight: [{ op: "swap", kind: "tool", key: "one", expectedRaw: raw, payload: null }],
      })
      expect(stored.kind).toBe("stored")
      if (stored.kind !== "stored") throw new Error("expected stored write item")
      expect(stored.events).toHaveLength(2)
      expect(store.readInFlight("s1", "tool")).toEqual([])
    } finally {
      await lane.dispose()
      store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  test("queues standalone cell writes with their serialized byte limits and durable acknowledgement", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const calls: unknown[] = []
    const lane = createEventStoreWriterLane({
      async commitItems(items) {
        await gate
        calls.push(...items)
        return items.map(() => ({ kind: "stored", events: [] }))
      },
    }, { maxQueuedBytes: 120 })
    try {
      let committed = false
      const pending = lane.putInFlight("s1", "tool", "one", { cursor: 1 }).then(() => { committed = true })
      expect(lane.snapshot().queuedEvents).toBe(1)
      await Promise.resolve()
      expect(committed).toBe(false)
      release()
      await pending
      await lane.putInFlight("s1", "tool", "large", { text: "x".repeat(200) })
      await lane.dropInFlight("s1", "tool", "one")
      expect(calls).toEqual([
        { sessionId: "s1", events: [], inFlight: [{ op: "put", kind: "tool", key: "one", payload: { cursor: 1 }, payloadJson: '{"cursor":1}' }] },
        { sessionId: "s1", events: [], inFlight: [{ op: "put", kind: "tool", key: "large", payload: { text: "x".repeat(200) }, payloadJson: JSON.stringify({ text: "x".repeat(200) }) }] },
        { sessionId: "s1", events: [], inFlight: [{ op: "drop", kind: "tool", key: "one" }] },
      ])
      await lane.dispose()
      await expect(lane.dropInFlight("s1", "tool", "one")).rejects.toThrow("disposed")
    } finally {
      release()
      await lane.dispose()
    }
  })

  test("serializes guarded cell swaps through the shared writer lane", async () => {
    const calls: unknown[] = []
    const writer: EventStoreBatchWriter = {
      commitItems: (items) => {
        calls.push(...items)
        return items.map(() => ({ kind: "stored" as const, events: [] }))
      },
    }
    const lane = createEventStoreWriterLane(writer)

    expect(await lane.swapInFlight("s1", "file.mutation", "tool-1", null, { version: 1, cursor: 0 })).toBe(true)
    await lane.append(fact("s1"))

    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ sessionId: "s1", events: [], inFlight: [{ op: "swap", expectedRaw: null }] })
    await lane.dispose()
  })

  test("counts serialized in-flight sidecars in queue limits", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const writer: EventStoreBatchWriter = {
      commitItems: async (items) => {
        await gate
        return items.map((item) => ({ kind: "stored" as const, events: Array.isArray(item) ? [] : [] }))
      },
    }
    const lane = createEventStoreWriterLane(writer, { maxQueuedBytes: 80, maxBatchBytes: 80 })
    const result = lane.lease({ kind: "session", sessionId: "s1" }).enqueue(fact("s1", [{ op: "put", kind: "k", key: "x", payload: { text: "x".repeat(100) } }]))

    expect(result.kind).toBe("accepted")
    const second = lane.lease({ kind: "session", sessionId: "s1" }).enqueue(fact("s1"))
    expect(second.kind).toBe("pressure")
    if (second.kind === "pressure") expect(second.reason).toBe("queued_bytes")
    release()
    await lane.dispose()
  })
})

describe("event store writer lane drain", () => {
  test("lane drains enqueued events through the in-thread writer with contiguous readback", () => withLaneStore(async (dbPath) => {
    const store = createSqliteEventStore(dbPath)
    const lane = createEventStoreWriterLane(store)
    try {
      const lease = lane.lease({ kind: "session", sessionId: "s1" })
      const first = lease.enqueue(textFact("s1", "hello"))
      const second = lease.enqueue(textFact("s1", "world"))
      expect(first.kind).toBe("accepted")
      expect(second.kind).toBe("accepted")

      const drained = await lease.drain()
      expect(drained.kind).toBe("drained")
      expect(drained.acked).toHaveLength(2)

      const events = store.read({ aggregateId: "session:s1" })
      expect(events.map((event) => event.seq)).toEqual([0, 1])
      expect(new Set(events.map((event) => event.id)).size).toBe(2)
      expect(events.map((event) => event.payload)).toEqual([{ text: "hello" }, { text: "world" }])
      lease.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  }))

  test("a failed batch fails only its own events and the lane stays open", () => withLaneStore(async (dbPath) => {
    const store = createSqliteEventStore(dbPath)
    let failNext = true
    const flakyWriter: EventStoreBatchWriter = {
      commitItems: (items) => {
        if (failNext) {
          failNext = false
          throw new Error("substrate refused the batch")
        }
        return store.commitItems(items)
      },
    }
    const lane = createEventStoreWriterLane(flakyWriter)
    try {
      const lease = lane.lease({ kind: "session", sessionId: "s2" })
      const doomed = lease.enqueue(textFact("s2", "doomed"))
      if (doomed.kind !== "accepted") throw new Error(`expected accepted, got ${doomed.kind}`)

      const failedDrain = await lease.drain()
      expect(failedDrain.kind).toBe("failed")
      await expect(doomed.commit).rejects.toThrow("substrate refused the batch")
      expect(lane.state()).toBe("open")

      const survivor = lease.enqueue(textFact("s2", "survivor"))
      expect(survivor.kind).toBe("accepted")
      const drained = await lease.drain()
      expect(drained.kind).toBe("drained")
      expect(store.read({ aggregateId: "session:s2" }).map((event) => event.payload)).toEqual([{ text: "survivor" }])
      lease.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  }))

  test("a final append the substrate refuses is a failed drain, and everything acked before it reads back", () => withLaneStore(async (dbPath) => {
    const store = createSqliteEventStore(dbPath)
    const lane = createEventStoreWriterLane(store)
    const lease = lane.lease({ kind: "session", sessionId: "s3" })

    expect(lease.enqueue(textFact("s3", "written")).kind).toBe("accepted")
    expect((await lease.drain()).kind).toBe("drained")

    const unwritten = lease.enqueue(textFact("s3", "unwritten"))
    if (unwritten.kind !== "accepted") throw new Error(`expected accepted, got ${unwritten.kind}`)
    // The substrate goes away before the lane's last write, with a ticket the
    // lane accepted still queued: the drain cannot succeed and must say so.
    store.close()

    const drained = await lane.dispose()

    expect(drained.kind).toBe("failed")
    await expect(unwritten.commit).rejects.toThrow()

    const reopened = createSqliteEventStore(dbPath)
    try {
      expect(reopened.read({ aggregateId: "session:s3" }).map((event) => event.payload)).toEqual([{ text: "written" }])
    } finally {
      reopened.close()
    }
  }))
})

describe("event store writer lane fairness", () => {
  test("carries the work budget across completed flushes and drains after yielding", async () => {
    let now = 0
    let calls = 0
    let releaseTurn: () => void = () => {}
    const lane = createEventStoreWriterLane({
      commitItems(items) {
        calls += 1
        now += 3
        return items.map(() => ({ kind: "stored", events: [] }))
      },
    }, {}, {
      now: () => now,
      sleep: async (ms) => { now += ms },
      nextTurn: () => new Promise<void>((resolve) => { releaseTurn = resolve }),
    })
    try {
      await lane.append(fact("s1"))
      await lane.flush()
      expect(calls).toBe(1)
      await lane.append(fact("s2"))
      await lane.flush()
      const third = lane.append(fact("s3"))
      for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
      expect(calls).toBe(2)
      const draining = lane.dispose()
      expect(lane.state()).toBe("draining")
      releaseTurn()
      await third
      expect(calls).toBe(3)
      releaseTurn()
      expect((await draining).kind).toBe("drained")
    } finally {
      releaseTurn()
      await lane.dispose()
    }
  })

  test("starts a fresh lone enqueue without waiting when the event loop already yielded", async () => {
    let now = 0
    let calls = 0
    let releaseTurn: () => void = () => {}
    const lane = createEventStoreWriterLane({
      commitItems(items) { calls += 1; now += 5; return items.map(() => ({ kind: "stored", events: [] })) },
    }, {}, {
      now: () => now,
      sleep: async (ms) => { now += ms },
      nextTurn: () => new Promise<void>((resolve) => { releaseTurn = resolve }),
    })
    try {
      await lane.append(fact("s1"))
      releaseTurn()
      await Promise.resolve()
      now += 1_000
      await lane.append(fact("s2"))
      expect(calls).toBe(2)
    } finally {
      releaseTurn()
      await lane.dispose()
    }
  })
})

describe("event store writer lane lock patience", () => {
  test("retries a released 200ms lock within 50ms without spinning", async () => {
    let now = 0
    const sleeps: number[] = []
    const lane = createEventStoreWriterLane({
      commitItems(items) {
        if (now < 200) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
        return items.map(() => ({ kind: "stored", events: [] }))
      },
    }, {}, { now: () => now, sleep: async (ms) => { sleeps.push(ms); now += ms } })
    try {
      await lane.append(fact("s1"))
      expect(now).toBeGreaterThanOrEqual(200)
      expect(now).toBeLessThanOrEqual(250)
      expect(sleeps.every((ms) => ms >= 10 && ms <= 50)).toBe(true)
    } finally { await lane.dispose() }
  })

  test("can commit near the original deadline without letting a later item overtake it", async () => {
    let now = 0
    const committed: string[] = []
    const lane = createEventStoreWriterLane({
      commitItems(items) {
        if (now < 20_000) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
        committed.push(...items.map((item) => item.sessionId))
        return items.map(() => ({ kind: "stored", events: [] }))
      },
    }, { maxBatchEvents: 1 }, {
      now: () => now,
      sleep: async (ms: number) => { now += ms },
    })
    const first = lane.lease({ kind: "session", sessionId: "s1" }).enqueue(fact("s1"))
    const second = lane.lease({ kind: "session", sessionId: "s2" }).enqueue(fact("s2"))
    if (first.kind !== "accepted" || second.kind !== "accepted") throw new Error("expected accepted")
    const drained = await lane.dispose()
    expect(drained.kind).toBe("drained")
    expect(now).toBe(20_020)
    expect(committed).toEqual(["s1", "s2"])
    expect(first.ticket.state()).toBe("acked")
    expect(second.ticket.state()).toBe("acked")
  })

  test("spends the existing 20,525ms budget cooperatively with capped backoff", async () => {
    let now = 1_000
    const sleeps: number[] = []
    const attempts: number[] = []
    const busy = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
    const lane = createEventStoreWriterLane({
      commitItems() {
        attempts.push(now)
        throw busy
      },
    }, {}, {
      now: () => now,
      sleep: async (ms: number) => { sleeps.push(ms); now += ms },
    })
    const accepted = lane.lease({ kind: "session", sessionId: "s1" }).enqueue(fact("s1"))
    if (accepted.kind !== "accepted") throw new Error("expected accepted")
    try {
      await expect(accepted.commit).rejects.toBe(busy)
      expect(sleeps.slice(0, 4)).toEqual([10, 20, 40, 50])
      expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(20_525)
      expect(now).toBe(21_525)
      expect(Math.max(...attempts)).toBeLessThan(now)
      expect(accepted.ticket.state()).toBe("failed")
      expect(lane.state()).toBe("open")
    } finally {
      await lane.dispose()
    }
  })

  test("includes commit time in the deadline and caps the last sleep", async () => {
    let now = 0
    const sleeps: number[] = []
    let attempts = 0
    const lane = createEventStoreWriterLane({
      commitItems() {
        attempts += 1
        now += 10_250
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      },
    }, {}, {
      now: () => now,
      sleep: async (ms: number) => { sleeps.push(ms); now += ms },
    })
    try {
      await expect(lane.append(fact("s1"))).rejects.toThrow("database is locked")
      expect(sleeps).toEqual([10, 15])
      expect(now).toBe(20_525)
      expect(attempts).toBe(2)
    } finally {
      await lane.dispose()
    }
  })

  test("does not start another commit when the retry timer wakes after the deadline", async () => {
    let now = 0
    let attempts = 0
    const lane = createEventStoreWriterLane({
      commitItems() {
        attempts += 1
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
      },
    }, {}, {
      now: () => now,
      sleep: async () => { now += 30_000 },
    })
    try {
      await expect(lane.append(fact("s1"))).rejects.toThrow("database is locked")
      expect(attempts).toBe(1)
    } finally {
      await lane.dispose()
    }
  })
})
