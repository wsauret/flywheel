import { invalidateSupersededQueueFacts } from "../../../../src/orchestration/modules/workflows/queue-maintenance.js"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { EventStore } from "../../../../src/infra/event-store-types"
import type { ToolContentRow } from "../../../../src/infra/tool-content"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { buildSessionContent, type SessionContentNodeRow } from "../../../../src/infra/session-content"
import {
  RETIRED_FACT_TYPES,
  dropRetiredEventStoreIndexes,
  pruneRetiredFactFamilies,
  pruneSupersededFacts,
  readEventStoreMaintenanceStats,
  readEventStoreSizeStats,
  shouldVacuum,
  vacuumEventStore,
} from "../../../../src/orchestration/session/event-store-maintenance"

interface EventPayload {
  [key: string]: unknown
}
let tmpDir: string
let store: EventStore
let dbPath: string

const DURABLE_TYPES = ["chat.entries.appended", "tool.result.recorded", "workflow.control.committed", "model.usage.measured"] as const

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "flywheel-event-maintenance-"))
  dbPath = resolveEventStoreDbFile(tmpDir)
  store = createSqliteEventStore(dbPath)
})

afterEach(() => {
  store.close()
  rmSync(tmpDir, { recursive: true, force: true })
})


describe("retired index retirement", () => {
  test("drops retired indexes once and no-ops when they are absent", () => {
    const db = new Database(dbPath)
    db.exec("create index event_stream_request_position_idx on event(type, json_extract(payload, '$.requestId'), position) where type in ('model.stream.started', 'model.stream.event_observed', 'model.stream.completed', 'model.stream.summary.recorded')")
    db.exec("create index event_parent_tool_fact_idx on event(aggregate_id, json_extract(payload, '$.parentToolUseId'), type, position) where type in ('tool.input.completed', 'tool.result.recorded', 'tool.execution_output.recorded', 'tool.result.acknowledged', 'tool.validation.failed')")
    db.close()

    expect(dropRetiredEventStoreIndexes(dbPath)).toEqual(["event_stream_request_position_idx", "event_parent_tool_fact_idx"])
    expect(dropRetiredEventStoreIndexes(dbPath)).toEqual([])

    const readback = new Database(dbPath, { readonly: true })
    try {
      const names = readback.query<{ name: string }, []>("select name from sqlite_master where type = 'index' and tbl_name = 'event'").all().map((row) => row.name)
      expect(names).not.toContain("event_stream_request_position_idx")
      expect(names).not.toContain("event_parent_tool_fact_idx")
      expect(names).toContain("event_aggregate_type_position_idx")
    } finally {
      readback.close()
    }
  })
})

