import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { CorruptEventRowError, type FactQuery } from "../../../src/infra/event-store-types.js"
import { createSqliteEventReadSurface } from "../../../src/infra/sqlite-event-read-surface.js"
import { createSqliteEventInserter } from "../../../src/infra/sqlite-event-store-core.js"
import { inMemoryEventReader } from "../../helpers/in-memory-event-reader.js"

let db: Database
let reader: ReturnType<typeof createSqliteEventReadSurface>

interface SqlParameters { [name: string]: string | number }

beforeEach(() => {
  db = new Database(":memory:")
  const writer = createSqliteEventInserter(db)
  writer.insertEventRows([
    { sessionId: "one", aggregateId: "conversation:alpha", type: "wanted" },
    { sessionId: "two", aggregateId: "conversation:other", type: "wanted" },
    { sessionId: "one", aggregateId: "conversation:beta", type: "other" },
    { sessionId: "one", aggregateId: "conversation:alpha", type: "wanted" },
    { sessionId: "one", aggregateId: "conversation:beta", type: "wanted" },
  ].map((fact, index) => ({ ...fact, id: `event-${index}`, version: 1, timestamp: index, actor: "test", payload: {} })))
  reader = createSqliteEventReadSurface(db)
})

afterEach(() => db.close())

const cases: Array<{ query: FactQuery; positions: number[] }> = [
  { query: {}, positions: [1, 2, 3, 4, 5] },
  { query: { sessionId: "one" }, positions: [1, 3, 4, 5] },
  { query: { sessionId: "one", types: ["wanted"], afterPosition: 1 }, positions: [4, 5] },
  { query: { sessionId: "one", aggregateId: "conversation:other" }, positions: [] },
  { query: { positions: [5, 1, 5, 99] }, positions: [1, 5] },
  { query: { positions: [] }, positions: [] },
  { query: { positions: [1, 2, 3, 4], sessionId: "one", types: ["wanted"], afterPosition: 1 }, positions: [4] },
  { query: { order: "desc", limit: 2 }, positions: [5, 4] },
  { query: { order: "asc", limit: 2 }, positions: [1, 2] },
  { query: { limit: 0 }, positions: [] },
  { query: { limit: 99 }, positions: [1, 2, 3, 4, 5] },
  { query: { aggregateId: "conversation:alpha", fromSeq: 1, order: "desc", limit: 1 }, positions: [4] },
  { query: { aggregateIds: ["conversation:beta", "conversation:alpha"], types: ["wanted"] }, positions: [1, 4, 5] },
  { query: { aggregateIds: ["conversation:beta", "conversation:other"], types: ["wanted", "other"], afterPosition: 2, limit: 1 }, positions: [3] },
  { query: { aggregateIds: [], types: ["wanted"] }, positions: [] },
  { query: { aggregateIds: ["conversation:alpha", "conversation:beta", "conversation:alpha"], types: ["wanted"], order: "desc", limitPerAggregate: 1 }, positions: [5, 4] },
  { query: { aggregateIds: ["conversation:beta", "conversation:alpha"], types: ["wanted", "other"], limitPerAggregate: 1 }, positions: [1, 3] },
  { query: { aggregateIds: ["conversation:beta", "conversation:alpha"], types: ["wanted", "other"], afterPosition: 1, limitPerAggregate: 1 }, positions: [3, 4] },
  { query: { aggregateIds: ["conversation:alpha", "conversation:beta", "conversation:other"], types: ["wanted"], order: "desc", limitPerAggregate: 2, limit: 3 }, positions: [5, 4, 2] },
  { query: { aggregateIds: ["conversation:alpha"], types: ["wanted"], limitPerAggregate: 0 }, positions: [] },
  { query: { aggregatePrefix: "conversation:" }, positions: [1, 2, 3, 4, 5] },
  { query: { aggregatePrefix: "workflow:" }, positions: [] },
  { query: { aggregatePrefix: "conversation:", afterPosition: 2, limit: 1 }, positions: [3] },
]

test.each(cases)("strict, tolerant, and in-memory reads honor $query", ({ query, positions }) => {
  const memory = inMemoryEventReader(reader.read())
  expect(reader.read(query).map((fact) => fact.position)).toEqual(positions)
  expect(reader.readTolerant(query).map((fact) => fact.position)).toEqual(positions)
  expect(memory.read(query).map((fact) => fact.position)).toEqual(positions)
  expect(memory.readTolerant(query).map((fact) => fact.position)).toEqual(positions)
})

test("metadata selection and row limits precede corrupt payload decoding", () => {
  db.run("update event set payload = '{{broken' where position in (1, 2, 3)")
  for (const query of [
    { sessionId: "one", types: ["wanted"], afterPosition: 1 },
    { positions: [4, 5] },
    { aggregateId: "conversation:alpha", order: "desc", limit: 1 },
    { order: "desc", limit: 2 },
    { limit: 0 },
    { positions: [] },
  ] satisfies FactQuery[]) {
    expect(reader.readTolerant(query)).toEqual(reader.read(query))
  }
  expect(() => reader.read({ positions: [1] })).toThrow(CorruptEventRowError)
  const rows = reader.readTolerant({ positions: [1, 5], order: "desc", limit: 2 })
  expect(rows.map((row) => row.position)).toEqual([5, 1])
  expect(rows[1]).toBeInstanceOf(CorruptEventRowError)
})

