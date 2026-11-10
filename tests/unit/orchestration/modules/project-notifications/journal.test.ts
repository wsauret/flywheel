import { describe, expect, it } from "bun:test"

import { asAsyncEventReadSurface, type AsyncGuardedEventAppender, type EventReader, type EventStoreAppend, type GuardedEventStoreAppend, type StoredFact } from "../../../../../src/infra/event-store-types"
import { createProjectNotificationJournal } from "../../../../../src/orchestration/modules/project-notifications/journal"

const AGGREGATE_ID = "project:notifications"

function createStore(): EventReader & AsyncGuardedEventAppender & { reads: Array<{ aggregateId?: string; afterPosition?: number }> } {
  const facts: StoredFact[] = []
  const reads: Array<{ aggregateId?: string; afterPosition?: number }> = []
  const append = async (event: EventStoreAppend): Promise<StoredFact> => {
    const nextSeq = facts.filter((fact) => fact.aggregateId === event.aggregateId).length
    const stored: StoredFact = { ...event, id: `fact-${facts.length + 1}`, position: facts.length + 1, seq: nextSeq }
    facts.push(stored)
    return stored
  }
  const store = {
    reads,
    read(query: Parameters<EventReader["read"]>[0] = {}) {
      reads.push({ aggregateId: query.aggregateId, afterPosition: query.afterPosition })
      return facts.filter((fact) => fact.aggregateId === query.aggregateId && (query.afterPosition === undefined || fact.position > query.afterPosition))
    },
    readTolerant: () => [],
    readLatestPayloadByAggregateAndType: () => null,
    readLatestByAggregateAndTypes: () => [],
    currentPosition: () => facts.length,
    countByAggregate: (aggregateId: string) => facts.filter((fact) => fact.aggregateId === aggregateId).length,
    aggregateSeq: (aggregateId: string) => facts.filter((fact) => fact.aggregateId === aggregateId).at(-1)?.seq ?? -1,
    readInFlight: () => [],
    sessionsWithInFlight: () => [],
    inFlightProfileKeys: () => [],
    append,
    async appendGuarded(event: GuardedEventStoreAppend) {
      const nextSeq = facts.filter((fact) => fact.aggregateId === event.aggregateId).length
      if (event.expectedSeq !== undefined && event.expectedSeq !== nextSeq) {
        return { kind: "conflict" as const, conflict: { aggregateId: event.aggregateId, expectedSeq: event.expectedSeq, actualSeq: nextSeq } }
      }
      const { expectedSeq: _guard, ...unguarded } = event
      return { kind: "stored" as const, events: [await append(unguarded)] }
    },
    async appendBatch(events: readonly EventStoreAppend[]) {
      return Promise.all(events.map((event) => store.append(event)))
    },
    async appendBatchGuarded(events: readonly GuardedEventStoreAppend[]) {
      for (const event of events) {
        const nextSeq = facts.filter((fact) => fact.aggregateId === event.aggregateId).length
        if (event.expectedSeq !== undefined && event.expectedSeq !== nextSeq) {
          return { kind: "conflict" as const, conflict: { aggregateId: event.aggregateId, expectedSeq: event.expectedSeq, actualSeq: nextSeq } }
        }
      }
      return {
        kind: "stored" as const,
        events: await Promise.all(events.map(({ expectedSeq: _guard, ...event }) => append(event))),
      }
    },
  }
  return store
}

const warning = {
  sourceId: "provider-auth:openai",
  title: "OpenAI needs authentication",
  message: "Sign in to continue using OpenAI.",
  severity: "warning" as const,
  action: { kind: "open-auth" } as const,
  sourceSessionId: "session-origin",
}