describe("retired-family prune", () => {
  test("deletes every retired-family row across sessions and keeps every durable row", async () => {
    for (const type of RETIRED_FACT_TYPES) {
      append("prune-a", type, 1, "flywheel", 1_000, { marker: type })
      append("prune-b", type, 1, "flywheel", 2_000, { marker: type })
    }
    for (const type of DURABLE_TYPES) {
      append("prune-a", type, 1, "flywheel", 3_000, durablePayload(type))
    }

    const stats = readEventStoreMaintenanceStats(dbPath)
    expect(stats.retiredRowCount).toBe(RETIRED_FACT_TYPES.length * 2)
    expect(stats.retiredPayloadBytes).toBeGreaterThan(0)

    const result = await pruneRetiredFactFamilies(dbPath)

    expect(result.storeFound).toBe(true)
    expect(result.rowsDeleted).toBe(RETIRED_FACT_TYPES.length * 2)
    expect(result.deletedByType.map((family) => family.type).sort()).toEqual([...RETIRED_FACT_TYPES].sort())
    for (const family of result.deletedByType) expect(family.count).toBe(2)

    const remainingA = store.read({ aggregateId: "session:prune-a" }).map((event) => event.type).sort()
    expect(remainingA).toEqual([...DURABLE_TYPES].sort())
    expect(store.read({ aggregateId: "session:prune-b" })).toEqual([])
    expect(readEventStoreMaintenanceStats(dbPath).retiredRowCount).toBe(0)
  })

  test("is idempotent: a second run deletes nothing", async () => {
    for (const type of RETIRED_FACT_TYPES) append("prune-twice", type, 1, "flywheel", 1_000, {})
    append("prune-twice", "chat.entries.appended", 1, "flywheel", 2_000, durablePayload("chat.entries.appended"))

    expect((await pruneRetiredFactFamilies(dbPath)).rowsDeleted).toBe(RETIRED_FACT_TYPES.length)

    const second = await pruneRetiredFactFamilies(dbPath)
    expect(second).toMatchObject({ storeFound: true, rowsDeleted: 0, payloadBytesDeleted: 0, deletedByType: [] })
    expect(store.read({ aggregateId: "session:prune-twice" }).map((event) => event.type)).toEqual(["chat.entries.appended"])
  })

  test("deletes a family larger than one chunk, releasing the write lock between chunks", async () => {
    // One statement per chunk is the whole point of the sweep: a live runtime's
    // append waits out a chunk, never a family. 5001 rows means the last chunk
    // is short, which is also the loop's termination condition.
    const rows = 5_001
    const db = new Database(dbPath)
    try {
      db.exec("insert into event_sequence (aggregate_id, seq) values ('session:chunked', 0)")
      db.exec(`
        with recursive n(i) as (select 1 union all select i + 1 from n where i < ${rows})
        insert into event (id, aggregate_id, seq, type, version, timestamp, actor, session_id, payload)
        select 'chunk-' || i, 'session:chunked', i, 'model.stream.started', 1, 1000 + i, 'flywheel', 'chunked', '{}' from n
      `)
    } finally {
      db.close()
    }

    const result = await pruneRetiredFactFamilies(dbPath)

    expect(result.rowsDeleted).toBe(rows)
    expect(result.deletedByType).toEqual([{ type: "model.stream.started", count: rows, payloadBytes: rows * 2 }])
    expect(readEventStoreMaintenanceStats(dbPath).retiredRowCount).toBe(0)
  })

  test("leaves reclaimable pages for the caller's separate, exclusive vacuum", async () => {
    const payload = JSON.stringify({ blob: "x".repeat(1024 * 1024) })
    const db = new Database(dbPath)
    try {
      // The fixture needs real allocated pages, not repeated host JSON encoding.
      db.transaction(() => {
        db.exec("insert into event_sequence (aggregate_id, seq) values ('session:prune-vacuum', 4)")
        db.query(`
          with recursive n(i) as (select 0 union all select i + 1 from n where i < 3)
          insert into event (id, aggregate_id, seq, type, version, timestamp, actor, session_id, payload)
          select 'vacuum-' || i, 'session:prune-vacuum', i + 1, 'model.stream.event_observed', 1,
            1000 + i, 'provider', 'prune-vacuum', $payload from n
        `).run({ $payload: payload })
      })()
    } finally {
      db.close()
    }
    const sizeBefore = readEventStoreMaintenanceStats(dbPath).dbFileSize

    const result = await pruneRetiredFactFamilies(dbPath)

    expect(result.rowsDeleted).toBe(4)
    const afterPrune = readEventStoreMaintenanceStats(dbPath)
    expect(afterPrune.dbFileSize).toBeGreaterThanOrEqual(sizeBefore * 0.9)
    expect(afterPrune.reclaimableBytes).toBeGreaterThan(0)

    const vacuum = vacuumEventStore(dbPath, { force: true })

    expect(vacuum.skippedReason).toBeUndefined()
    expect(vacuum.after).toBeDefined()
    expect(vacuum.after!.dbFileSize).toBeLessThan(sizeBefore / 2)
  })

  test("vacuum skips below the reclaim thresholds", async () => {
    append("prune-small", "model.stream.started", 1, "flywheel", 1_000, { small: true })

    expect((await pruneRetiredFactFamilies(dbPath)).rowsDeleted).toBe(1)
    expect(vacuumEventStore(dbPath)).toMatchObject({ storeFound: true, skippedReason: "below-threshold" })
  })

  test("shouldVacuum follows the standing thresholds", () => {
    const MiB = 1024 * 1024
    // Below the 64 MiB floor: never, regardless of ratio.
    expect(shouldVacuum({ dbFileSize: 64 * MiB, reclaimableBytes: 63 * MiB })).toBe(false)
    // Above the floor but under the 20% ratio: no.
    expect(shouldVacuum({ dbFileSize: 1024 * MiB, reclaimableBytes: 100 * MiB })).toBe(false)
    // Above the floor and at the ratio: yes.
    expect(shouldVacuum({ dbFileSize: 400 * MiB, reclaimableBytes: 80 * MiB })).toBe(true)
    // Above the 512 MiB absolute gate: always, even at a tiny ratio.
    expect(shouldVacuum({ dbFileSize: 100_000 * MiB, reclaimableBytes: 513 * MiB })).toBe(true)
  })
})

