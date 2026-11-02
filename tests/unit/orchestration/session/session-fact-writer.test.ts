import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import type { SessionRuntimeFact } from "../../../../src/orchestration/session/session-runtime-event-types"
import { createSessionFactWriter, type SessionFact } from "../../../../src/orchestration/session/session-fact-writer"
import { createEventStoreWriterLane } from "../../../../src/infra/event-store-writer-lane"
import { EventBus, createEmit } from "../../../../src/infra/event-bus"
import { asAsyncEventWriter, type EventStoreAppend, type StoredFact } from "../../../../src/infra/event-store-types"
import type { EventStoreEnqueueResult, EventStoreWriterLease } from "../../../../src/infra/event-store-writer-lane-types"
import type { SessionBudgetStore } from "../../../../src/orchestration/session/budget-store-types"
import { wireSessionSubscribers } from "../../../../src/orchestration/session/create-session-infra"
import type { SessionToolExecutionStore } from "../../../../src/orchestration/session/tool-execution-types"

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-session-event-writer-test-${process.pid}-${Date.now()}`,
)

let tmpDir: string

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function assistantFact(text = "hello"): SessionRuntimeFact {
  return {
    type: "model.assistant_message.recorded",
    version: 1,
    actor: "agent",
    payload: {
      content: [{ type: "text", text }],
    },
  }
}

/** The fields of a payload that lacks what its fact requires. */
interface MalformedPayload {
  readonly [field: string]: string
}

/** A copy of `fact` whose payload is `payload`, which the fact's schema refuses. The record's type admits no such
 *  payload, so only a write at run time can build the input that a rejection case feeds. */
function withPayload(fact: SessionFact, payload: MalformedPayload): SessionFact {
  const malformed = { ...fact }
  Reflect.set(malformed, "payload", payload)
  return malformed
}

function storedEvent(event: EventStoreAppend): StoredFact {
  return { ...event, id: "event-1", position: 1, seq: 0 }
}

function accepted(event: EventStoreAppend): EventStoreEnqueueResult {
  const committed = storedEvent(event)
  return {
    kind: "accepted",
    ticket: { id: 1, sessionId: event.sessionId, acceptedAt: 0, bytes: 1, state: () => "acked", commit: Promise.resolve(committed) },
    commit: Promise.resolve(committed),
    queuedEvents: 1,
    queuedBytes: 1,
  }
}

function pressure(retryAfterMs: number): EventStoreEnqueueResult {
  return { kind: "pressure", reason: "queued_events", queuedEvents: 1, queuedBytes: 1, maxQueuedEvents: 1, maxQueuedBytes: 1, retryAfterMs }
}

function fakeLease(enqueue: (event: EventStoreAppend) => EventStoreEnqueueResult): EventStoreWriterLease {
  return {
    sessionId: "s1",
    enqueue,
    flush: async () => ({ kind: "drained", acked: [] }),
    drain: async () => ({ kind: "drained", acked: [] }),
    dispose() {},
  }
}

beforeEach(() => {
  tmpDir = makeTmpDir()
})

afterEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe("SessionFactWriter", () => {
  describe.each(["record", "recordGuarded", "recordBatch", "transaction", "enqueue"] as const)("%s publication", (method) => {
    describe.each([false, true])("%s rejection", (rejects) => {
      it(`${method} waits for publication ${rejects ? "failure" : "completion"} after commit`, async () => {
        const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
        const lane = createEventStoreWriterLane(store)
        const started = Promise.withResolvers<void>()
        const publication = Promise.withResolvers<void>()
        const writer = createSessionFactWriter({
          sessionId: "s1",
          writer: asAsyncEventWriter(store),
          ...(method === "enqueue" ? { lane: lane.lease({ kind: "session", sessionId: "s1" }) } : {}),
          onStored: async (fact) => {
            expect(store.read({ aggregateId: "session:s1" })).toContainEqual(fact)
            started.resolve()
            await publication.promise
          },
        })
        try {
          let operation: Promise<unknown>
          if (method === "transaction") operation = writer.transaction(() => { void writer.record(assistantFact()) })
          else if (method === "recordBatch") operation = writer.recordBatch([assistantFact(), assistantFact("second")])
          else if (method === "recordGuarded") operation = writer.recordGuarded(assistantFact(), 0)
          else if (method === "enqueue") {
            const result = writer.enqueue?.(assistantFact())
            if (result?.kind !== "accepted") throw new Error("expected acceptance")
            expect(result.ticket.commit).toBe(result.commit)
            operation = result.commit
          } else operation = writer.record(assistantFact())
          let settled = false
          const observed = operation.then(() => { settled = true }, (error: unknown) => { settled = true; return error })
          await started.promise
          await Promise.resolve()
          expect(settled).toBe(false)
          const failure = new Error("publication failed")
          if (rejects) publication.reject(failure)
          else publication.resolve()
          expect(await observed).toBe(rejects ? failure : undefined)
        } finally {
          writer.dispose()
          await lane.dispose()
          store.close()
        }
      })
    })
  })

  describe.each(["drain", "flush"] as const)("%s barrier", (barrier) => {
    describe.each(["record", "recordGuarded", "enqueue"] as const)("%s publication", (method) => {
      describe.each([false, true])("%s rejection", (rejects) => {
        it(`${barrier} joins ${method} publication ${rejects ? "failure" : "completion"}`, async () => {
          const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
          const lane = createEventStoreWriterLane(store)
          const started = Promise.withResolvers<void>()
          const publication = Promise.withResolvers<void>()
          const writer = createSessionFactWriter({
            sessionId: "s1", writer: asAsyncEventWriter(store), lane: lane.lease({ kind: "session", sessionId: "s1" }),
            onStored: async () => { started.resolve(); await publication.promise },
          })
          try {
            // Enqueue's acknowledgement is deliberately abandoned: the barrier owns it.
            const operation = method === "enqueue"
              ? (writer.enqueue?.(assistantFact()), Promise.resolve())
              : method === "record" ? writer.record(assistantFact()) : writer.recordGuarded(assistantFact(), 0)
            const observed = operation.catch((error: unknown) => error)
            await started.promise
            let settled = false
            const drained = writer[barrier]?.().then(
              (result) => { settled = true; return result },
              (error: unknown) => { settled = true; return error },
            )
            await Promise.resolve()
            expect(settled).toBe(false)
            const failure = new Error("publication failed")
            if (rejects) publication.reject(failure)
            else publication.resolve()
            const result = await drained
            if (rejects) expect(result).toBe(failure)
            else expect(result).toMatchObject({ kind: "drained" })
            await observed
          } finally {
            writer.dispose()
            await lane.dispose()
            store.close()
          }
        })
      })
    })
  })

  it("flush releases settled publications but leaves publications accepted during the barrier for the next barrier", async () => {
    const first = Promise.withResolvers<void>()
    const second = Promise.withResolvers<void>()
    const flushStarted = Promise.withResolvers<void>()
    const releaseFlush = Promise.withResolvers<void>()
    let publicationCount = 0
    const lease = fakeLease(accepted)
    lease.flush = async () => {
      flushStarted.resolve()
      await releaseFlush.promise
      return { kind: "drained", acked: [] }
    }
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = createSessionFactWriter({
      sessionId: "s1",
      writer: asAsyncEventWriter(store),
      lane: lease,
      onStored: async () => {
        publicationCount += 1
        if (publicationCount === 1) await first.promise
        else await second.promise
      },
    })

    const firstQueued = writer.enqueue?.(assistantFact("first"))
    const barrier = writer.flush?.()
    await flushStarted.promise
    const secondQueued = writer.enqueue?.(assistantFact("second"))
    first.reject(new Error("first publication failed"))
    releaseFlush.resolve()
    await expect(barrier).rejects.toThrow("first publication failed")
    const nextBarrier = writer.flush?.()
    second.reject(new Error("second publication failed"))
    await expect(nextBarrier).rejects.toThrow("second publication failed")
    if (firstQueued?.kind === "accepted") await firstQueued.commit.catch(() => {})
    if (secondQueued?.kind === "accepted") await secondQueued.commit.catch(() => {})
    await expect(writer.flush?.()).resolves.toMatchObject({ kind: "drained" })
    writer.dispose()
    store.close()
  })

  it("projects committed writes once and does not project rejected writes", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const lane = createEventStoreWriterLane(store)
    const projected: StoredFact[] = []
    const writer = createSessionFactWriter({
      sessionId: "s1",
      writer: asAsyncEventWriter(store),
      lane: lane.lease({ kind: "session", sessionId: "s1" }),
      onStored: (fact) => {
        expect(store.read({ aggregateId: "session:s1" })).toContainEqual(fact)
        projected.push(fact)
      },
    })
    try {
      await writer.record(assistantFact("record"))
      await writer.recordGuarded(assistantFact("guarded"), 1)
      await expect(writer.recordGuarded(assistantFact("conflict"), 1)).resolves.toMatchObject({ kind: "conflict" })
      await writer.transaction(() => {
        void writer.record(assistantFact("batch"))
        expect(projected).toHaveLength(2)
      })
      await expect(writer.transaction(() => {
        void writer.record(assistantFact("rolled back"))
        throw new Error("abort batch")
      })).rejects.toThrow("abort batch")
      const queued = writer.enqueue?.(assistantFact("enqueue"))
      expect(queued?.kind).toBe("accepted")
      await writer.drain?.()
      if (queued?.kind === "accepted") await queued.commit
      expect(projected.map((fact) => fact.seq)).toEqual([0, 1, 2, 3])
    } finally {
      writer.dispose()
      await lane.dispose()
      store.close()
    }
  })

  it("writes typed facts with monotonic sequence numbers", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    try {
      const writer = createSessionFactWriter({ sessionId: "s1", writer: asAsyncEventWriter(store) })
      expect(writer.enqueue).toBeUndefined()
      expect(writer.drain).toBeUndefined()
      await writer.record(assistantFact("one"))
      await writer.record(assistantFact("two"))
      writer.dispose()

      const events = store.read({ aggregateId: "session:s1" })
      expect(events).toHaveLength(2)
      expect(events[0]?.seq).toBe(0)
      expect(events[1]?.seq).toBe(1)
      expect(events[0]?.type).toBe("model.assistant_message.recorded")
      expect(events[0]?.payload).toEqual({ content: [{ type: "text", text: "one" }] })
    } finally {
      store.close()
    }
  })

  it("keeps independent aggregate sequences per session", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    try {
      const writerA = createSessionFactWriter({ sessionId: "a", writer: asAsyncEventWriter(store) })
      const writerB = createSessionFactWriter({ sessionId: "b", writer: asAsyncEventWriter(store) })
      await writerA.record(assistantFact("a1"))
      await writerB.record(assistantFact("b1"))
      await writerA.record(assistantFact("a2"))
      writerA.dispose()
      writerB.dispose()

      const aEvents = store.read({ aggregateId: "session:a" })
      const bEvents = store.read({ aggregateId: "session:b" })
      expect(aEvents.map((event) => event.seq)).toEqual([0, 1])
      expect(bEvents.map((event) => event.seq)).toEqual([0])
    } finally {
      store.close()
    }
  })

  it("dispose marks the writer disposed without closing the borrowed store", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    try {
      const writer = createSessionFactWriter({ sessionId: "s1", writer: asAsyncEventWriter(store) })
      await writer.record(assistantFact())

      writer.dispose()
      expect(store.currentPosition()).toBeGreaterThan(0)
      expect(await writer.record(assistantFact("after"))).toBeNull()

      const events = store.read({ aggregateId: "session:s1" })
      expect(events).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it("batches transactions and rejects async callbacks", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    try {
      const writer = createSessionFactWriter({ sessionId: "s1", writer: asAsyncEventWriter(store) })
      await writer.transaction(() => {
        void writer.record(assistantFact("one"))
        void writer.record(assistantFact("two"))
      })
      expect(store.read({ aggregateId: "session:s1" }).map((event) => event.seq)).toEqual([0, 1])

      // A promise-returning function is assignable to a void callback, which is how an async callback reaches the writer.
      const asyncCallback: () => void = () => Promise.resolve()
      await expect(writer.transaction(asyncCallback)).rejects.toThrow("callback must be synchronous")
      expect(store.read({ aggregateId: "session:s1" })).toHaveLength(2)
      writer.dispose()
    } finally {
      store.close()
    }
  })

  it("accepts an improvement.committed fact and rejects a malformed improvement payload", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    try {
      const writer = createSessionFactWriter({ sessionId: "s1", writer: asAsyncEventWriter(store) })
      const committed: SessionFact = {
        type: "improvement.committed",
        version: 1,
        actor: "flywheel",
        payload: { proposalId: "p1", targetPath: "docs/solutions/x.md", sha256: "a".repeat(64), undoRef: "docs/solutions/x.md" },
      }
      await writer.record(committed)
      await expect(writer.record(withPayload(committed, { proposalId: "p1" }))).rejects.toThrow()
      writer.dispose()

      const events = store.read({ aggregateId: "session:s1" })
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe("improvement.committed")
    } finally {
      store.close()
    }
  })

  it("records papercuts on the owning session aggregate and rejects malformed payloads", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    try {
      const writer = createSessionFactWriter({ sessionId: "owner", writer: asAsyncEventWriter(store) })
      const papercut: SessionFact = {
        type: "papercut.recorded",
        version: 1,
        actor: "agent",
        payload: {
          observation: "The lint message hides the failing rule.",
          category: "missing-tooling",
          conversationId: "conversation-1",
          modelRequestId: "request-1",
          toolUseId: "tool-1",
          parentToolUseId: "parent-tool-1",
        },
      }
      await writer.record(papercut)
      await expect(writer.record(withPayload(papercut, { observation: "missing causation" }))).rejects.toThrow()
      writer.dispose()

      const events = store.read({ aggregateId: "session:owner" })
      expect(events).toHaveLength(1)
      expect(events[0]?.sessionId).toBe("owner")
      expect(events[0]?.payload).not.toHaveProperty("sessionId")
    } finally {
      store.close()
    }
  })

  it("rejects facts outside the session runtime vocabulary", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    try {
      const writer = createSessionFactWriter({ sessionId: "s1", writer: asAsyncEventWriter(store) })
      const fact: SessionRuntimeFact = {
        type: "tool.result.recorded",
        version: 1,
        actor: "flywheel",
        payload: { toolUseId: "tool-1", outcome: "ok" },
      }
      // The static type admits only vocabulary facts, so the test corrupts a valid one at runtime.
      Reflect.set(fact, "actor", "provider")
      Reflect.set(fact, "payload", { toolUseId: "tool-1", isError: false })
      await expect(writer.record(fact)).rejects.toThrow()
      writer.dispose()

      const events = store.read({ aggregateId: "session:s1" })
      expect(events).toHaveLength(0)
    } finally {
      store.close()
    }
  })

  it("can enqueue through a supplied lane and drain accepted facts to durability", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const lane = createEventStoreWriterLane(store)
    try {
      const writer = createSessionFactWriter({ sessionId: "s1", writer: asAsyncEventWriter(store), lane: lane.lease({ kind: "session", sessionId: "s1" }) })
      const result = writer.enqueue?.(assistantFact("queued"))

      expect(result?.kind).toBe("accepted")
      expect(store.read({ aggregateId: "session:s1" })).toHaveLength(0)

      const drained = await writer.drain?.()
      expect(drained?.kind).toBe("drained")
      expect(store.read({ aggregateId: "session:s1" })).toHaveLength(1)
      expect(store.read({ aggregateId: "session:s1" })[0]?.payload).toEqual({ content: [{ type: "text", text: "queued" }] })
      writer.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("does not retry an enqueue accepted on the first attempt", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const delays: number[] = []
    let enqueues = 0
    const writer = createSessionFactWriter({
      sessionId: "s1",
      writer: asAsyncEventWriter(store),
      lane: fakeLease((event) => {
        enqueues += 1
        return accepted(event)
      }),
      sleep: async (ms) => { delays.push(ms) },
    })
    try {
      expect(await writer.record(assistantFact())).toMatchObject({ type: "model.assistant_message.recorded" })
      expect(enqueues).toBe(1)
      expect(delays).toEqual([])
    } finally {
      writer.dispose()
      store.close()
    }
  })

  it("waits for the lane retry delay after pressure and then succeeds", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const delays: number[] = []
    let enqueues = 0
    const writer = createSessionFactWriter({
      sessionId: "s1",
      writer: asAsyncEventWriter(store),
      lane: fakeLease((event) => {
        enqueues += 1
        return enqueues === 1 ? pressure(17) : accepted(event)
      }),
      sleep: async (ms) => { delays.push(ms) },
    })
    try {
      expect(await writer.record(assistantFact())).toMatchObject({ type: "model.assistant_message.recorded" })
      expect(enqueues).toBe(2)
      expect(delays).toEqual([17])
    } finally {
      writer.dispose()
      store.close()
    }
  })

  it("preserves record order while an earlier fact is retrying", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const acceptedPayloads: unknown[] = []
    let enqueues = 0
    const writer = createSessionFactWriter({
      sessionId: "s1",
      writer: asAsyncEventWriter(store),
      lane: fakeLease((event) => {
        enqueues += 1
        if (enqueues === 1) return pressure(5)
        acceptedPayloads.push(event.payload)
        return accepted(event)
      }),
      sleep: async () => {},
    })
    try {
      await Promise.all([writer.record(assistantFact("one")), writer.record(assistantFact("two"))])
      expect(acceptedPayloads).toEqual([
        { content: [{ type: "text", text: "one" }] },
        { content: [{ type: "text", text: "two" }] },
      ])
    } finally {
      writer.dispose()
      store.close()
    }
  })

  it("surfaces a session notice when persistence exhausts four attempts", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    let enqueues = 0
    const writer = createSessionFactWriter({
      sessionId: "s1",
      writer: asAsyncEventWriter(store),
      lane: fakeLease(() => {
        enqueues += 1
        return pressure(5)
      }),
      sleep: async () => {},
    })
    const budgetStore: SessionBudgetStore = {
      recordRuntimeEvent: async () => {}, applyStoredFact: async () => {}, getTotalCost: async () => 0,
      recordInvocation: async () => {}, getInvocationsUsed: async () => 0, getTokensUsed: async () => 0,
      getOutputTokensUsed: async () => 0, metrics: async () => ({ tokens: 0, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: 0, contextPromptTokens: 0 }),
      recordContextUtilization: async () => {}, getContextUtilization: async () => ({ promptTokens: 0, contextWindow: 0, percent: 0 }),
      isExhausted: async () => false, dispose() {}, recordProcessStarted: async () => {},
    }
    const toolExecutionStore: SessionToolExecutionStore = { applyStoredFact: async () => {}, loadTimeline: async () => [], dispose() {} }
    const bus = new EventBus()
    const notices: string[] = []
    bus.subscribeToType("agent.notice.changed", (event) => {
      if (event.data.operation.type === "upsert") notices.push(event.data.operation.notice.message)
    }, { deliveryClass: "ui", label: "persistence-notice-test" })
    const wiring = wireSessionSubscribers(bus, { budgetStore, sessionEventWriter: writer, toolExecutionStore })
    createEmit(bus)("agent.error.observed", { sessionId: "s1", data: { message: "lost" } })
    try {
      await bus.drain()
      expect(enqueues).toBe(4)
      expect(notices).toHaveLength(1)
      expect(notices[0]).toContain("1 runtime fact was dropped after persistence retries")
    } finally {
      for (const unsub of wiring.unsubscribes) unsub()
      await bus.dispose()
      writer.dispose()
      store.close()
    }
  })

  it("can flush a supplied lane without closing the session lease", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const lane = createEventStoreWriterLane(store)
    try {
      const writer = createSessionFactWriter({ sessionId: "s1", writer: asAsyncEventWriter(store), lane: lane.lease({ kind: "session", sessionId: "s1" }) })
      expect(writer.enqueue?.(assistantFact("queued")).kind).toBe("accepted")
      const flushed = await writer.flush?.()
      expect(flushed?.kind).toBe("drained")
      expect(writer.enqueue?.(assistantFact("after-flush")).kind).toBe("accepted")
      await writer.drain?.()

      expect(store.read({ aggregateId: "session:s1" }).map((event) => event.payload)).toEqual([
        { content: [{ type: "text", text: "queued" }] },
        { content: [{ type: "text", text: "after-flush" }] },
      ])
      writer.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("keeps a peer sequence conflict out of the session durability barrier", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const lane = createEventStoreWriterLane(store)
    try {
      await lane.append({ ...assistantFact("peer-existing"), aggregateId: "session:s2", sessionId: "s2", timestamp: Date.now() })
      const writer = createSessionFactWriter({ sessionId: "s1", writer: asAsyncEventWriter(store), lane: lane.lease({ kind: "session", sessionId: "s1" }) })
      const peerConflict = lane.appendGuarded({
        ...assistantFact("peer-stale"),
        aggregateId: "session:s2",
        sessionId: "s2",
        timestamp: Date.now(),
        expectedSeq: 0,
      })
      expect(writer.enqueue?.(assistantFact("audit-response")).kind).toBe("accepted")

      await expect(writer.flush?.()).resolves.toMatchObject({ kind: "drained" })
      await expect(peerConflict).resolves.toMatchObject({ kind: "conflict" })
      expect(store.read({ aggregateId: "session:s1" }).map((event) => event.payload)).toEqual([
        { content: [{ type: "text", text: "audit-response" }] },
      ])
      writer.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  it("session disposal rejects lane enqueues without closing the workspace lane", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const lane = createEventStoreWriterLane(store)
    try {
      const writer = createSessionFactWriter({ sessionId: "s1", writer: asAsyncEventWriter(store), lane: lane.lease({ kind: "session", sessionId: "s1" }) })
      writer.dispose()

      expect(writer.enqueue?.(assistantFact("late"))).toEqual({ kind: "closed", state: "disposed", scope: "lease", message: "session event writer disposed" })

      const other = lane.lease({ kind: "session", sessionId: "s2" })
      expect(other.enqueue({
        aggregateId: "session:s2",
        type: "model.assistant_message.recorded",
        version: 1,
        timestamp: 123,
        actor: "agent",
        sessionId: "s2",
        payload: { content: [{ type: "text", text: "still-open" }] },
      }).kind).toBe("accepted")
      await other.drain()
      expect(store.read({ aggregateId: "session:s2" })).toHaveLength(1)
      other.dispose()
    } finally {
      await lane.dispose()
      store.close()
    }
  })
})