test("bounded queries use the existing rowid, aggregate, type, and session indexes in position order", () => {
  const family = { $aggregatePrefix: "conversation:", $aggregatePrefixEnd: "conversation;" }
  const probes: Array<{ query: FactQuery; parameters: SqlParameters; plan: string[]; order: string }> = [
    { query: { positions: [4], sessionId: "one", types: ["wanted"] }, parameters: { $n0: 4, $sessionId: "one", $t0: "wanted" }, plan: ["INTEGER PRIMARY KEY"], order: "position asc" },
    { query: { sessionId: "one", types: ["wanted"], order: "desc", limit: 1 }, parameters: { $sessionId: "one", $t0: "wanted", $limit: 1 }, plan: ["event_session_idx"], order: "position desc" },
    { query: { aggregateId: "conversation:alpha", sessionId: "one", types: ["wanted"] }, parameters: { $aggregateId: "conversation:alpha", $sessionId: "one", $t0: "wanted" }, plan: ["event_aggregate_type_position_idx"], order: "position asc" },
    { query: { aggregateId: "conversation:alpha", fromSeq: 1, order: "desc", limit: 1 }, parameters: { $aggregateId: "conversation:alpha", $seq: 1, $limit: 1 }, plan: ["sqlite_autoindex_event_2"], order: "seq desc" },
    // One aggregate's catch-up seeks its own new rows.
    { query: { aggregateId: "conversation:alpha", afterPosition: 2 }, parameters: { $aggregateId: "conversation:alpha", $position: 2 }, plan: ["event_aggregate_position_idx (aggregate_id=? AND position>?)"], order: "position asc" },
    // A typed family read merges one ordered seek for each type, cold or advancing.
    { query: { aggregatePrefix: "conversation:", types: ["wanted", "other"] }, parameters: { ...family, $t0: "wanted", $t1: "other" }, plan: ["MERGE (UNION ALL)", "event_type_idx (type=?)"], order: "position asc" },
    { query: { aggregatePrefix: "conversation:", types: ["wanted", "other"], afterPosition: 2 }, parameters: { ...family, $t0: "wanted", $t1: "other", $position: 2 }, plan: ["MERGE (UNION ALL)", "event_type_idx (type=? AND position>?)"], order: "position asc" },
    // An untyped family read walks the rows committed after its cursor.
    { query: { aggregatePrefix: "conversation:", afterPosition: 2 }, parameters: { ...family, $position: 2 }, plan: ["INTEGER PRIMARY KEY (rowid>?)"], order: "position asc" },
  ]
  for (const probe of probes) {
    const query = spyOn(db, "query")
    reader.read(probe.query)
    const sql = query.mock.calls.at(-1)?.[0]
    query.mockRestore()
    if (typeof sql !== "string") throw new Error("Expected a cached SQLite query")
    expect(sql).toContain(`order by ${probe.order}`)
    const plan = db.query<{ detail: string }, [SqlParameters]>(`explain query plan ${sql}`).all(probe.parameters).map((row) => row.detail).join("\n")
    for (const step of probe.plan) expect(plan).toContain(step)
    expect(plan).not.toContain("TEMP B-TREE")
  }
})

test("a per-aggregate bound seeks each aggregate's newest rows and never scans its history", () => {
  const query = spyOn(db, "query")
  reader.read({ aggregateIds: ["conversation:alpha", "conversation:beta"], types: ["wanted", "other"], order: "desc", limitPerAggregate: 2, limit: 4 })
  const sql = query.mock.calls.at(-1)?.[0]
  query.mockRestore()
  if (typeof sql !== "string") throw new Error("Expected a cached SQLite query")
  const parameters = { $a0: "conversation:alpha", $a1: "conversation:beta", $t0: "wanted", $t1: "other", $limitPerAggregate: 2, $limit: 4 }
  const plan = db.query<{ detail: string }, [SqlParameters]>(`explain query plan ${sql}`).all(parameters).map((row) => row.detail)
  // Two aggregates with two types each: four ordered seeks, each stopped by
  // its aggregate's bound. Only the bounded rows are sorted.
  expect(plan.filter((step) => step === "SEARCH event USING INDEX event_aggregate_type_position_idx (aggregate_id=? AND type=?)")).toHaveLength(4)
  expect(plan.filter((step) => step.startsWith("SCAN event"))).toEqual([])
  expect(() => reader.read({ types: ["wanted"], limitPerAggregate: 1 })).toThrow("FactQuery.limitPerAggregate requires aggregateIds")
  expect(() => reader.read({ aggregateIds: ["session:alpha"], limitPerAggregate: 1 })).toThrow("FactQuery.limitPerAggregate requires types")
})

test("a family read names no aggregate", () => {
  expect(() => reader.read({ aggregateId: "conversation:alpha", aggregatePrefix: "conversation:" })).toThrow("FactQuery.aggregatePrefix excludes aggregateId")
})