describe("event-store maintenance", () => {
  test("invalidates every queue fact in aggregates carrying superseded schema versions, and nothing else", () => {
    // Modern aggregate poisoned by a pre-v4 creation fact.
    appendTo("workflow:wf-old", "wf-old", "queue.created", 3, { queue: { supersededDescriptor: true } })
    appendTo("workflow:wf-old", "wf-old", "queue.state.changed", 1, { status: "completed", cursor: 1 })
    appendTo("workflow:wf-old", "wf-old", "workflow.control.initialized", 1, {})
    appendTo("workflow:wf-old", "wf-old", "attempt.succeeded", 2, { attemptId: "attempt", toolUses: 3 })
    // Legacy session-aggregate queue facts from the pre-workflow-aggregate era,
    // with two distinct superseded descriptors in one aggregate.
    appendTo("session:legacy", "legacy", "queue.created", 3, { queue: { supersededDescriptor: true } })
    appendTo("session:legacy", "legacy", "queue.mutated", 3, { mutation: { supersededDescriptor: true } })
    appendTo("session:legacy", "legacy", "chat.entries.appended", 1, durablePayload("chat.entries.appended"))
    // Healthy current-version queue stays untouched.
    appendTo("workflow:wf-current", "wf-current", "queue.created", 6, { queue: {} })

    const result = invalidateSupersededQueueFacts(dbPath)

    expect(result).toMatchObject({ storeFound: true, rowsDeleted: 4 })
    expect(result.invalidated.map((entry) => entry.aggregateId).sort()).toEqual(["session:legacy", "workflow:wf-old"])
    expect(result.invalidated.find((entry) => entry.aggregateId === "workflow:wf-old")).toMatchObject({
      supersededFacts: ["queue.created@3"],
      rowsDeleted: 2,
    })
    expect(result.invalidated.find((entry) => entry.aggregateId === "session:legacy")).toMatchObject({
      supersededFacts: ["queue.created@3", "queue.mutated@3"],
      rowsDeleted: 2,
    })
    // Non-queue facts survive in the affected aggregates; healthy queues survive whole.
    expect(store.read({ aggregateId: "workflow:wf-old" }).map((event) => event.type)).toEqual(["workflow.control.initialized", "attempt.succeeded"])
    expect(store.read({ aggregateId: "session:legacy" }).map((event) => event.type)).toEqual(["chat.entries.appended"])
    expect(store.read({ aggregateId: "workflow:wf-current" }).map((event) => event.type)).toEqual(["queue.created"])

    const second = invalidateSupersededQueueFacts(dbPath)
    expect(second).toMatchObject({ rowsDeleted: 0, invalidated: [] })
  })

  test("keeps queue facts a registered migration upgrades, so an unmigrated store loses nothing", () => {
    // A store that no Flywheel start has upgraded yet: v4 queue rows are history
    // in transit, and the queue-step-skill-id pass owns bringing them forward.
    appendTo("workflow:wf-pending", "wf-pending", "queue.created", 4, { queue: { supersededDescriptor: true } })
    appendTo("workflow:wf-pending", "wf-pending", "queue.mutated", 4, { mutation: { supersededDescriptor: true } })
    appendTo("workflow:wf-pending", "wf-pending", "queue.state.changed", 1, { status: "paused", cursor: 0 })
    // Rows that name a step seat by `skillId` are in transit too: the
    // step-row-content-id pass owns bringing them forward.
    appendTo("workflow:wf-seat", "wf-seat", "queue.created", 7, { queue: { supersededDescriptor: true } })
    appendTo("workflow:wf-seat", "wf-seat", "queue.mutated", 7, { mutation: { supersededDescriptor: true } })
    appendTo("workflow:wf-seat", "wf-seat", "queue.plan.changed", 1, { plan: { supersededDescriptor: true } })
    // Rows that name a loop body by `do` and `then` are in transit too: the
    // loop-body-rows pass owns bringing them forward.
    appendTo("workflow:wf-loop", "wf-loop", "queue.created", 8, { queue: { supersededDescriptor: true } })
    appendTo("workflow:wf-loop", "wf-loop", "queue.mutated", 8, { mutation: { supersededDescriptor: true } })
    // An unregistered version no migration upgrades still goes.
    appendTo("workflow:wf-gone", "wf-gone", "queue.created", 3, { queue: { supersededDescriptor: true } })

    const result = invalidateSupersededQueueFacts(dbPath)

    expect(result).toMatchObject({ storeFound: true, rowsDeleted: 1 })
    expect(result.upgradable).toEqual(["queue.created@4", "queue.created@7", "queue.created@8", "queue.mutated@4", "queue.mutated@7", "queue.mutated@8", "queue.plan.changed@1"])
    expect(result.invalidated.map((entry) => entry.aggregateId)).toEqual(["workflow:wf-gone"])
    expect(store.read({ aggregateId: "workflow:wf-pending" }).map((event) => event.type))
      .toEqual(["queue.created", "queue.mutated", "queue.state.changed"])
    expect(store.read({ aggregateId: "workflow:wf-seat" }).map((event) => `${event.type}@${event.version}`))
      .toEqual(["queue.created@7", "queue.mutated@7", "queue.plan.changed@1"])
    expect(store.read({ aggregateId: "workflow:wf-loop" }).map((event) => `${event.type}@${event.version}`))
      .toEqual(["queue.created@8", "queue.mutated@8"])
    expect(store.read({ aggregateId: "workflow:wf-gone" })).toEqual([])
  })
})

