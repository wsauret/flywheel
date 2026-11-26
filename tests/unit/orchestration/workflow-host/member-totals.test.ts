import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { asAsyncEventReadSurface, type AsyncEventStateReadSurface, type LocalSqliteEventStore, type StoredFact } from "../../../../src/infra/substrate/store/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/platform/files/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/substrate/store/sqlite-event-store.js"
import { advanceWorkflowMemberTotals, readHeldWorkflowMemberTotals, readWorkflowMemberEvidence, readWorkflowMemberTotals, readWorkflowUsage } from "../../../../src/orchestration/workflow-host/member-totals.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { countStateRequests } from "../../../helpers/state-requests.js"
import { createdFact, memberCreated, usageV4Fact } from "../../../fixtures/session-summary-history.js"

const temporary = temporaryDirectories()

/** Every durable read through `reader`, by aggregate, or `*` for a read across aggregates. */
function countingReader(reader: AsyncEventStateReadSurface) {
  const reads: string[] = []
  const rows: StoredFact[] = []
  const contentModes: (string | undefined)[] = []
  return {
    reads, rows, contentModes,
    reader: {
      ...reader,
      readSlice: (query, tolerant) => { reads.push(query.aggregateId ?? "*"); return reader.readSlice(query, tolerant) },
      readPage: async (query, upper, after, tolerant, content) => {
        reads.push(query.aggregateId ?? "*")
        contentModes.push(content)
        const page = await reader.readPage(query, upper, after, tolerant, content)
        rows.push(...page.facts.filter((fact): fact is StoredFact => !(fact instanceof Error)))
        return page
      },
      readLatestByAggregateAndTypes: (aggregateId, types) => { reads.push(aggregateId); return reader.readLatestByAggregateAndTypes(aggregateId, types) },
    } satisfies AsyncEventStateReadSurface,
  }
}

function append(store: LocalSqliteEventStore, { position: _position, id: _id, seq: _seq, ...fact }: StoredFact): void {
  store.append(fact)
}

/** A workflow `wf` launched from chat `chat`, with `members` agents that each committed one usage entry. */
function workflowWithMembers(members: number) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(temporary("workflow-usage-")))
  append(store, createdFact(0, "chat", "chat"))
  for (let index = 0; index < members; index++) {
    append(store, memberCreated(`m${index}`, "wf", "chat"))
    append(store, usageV4Fact(0, `m${index}`, `m${index}-initial`))
  }
  return store
}

