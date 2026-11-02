import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { asAsyncEventReadSurface, type AsyncEventStateReadSurface, type LocalSqliteEventStore, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { advanceWorkflowMemberTotals, readHeldWorkflowMemberTotals, readWorkflowMemberTotals, readWorkflowUsage } from "../../../../src/orchestration/workflow-host/member-totals.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
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

  it("shares one filtered catch-up across held workflows without loading tool content", async () => {
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
        expect(counted.rows).toHaveLength(0)
        store.append({ aggregateId: "session:m0", sessionId: "m0", type: "model.requested", version: 1, actor: "agent", timestamp: 1000, payload: {} })
        for (let index = 0; index < workflows; index++) await readWorkflowUsage(counted.reader, `wf-${index}`)
        expect(counted.rows).toHaveLength(0)
        append(store, usageV4Fact(0, "held-0", "changed"))
        for (let index = 0; index < workflows; index++) {
          const usage = await readWorkflowUsage(counted.reader, `wf-${index}`)
          expect(usage.display.totalCost).toBe(index === 0 ? 4 : 2)
        }
        expect(counted.contentModes.every(mode => mode === "deferred")).toBe(true)
        return counted.rows.length
      } finally { store.close() }
    }
    expect(await rowsPerChange(2)).toBe(1)
    expect(await rowsPerChange(20)).toBe(1)
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
  it("reads only what changed after each usage entry, whatever the member count", async () => {
    const readsPerChange = async (members: number) => {
      const store = workflowWithMembers(members)
      try {
        const { reads, reader } = countingReader(asAsyncEventReadSurface(store))
        await readWorkflowUsage(reader, "wf")
        const perChange: number[] = []
        for (let change = 0; change < 10; change++) {
          append(store, usageV4Fact(0, `m${change % members}`, `change-${change}`))
          reads.length = 0
          const usage = await readWorkflowUsage(reader, "wf")
          perChange.push(reads.length)
          expect(usage.display.totalCost).toBe((members + change + 1) * 2)
          expect(usage.policy.totalInputTokens).toBe((members + change + 1) * 100)
        }
        return perChange
      } finally {
        store.close()
      }
    }
    // Eighty members exceeds the sixty-four projections the registry holds per family.
    expect(await readsPerChange(80)).toEqual(await readsPerChange(4))
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