// The store's insert seam indexes committed chat entries for recall and throws
// on a malformed shape, so the durable seed must carry the real contract.
function durablePayload(type: (typeof DURABLE_TYPES)[number]): EventPayload {
  if (type === "chat.entries.appended") return { conversationId: "conv-1", entries: [] }
  return { marker: type }
}

function append(sessionId: string, type: string, version: number, actor: string, timestamp: number, payload: EventPayload): void {
  store.append({
    aggregateId: `session:${sessionId}`,
    type,
    version,
    timestamp,
    actor,
    sessionId,
    payload,
  })
}

function appendTo(aggregateId: string, sessionId: string, type: string, version: number, payload: EventPayload): void {
  store.append({
    aggregateId,
    type,
    version,
    timestamp: 1_000,
    actor: "flywheel",
    sessionId,
    payload,
  })
}

describe("superseded-fact prune", () => {
  test("converts a literal previous tool-content schema before collecting ordinary text", () => {
    const previous = join(tmpDir, "previous.sqlite")
    const db = new Database(previous)
    const kept = contentRow("referenced text")
    const removed = contentRow("unreferenced text")
    try {
      db.exec(`create table event (
        position integer primary key, id text, aggregate_id text, seq integer, type text, version integer,
        timestamp integer, actor text, session_id text, payload text not null
      );
      create table tool_content (
        session_id text not null, sha256 text not null, content text not null, bytes integer not null,
        primary key (session_id, sha256)
      )`)
      db.query("insert into event values (1, 'fact', 'session:s', 1, 'tool.result.recorded', 2, 1, 'flywheel', 's', ?1)")
        .run(JSON.stringify({ toolUseId: "tool", content: reference(kept) }))
      for (const row of [kept, removed]) db.query("insert into tool_content values ('s', ?1, ?2, ?3)").run(row.sha256, row.content, row.bytes)
    } finally { db.close() }
    expect(pruneSupersededFacts(previous)).toMatchObject({ contentRowsDeleted: 1, contentBytesDeleted: removed.bytes })
    expect(pruneSupersededFacts(previous)).toMatchObject({ rowsDeleted: 0, contentRowsDeleted: 0 })
    const reopened = new Database(previous, { readonly: true })
    try {
      expect(reopened.query("select content, session_content_node from tool_content").all()).toEqual([{ content: kept.content, session_content_node: 0 }])
    } finally { reopened.close() }
  })
  test("keeps the newest row per declared live value and every history row", () => {
    appendOutput("session-a", "call-1", "tail one")
    appendOutput("session-a", "call-2", "other call")
    appendOutput("session-a", "call-1", "settled")
    appendOutput("session-b", "call-1", "another session")
    appendTo("workflow:session-a", "session-a", "queue.state.changed", 1, { status: "running" })
    appendTo("workflow:session-a", "session-a", "queue.state.changed", 1, { status: "paused" })
    append("session-a", "tool.result.recorded", 1, "flywheel", 1_000, { marker: "first" })
    append("session-a", "tool.result.recorded", 1, "flywheel", 1_000, { marker: "second" })
    // Rows without the declared key name no live value, so none supersedes another.
    append("session-a", "file.reviewed", 1, "flywheel", 1_000, { marker: "unkeyed one" })
    append("session-a", "file.reviewed", 1, "flywheel", 1_000, { marker: "unkeyed two" })

    const result = pruneSupersededFacts(dbPath)

    expect(result.deletedByType.map((family) => [family.type, family.count])).toEqual([
      ["tool.execution_output.recorded", 1],
      ["queue.state.changed", 1],
    ])
    expect(payloads("tool.execution_output.recorded")).toEqual([
      { toolUseId: "call-2", output: "other call" },
      { toolUseId: "call-1", output: "settled" },
      { toolUseId: "call-1", output: "another session" },
    ])
    expect(payloads("queue.state.changed")).toEqual([{ status: "paused" }])
    expect(payloads("tool.result.recorded")).toHaveLength(2)
    expect(payloads("file.reviewed")).toHaveLength(2)
    expect(pruneSupersededFacts(dbPath).rowsDeleted).toBe(0)
  })

  test("deletes tool content only when no remaining fact of its session names it", () => {
    const tail = contentRow("running tail")
    const settled = contentRow("settled output")
    const shared = contentRow("shared text")
    appendOutput("session-a", "call-1", reference(tail), [tail])
    appendOutput("session-a", "call-1", reference(shared), [shared])
    appendOutput("session-a", "call-1", reference(settled), [settled])
    append("session-a", "tool.result.recorded", 2, "flywheel", 1_000, { toolUseId: "call-1", content: reference(shared) })
    // The same bytes in another session belong to that session alone.
    appendOutput("session-b", "call-9", reference(tail), [tail])

    const result = pruneSupersededFacts(dbPath)

    expect(result.rowsDeleted).toBe(2)
    expect(result.contentRowsDeleted).toBe(1)
    expect(result.contentBytesDeleted).toBe(tail.bytes)
    expect(storedContent()).toEqual([
      `session-a:${settled.sha256}`,
      `session-a:${shared.sha256}`,
      `session-b:${tail.sha256}`,
    ].sort())
  })

  test("keeps staged session content and indirect children while pruning ordinary unreferenced text", async () => {
    const nodes: SessionContentNodeRow[] = []
    const retained = await buildSessionContent("retained patch".repeat(10_000), async rows => { nodes.push(...rows) })
    const staged = await buildSessionContent("not yet settled", async rows => { nodes.push(...rows) })
    store.stageSessionContentNodes("session-a", nodes)
    append("session-a", "tool.result.recorded", 1, "flywheel", 1_000, { evidence: retained })
    const tail = contentRow("obsolete ordinary output")
    appendOutput("session-a", "call-1", reference(tail), [tail])
    appendOutput("session-a", "call-1", "settled")

    const result = pruneSupersededFacts(dbPath)

    expect(result.contentRowsDeleted).toBe(1)
    expect(result.contentBytesDeleted).toBe(tail.bytes)
    expect(storedContent()).toEqual(nodes.map(row => `session-a:${row.sha256}`).sort())
    expect(store.readSessionContentNode?.("session-a", staged.root)).not.toBeNull()
  })
})