describe("readWorkflowUsage", () => {
  it("seeds all members with a fixed number of store reads", async () => {
    const coldReads = async (members: number) => {
      const store = workflowWithMembers(members)
      try {
        const counted = countingReader(asAsyncEventReadSurface(store))
        const totals = await readWorkflowMemberTotals(counted.reader, "wf")
        expect(totals.policy.totalCost).toBe(members * 2)
        expect(totals.display.totalInputTokens).toBe(members * 100)
        return counted.reads.length
      } finally { store.close() }
    }
    expect(await coldReads(20)).toBe(await coldReads(2))
  })

  it("reads each committed fact once across held workflows without loading tool content", async () => {
    const rowsPerChange = async (workflows: number) => {
      const store = workflowWithMembers(1)
      try {
        for (let index = 0; index < workflows; index++) {
          append(store, memberCreated(`held-${index}`, `wf-${index}`, "chat"))
          append(store, usageV4Fact(0, `held-${index}`, `initial-${index}`))
        }
        const counted = countingReader(asAsyncEventReadSurface(store))
        for (let index = 0; index < workflows; index++) await readWorkflowUsage(counted.reader, `wf-${index}`)
        counted.rows.length = 0
        counted.contentModes.length = 0
        append(store, usageV4Fact(0, "m0", "unrelated"))
        for (let index = 0; index < workflows; index++) await readWorkflowUsage(counted.reader, `wf-${index}`)
        store.append({ aggregateId: "session:m0", sessionId: "m0", type: "model.requested", version: 1, actor: "agent", timestamp: 1000, payload: {} })
        for (let index = 0; index < workflows; index++) await readWorkflowUsage(counted.reader, `wf-${index}`)
        append(store, usageV4Fact(0, "held-0", "changed"))
        for (let index = 0; index < workflows; index++) {
          const usage = await readWorkflowUsage(counted.reader, `wf-${index}`)
          expect(usage.display.totalCost).toBe(index === 0 ? 4 : 2)
        }
        expect(counted.contentModes.every(mode => mode === "deferred")).toBe(true)
        return counted.rows.length
      } finally { store.close() }
    }
    // The three facts committed after the seed, each read once whatever the
    // number of held workflows, including the two that no held workflow owns.
    expect(await rowsPerChange(2)).toBe(3)
    expect(await rowsPerChange(20)).toBe(3)
  })
  it("reads no store fact while it holds no workflow, and a later first read still counts every member", async () => {
    const store = workflowWithMembers(3)
    try {
      const counted = countingReader(asAsyncEventReadSurface(store))
      expect(await readHeldWorkflowMemberTotals(counted.reader, "wf")).toBeUndefined()
      append(store, memberCreated("m3", "wf", "chat"))
      append(store, usageV4Fact(0, "m3", "late"))
      expect(await advanceWorkflowMemberTotals(counted.reader)).toEqual([])
      expect(counted.reads).toEqual([])
      expect((await readWorkflowUsage(counted.reader, "wf")).display.totalCost).toBe(8)
      expect((await readHeldWorkflowMemberTotals(counted.reader, "wf"))?.display.totalCost).toBe(8)
    } finally { store.close() }
  })
  it("retains usage movement observed by a totals read until one notification consumes it", async () => {
    const store = workflowWithMembers(1)
    try {
      append(store, memberCreated("other", "other-wf", "chat"))
      const reader = asAsyncEventReadSurface(store)
      await readWorkflowUsage(reader, "wf")
      await readWorkflowUsage(reader, "other-wf")
      append(store, usageV4Fact(0, "m0", "changed"))
      expect((await readWorkflowUsage(reader, "wf")).display.totalCost).toBe(4)
      expect(await advanceWorkflowMemberTotals(reader)).toEqual(["wf"])
      expect(await advanceWorkflowMemberTotals(reader)).toEqual([])
    } finally { store.close() }
  })

  it.each(["{", "{}"])("isolates an unreadable budget row (%s) to its workflow while healthy totals advance", async (payload) => {
    const root = temporary("workflow-corrupt-usage-")
    const file = resolveEventStoreDbFile(root)
    const store = createSqliteEventStore(file)
    try {
      append(store, createdFact(0, "chat", "chat"))
      for (const id of ["damaged", "healthy"]) {
        append(store, memberCreated(id, `wf-${id}`, "chat"))
        append(store, usageV4Fact(0, id, "initial"))
      }
      const counted = countingReader(asAsyncEventReadSurface(store))
      for (const id of ["damaged", "healthy"]) await readWorkflowUsage(counted.reader, `wf-${id}`)
      append(store, usageV4Fact(0, "damaged", "before-damage"))
      append(store, usageV4Fact(0, "damaged", "unreadable"))
      const db = new Database(file)
      try {
        db.run("UPDATE event SET payload = ? WHERE aggregate_id = ? AND type = ? AND position = (SELECT MAX(position) FROM event)", [payload, "session:damaged", "model.usage.measured"])
      } finally { db.close() }
      append(store, usageV4Fact(0, "healthy", "changed", 7))
      expect((await readWorkflowUsage(counted.reader, "wf-healthy")).display.totalCost).toBe(9)
      await expect(readWorkflowUsage(counted.reader, "wf-damaged")).rejects.toThrow()
      expect(await advanceWorkflowMemberTotals(counted.reader)).toEqual(["wf-healthy"])
      counted.rows.length = 0
      append(store, usageV4Fact(0, "healthy", "later", 3))
      expect((await readWorkflowUsage(counted.reader, "wf-healthy")).display.totalCost).toBe(12)
      expect(counted.rows).toHaveLength(1)
      await expect(readWorkflowMemberTotals(counted.reader, "wf-damaged")).rejects.toThrow()
      // Deleting another member rebuilds the damaged workflow, which rereads its unreadable row.
      append(store, memberCreated("damaged-2", "wf-damaged", "chat"))
      store.append({ aggregateId: "session:damaged-2", sessionId: "damaged-2", type: "session.deleted", version: 1, actor: "flywheel", timestamp: 1, payload: { lastUpdated: "2026-01-01T00:00:00.000Z" } })
      append(store, usageV4Fact(0, "healthy", "after-rebuild", 5))
      expect((await readWorkflowUsage(counted.reader, "wf-healthy")).display.totalCost).toBe(17)
      await expect(readWorkflowUsage(counted.reader, "wf-damaged")).rejects.toThrow()
    } finally { store.close() }
  })
  it("issues the same state requests per advance whatever the number of member owners", async () => {
    const requestsPerAdvance = async (members: number) => {
      const store = workflowWithMembers(members)
      try {
        const counter = countStateRequests(asAsyncEventReadSurface(store))
        await readWorkflowUsage(counter.reader, "wf")
        counter.take()
        const perAdvance: unknown[] = []
        for (let change = 0; change < 10; change++) {
          append(store, usageV4Fact(0, `m${change % members}`, `change-${change}`))
          const usage = await readWorkflowUsage(counter.reader, "wf")
          perAdvance.push(counter.take().map(({ method, query, facts }) => ({ method, query, facts })))
          expect(usage.display.totalCost).toBe((members + change + 1) * 2)
          expect(usage.policy.totalInputTokens).toBe((members + change + 1) * 100)
        }
        return perAdvance
      } finally {
        store.close()
      }
    }
    // Two hundred members exceeds the sixty-four projections the registry holds per family.
    expect(await requestsPerAdvance(200)).toEqual(await requestsPerAdvance(2))
  })

  it("advances to the totals that a full fold reads after interleaved facts of three members", async () => {
    const store = workflowWithMembers(3)
    try {
      append(store, createdFact(0, "outsider", "subagent", "chat"))
      const call = (sessionId: string, toolUseId: string) => store.append({
        aggregateId: `session:${sessionId}`, sessionId, type: "tool.input.completed", version: 1, actor: "agent", timestamp: 2,
        payload: { toolUseId, toolName: "read", input: {}, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false },
      })
      const duration = (sessionId: string, accumulatedActiveMs: number) => store.append({ aggregateId: `session:${sessionId}`, sessionId, type: "session.duration.recorded", version: 1, actor: "flywheel", timestamp: 3, payload: { accumulatedActiveMs } })
      const advanced = asAsyncEventReadSurface(store)
      await readWorkflowMemberTotals(advanced, "wf")
      const steps = [
        () => { call("m0", "a"); append(store, usageV4Fact(0, "outsider", "o1", 11)); call("m2", "b") },
        () => { append(store, usageV4Fact(0, "m1", "u1", 5)); call("outsider", "c"); duration("m0", 1_000) },
        () => { duration("m2", 2_000); append(store, usageV4Fact(0, "m0", "u2", 3)); call("m1", "d"); duration("outsider", 9_000) },
      ]
      for (const step of steps) {
        step()
        await readWorkflowMemberTotals(advanced, "wf")
      }
      const figures = async (reader: typeof advanced) => {
        const totals = await readWorkflowMemberTotals(reader, "wf")
        return { policy: totals.policy, display: totals.display, toolCount: totals.toolCount, durations: [...totals.durations.bySession].sort(), evidence: await readWorkflowMemberEvidence(reader, "wf") }
      }
      const full = await figures(asAsyncEventReadSurface(store))
      expect(full).toMatchObject({ policy: { totalCost: 14 }, toolCount: 3, durations: [["m0", 1_000], ["m2", 2_000]] })
      expect(await figures(advanced)).toEqual(full)
    } finally {
      store.close()
    }
  })

  it("counts an agent that joins after the first read, and its usage", async () => {
    const store = workflowWithMembers(2)
    try {
      const reader = asAsyncEventReadSurface(store)
      expect((await readWorkflowUsage(reader, "wf")).policy.totalCost).toBe(4)
      append(store, memberCreated("late", "wf", "chat"))
      append(store, usageV4Fact(0, "late", "late-initial", 5))
      expect((await readWorkflowUsage(reader, "wf")).policy.totalCost).toBe(9)
    } finally {
      store.close()
    }
  })

  it("keeps usage known when a member's tool fact cannot be read", async () => {
    const store = workflowWithMembers(2)
    try {
      const reader = asAsyncEventReadSurface(store)
      const call = (toolUseId: string, payload: { readonly executionMode?: string } = {}) => store.append({
        aggregateId: "session:m0", sessionId: "m0", type: "tool.input.completed", version: 1, actor: "agent", timestamp: 1,
        payload: { toolUseId, toolName: "read", input: {}, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false, ...payload },
      })
      call("first")
      expect((await readWorkflowMemberTotals(reader, "wf")).toolCount).toBe(1)
      call("unreadable", { executionMode: "sideways" })
      await expect(readWorkflowMemberTotals(reader, "wf")).rejects.toThrow()
      expect((await readWorkflowUsage(reader, "wf")).display.totalCost).toBe(4)
      // A fold that seeds over the same fact keeps usage known too.
      const seeded = asAsyncEventReadSurface(store)
      await expect(readWorkflowMemberTotals(seeded, "wf")).rejects.toThrow()
      expect((await readWorkflowUsage(seeded, "wf")).display.totalCost).toBe(4)
    } finally {
      store.close()
    }
  })

  it("keeps a member's earlier time and known usage past a duration row this build cannot read", async () => {
    const store = workflowWithMembers(2)
    try {
      const duration = (version: number, accumulatedActiveMs: number) => store.append({ aggregateId: "session:m0", sessionId: "m0", type: "session.duration.recorded", version, actor: "flywheel", timestamp: 1, payload: { accumulatedActiveMs } })
      const reader = asAsyncEventReadSurface(store)
      duration(1, 5_000)
      expect((await readWorkflowMemberTotals(reader, "wf")).durations.bySession.get("m0")).toBe(5_000)
      // A newer build wrote this row.
      duration(99, 9_000)
      const advanced = await readWorkflowMemberTotals(reader, "wf")
      expect({ time: advanced.durations.bySession.get("m0"), cost: advanced.display.totalCost }).toEqual({ time: 5_000, cost: 4 })
      // A fold that seeds over the same rows keeps them too.
      const seeded = await readWorkflowMemberTotals(asAsyncEventReadSurface(store), "wf")
      expect({ time: seeded.durations.bySession.get("m0"), cost: seeded.display.totalCost }).toEqual({ time: 5_000, cost: 4 })
    } finally {
      store.close()
    }
  })

  it("stops counting a member after its session is deleted", async () => {
    const store = workflowWithMembers(3)
    try {
      const reader = asAsyncEventReadSurface(store)
      expect((await readWorkflowUsage(reader, "wf")).display.totalCost).toBe(6)
      store.append({ aggregateId: "session:m1", sessionId: "m1", type: "session.deleted", version: 1, actor: "flywheel", timestamp: 1, payload: { lastUpdated: "2026-01-01T00:00:00.000Z" } })
      expect((await readWorkflowUsage(reader, "wf")).display.totalCost).toBe(4)
    } finally {
      store.close()
    }
  })
})
