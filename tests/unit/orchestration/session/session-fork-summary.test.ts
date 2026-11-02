import { describe, expect, it, spyOn } from "bun:test"
import { asAsyncEventReadSurface, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { readForks } from "../../../../src/orchestration/session/session-fork-summary.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"

const temporary = temporaryDirectories()

function appendFork(store: LocalSqliteEventStore, targetSessionId: string, payload: { [key: string]: unknown } = {}): void {
  store.append({
    aggregateId: `session:${targetSessionId}`, sessionId: targetSessionId, type: "session.forked", version: 1, actor: "flywheel", timestamp: 1,
    payload: { sourceSessionId: "source", targetSessionId, selection: { kind: "active_branch" }, sourceEventPrefixPosition: 0, copiedEntryCount: 1, publishedAt: "2026-01-01T00:00:00.000Z", ...payload },
  })
}

describe("readForks", () => {
  it("reads only the facts committed since the last read, whatever the session count", async () => {
    const workPerChange = async (sessions: number) => {
      const store = createSqliteEventStore(resolveEventStoreDbFile(temporary("session-forks-")))
      try {
        const ids = Array.from({ length: sessions }, (_, index) => `s${index}`)
        for (const id of ids) appendFork(store, id)
        const { reader, take } = countStateRequests(asAsyncEventReadSurface(store))
        await readForks(ids, reader)
        const perChange: { requests: number; facts: number; indexedEntries: number }[] = []
        for (let change = 0; change < 2 * sessions; change++) {
          const id = `new-${change}`
          appendFork(store, id)
          const existing = ids[change % sessions]
          if (!existing) throw new Error("Missing existing fork target")
          store.append({
            aggregateId: `session:${existing}`, sessionId: existing, type: "model.usage.recorded", version: 1, actor: "provider", timestamp: change + 2,
            payload: { requestId: `r${change}`, conversationId: `conv-${existing}`, turn: change + 1, stepId: `step-${change}`, inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, reasoningTokens: 1, promptTokens: 15, deltaCostUsd: 0.02 },
          })
          take()
          let indexedEntries = 0
          const iterate = Map.prototype[Symbol.iterator]
          const traversal = spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (this: Map<unknown, unknown>) {
            const iterator = iterate.call(this)
            const advance = iterator.next.bind(iterator)
            iterator.next = () => {
              const entry = advance()
              if (!entry.done) indexedEntries++
              return entry
            }
            return iterator
          })
          try {
            const { forks } = await readForks([existing, id], reader)
            expect(forks[id]?.copiedEntryCount).toBe(1)
            expect(forks[existing]?.copiedEntryCount).toBe(1)
          } finally {
            traversal.mockRestore()
          }
          const requests = take()
          perChange.push({ requests: requests.length, facts: factsRead(requests), indexedEntries })
        }
        return perChange.slice(sessions)
      } finally {
        store.close()
      }
    }
    const few = await workPerChange(3)
    const many = await workPerChange(30)
    expect(new Set(many.map(({ requests }) => requests))).toEqual(new Set(few.map(({ requests }) => requests)))
    expect(Math.max(...many.map(({ facts }) => facts))).toBe(1)
    expect(Math.max(...many.map(({ indexedEntries }) => indexedEntries))).toBeLessThanOrEqual(Math.max(...few.map(({ indexedEntries }) => indexedEntries)))
  })

  it("scopes an unreadable fork fact to the session that holds it", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(temporary("session-forks-")))
    try {
      appendFork(store, "good")
      appendFork(store, "bad", { copiedEntryCount: -1 })
      const { forks, errors } = await readForks(["good", "bad"], asAsyncEventReadSurface(store))
      expect(Object.keys(forks)).toEqual(["good"])
      expect(errors.map(({ sessionId, scope }) => ({ sessionId, scope }))).toEqual([{ sessionId: "bad", scope: "fork" }])
    } finally {
      store.close()
    }
  })
})