describe("project notification journal", () => {
  it("rejects durable replay with a sequence gap before appending", async () => {
    let appendCalls = 0
    const gap: StoredFact = {
      aggregateId: AGGREGATE_ID,
      id: "fact-gap",
      position: 1,
      seq: 1,
      type: "project.notification.raised",
      version: 1,
      timestamp: 1_000,
      actor: "system",
      sessionId: "session-1",
      payload: { ...warning, createdAt: 1_000, expiresAt: 1_000 + 48 * 60 * 60 * 1_000 },
    }
    const journal = createProjectNotificationJournal({
      reader: asAsyncEventReadSurface({ ...createStore(), currentPosition: () => 1, read: () => [gap] }),
      writer: {
        append: async () => {
          appendCalls += 1
          throw new Error("append must not run")
        },
        appendBatch: async () => [],
        appendGuarded: async () => {
          appendCalls += 1
          throw new Error("append must not run")
        },
        appendBatchGuarded: async () => {
          appendCalls += 1
          throw new Error("append must not run")
        },
      },
      sessionId: "session-1",
    })

    await expect(journal.reconcile()).rejects.toThrow("Project notification sequence must be contiguous after -1; received 1")
    expect(appendCalls).toBe(0)
  })

  it("commits one episode when independent journals concurrently raise the same source", async () => {
    const store = createStore()
    const reader = asAsyncEventReadSurface(store)
    const firstJournal = createProjectNotificationJournal({ reader, writer: store, sessionId: "session-1", now: () => 1_000 })
    const secondJournal = createProjectNotificationJournal({ reader, writer: store, sessionId: "session-2", now: () => 2_000 })

    const [first, duplicate] = await Promise.all([firstJournal.raise(warning), secondJournal.raise(warning)])

    expect(duplicate).toEqual(first)
    expect(first.createdAt).toBe(1_000)
    expect(first.expiresAt).toBe(1_000 + 48 * 60 * 60 * 1_000)
    expect(first.severity).toBe("warning")
    expect(first.sourceSessionId).toBe("session-origin")
    expect(store.countByAggregate(AGGREGATE_ID)).toBe(1)
  })

  it("reconciles a conflicting different source from the suffix before retrying", async () => {
    const store = createStore()
    const reader = asAsyncEventReadSurface(store)
    const firstJournal = createProjectNotificationJournal({ reader, writer: store, sessionId: "session-1", now: () => 1_000 })
    const secondJournal = createProjectNotificationJournal({ reader, writer: store, sessionId: "session-2", now: () => 2_000 })
    const alert = { ...warning, sourceId: "usage:episode-1", severity: "alert" as const, action: { kind: "open-usage" } as const }

    const [first, second] = await Promise.all([firstJournal.raise(warning), secondJournal.raise(alert)])

    expect(first.sourceId).toBe(warning.sourceId)
    expect(second.sourceId).toBe(alert.sourceId)
    expect(store.countByAggregate(AGGREGATE_ID)).toBe(2)
    await secondJournal.reconcile()
    expect(secondJournal.projection().episodes.map((episode) => episode.sourceId)).toEqual([alert.sourceId, warning.sourceId])
    expect(store.reads.every((read) => read.aggregateId === AGGREGATE_ID)).toBe(true)
    expect(store.reads.at(-1)).toEqual({ aggregateId: AGGREGATE_ID, afterPosition: 1 })
  })

  it("reopens from durable facts and deduplicates without replacing identity or timestamps", async () => {
    const store = createStore()
    const reader = asAsyncEventReadSurface(store)
    const original = await createProjectNotificationJournal({ reader, writer: store, sessionId: "session-1", now: () => 1_000 }).raise(warning)
    const reopened = createProjectNotificationJournal({ reader, writer: store, sessionId: "session-2", now: () => 9_000 })

    expect(await reopened.raise(warning)).toEqual(original)
    expect(reopened.projection().episodes).toEqual([original])
    expect(store.countByAggregate(AGGREGATE_ID)).toBe(1)
    expect(await reopened.activeSourceIds()).toEqual(new Set([warning.sourceId]))
  })

  it("starts a new occurrence only after authoritative resolution, including after restart", async () => {
    const store = createStore()
    let currentTime = 1_000
    const journal = createProjectNotificationJournal({ reader: asAsyncEventReadSurface(store), writer: store, sessionId: "session-1", now: () => currentTime })
    const first = await journal.raise(warning)

    currentTime = 2_000
    await journal.dismiss(warning.sourceId)
    expect(await journal.raise(warning)).toEqual({ ...first, dismissedAt: 2_000 })
    expect(store.countByAggregate(AGGREGATE_ID)).toBe(2)

    currentTime = 3_000
    await journal.resolve(warning.sourceId)
    currentTime = 4_000
    const reopened = createProjectNotificationJournal({ reader: asAsyncEventReadSurface(store), writer: store, sessionId: "session-2", now: () => currentTime })
    const recurring = await reopened.raise(warning)

    expect(recurring.id).not.toBe(first.id)
    expect(recurring.createdAt).toBe(4_000)
    expect(recurring.dismissedAt).toBeUndefined()
    expect(reopened.projection().episodes).toHaveLength(2)
    expect(store.countByAggregate(AGGREGATE_ID)).toBe(4)
  })

  it("keeps an immediately resolved notification visible across restart until dismissed", async () => {
    const store = createStore()
    const reader = asAsyncEventReadSurface(store)
    const journal = createProjectNotificationJournal({ reader, writer: store, sessionId: "session-1", now: () => 1_000 })
    const raised = await journal.raise(warning)
    await journal.resolve(warning.sourceId)
    const reopened = createProjectNotificationJournal({ reader, writer: store, sessionId: "session-2", now: () => 2_000 })
    await reopened.reconcile()
    expect(reopened.projection().visible).toEqual([{ ...raised, resolvedAt: 1_000 }])
    await reopened.dismiss(raised.sourceId, raised.id)
    expect(reopened.projection().visible).toEqual([])
  })

  it("appends independent resolution and dismissal facts and rejects wrong targets", async () => {
    const store = createStore()
    const journal = createProjectNotificationJournal({ reader: asAsyncEventReadSurface(store), writer: store, sessionId: "session-1", now: () => 1_000 })
    await journal.raise(warning)

    await journal.resolve(warning.sourceId)
    await journal.dismiss(warning.sourceId)

    expect(store.countByAggregate(AGGREGATE_ID)).toBe(3)
    await expect(journal.resolve("missing")).rejects.toThrow("Unknown project notification source: missing")
  })
})