function appendOutput(sessionId: string, toolUseId: string, output: unknown, contentRows?: ToolContentRow[]): void {
  store.append({
    aggregateId: `session:${sessionId}`,
    type: "tool.execution_output.recorded",
    version: typeof output === "string" ? 1 : 2,
    timestamp: 1_000,
    actor: "flywheel",
    sessionId,
    payload: { toolUseId, output },
    ...(contentRows ? { contentRows } : {}),
  })
}

function contentRow(text: string): ToolContentRow {
  const content = text.repeat(400)
  return { sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"), content, bytes: Buffer.byteLength(content) }
}

function reference(row: ToolContentRow): EventPayload {
  return { sha256: row.sha256, bytes: row.bytes, preview: row.content.slice(0, 20) }
}

function payloads(type: string): unknown[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.query<{ payload: string }, [string]>("select payload from event where type = ?1 order by position").all(type).map((row) => JSON.parse(row.payload))
  } finally {
    db.close()
  }
}

function storedContent(): string[] {
  const db = new Database(dbPath, { readonly: true })
  try {
    return db.query<{ key: string }, []>("select session_id || ':' || sha256 as key from tool_content").all().map((row) => row.key).sort()
  } finally {
    db.close()
  }
}

describe("startup maintenance store reads", () => {
  test("size stats read only the file and page headers, never event rows", () => {
    // A file with no event table: the row-summarizing read cannot run here,
    // while the size read has everything it needs.
    const bare = join(tmpDir, "bare.sqlite")
    const db = new Database(bare)
    db.exec("create table unrelated (value text)")
    db.close()

    expect(() => readEventStoreMaintenanceStats(bare)).toThrow()
    const stats = readEventStoreSizeStats(bare)
    expect(stats.storeFound).toBe(true)
    expect(stats.dbFileSize).toBeGreaterThan(0)
    expect(stats.pageSize).toBeGreaterThan(0)
    expect(stats.reclaimableBytes).toBe(0)
    expect(readEventStoreSizeStats(join(tmpDir, "absent.sqlite")).storeFound).toBe(false)
  })

  test("prune stops at the next chunk boundary once its signal is aborted", async () => {
    append("prune-withdrawn", "model.stream.started", 1, "flywheel", 1_000, { n: 1 })
    const controller = new AbortController()
    controller.abort(new Error("withdrawn"))

    await expect(pruneRetiredFactFamilies(dbPath, { signal: controller.signal })).rejects.toThrow("withdrawn")
    expect(readEventStoreMaintenanceStats(dbPath).retiredRowCount).toBe(1)
  })
})
