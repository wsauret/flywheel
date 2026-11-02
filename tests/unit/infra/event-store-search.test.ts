import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { Database, Statement } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { openEventSearch } from "../../../src/infra/event-store-search"
import type { StoredFact } from "../../../src/infra/event-store-types"
import { searchEvents, rowTimestamp, rowType } from "../../../src/infra/event-search"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../src/infra/paths"
import { extractContent } from "../../../src/infra/tool-content"
import * as debugLog from "../../../src/infra/debug-log"

const roots: string[] = []
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
  roots.length = 0
})

function workspace() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "event-store-search-"))
  roots.push(baseDir)
  const dbPath = resolveEventStoreDbFile(baseDir)
  return { baseDir, dbPath, store: createSqliteEventStore(dbPath) }
}

function append(
  store: ReturnType<typeof createSqliteEventStore>,
  timestamp: number,
  options: { type?: string; sessionId?: string; actor?: string; payload?: StoredFact["payload"] } = {},
) {
  return store.append({
    aggregateId: "search-test",
    type: options.type ?? "target.note",
    version: 1,
    timestamp,
    actor: options.actor ?? "actor",
    sessionId: options.sessionId ?? "session",
    payload: options.payload ?? { marker: `acquired-${timestamp}` },
  })
}

describe("incremental event-store search", () => {
  it("binds metadata predicates and timestamp ordering before acquiring only the requested rows", () => {
    const { baseDir, store } = workspace()
    for (let i = 0; i < 200; i++) append(store, 200 - i)
    append(store, 100, { type: "other.type" })
    append(store, 100, { sessionId: "other-session" })
    append(store, 100, { actor: "other-actor" })
    store.close()
    const querySpy = spyOn(Database.prototype, "query")
    const allSpy = spyOn(Statement.prototype, "all")
    const decodeSpy = spyOn(JSON, "parse")
    try {
      const matches = searchEvents({
        baseDir, sessionId: "session", actor: "actor", typePatterns: ["TARGET.NOTE"],
        sinceTimestamp: 50, untilTimestamp: 150, order: "desc", limit: 2,
      }).matches
      expect(matches.map(rowTimestamp)).toEqual([150, 149])
      const sql = querySpy.mock.calls.map(([text]) => text).find((text) => text.includes("order by timestamp"))
      expect(sql?.replace(/\s+/g, " ").trim()).toStartWith("select position, timestamp from event ")
      expect(sql).not.toContain("payload")
      expect(sql).not.toContain("*")
      expect(querySpy.mock.calls.map(([text]) => text)).toContain("select * from event where position = ?")
      expect(sql).toContain("session_id = $sessionId")
      expect(sql).toContain("actor = $actor")
      expect(sql).toContain("timestamp >= $sinceTimestamp")
      expect(sql).toContain("timestamp <= $untilTimestamp")
      expect(sql).toContain("type in ($patternType0)")
      expect(sql).toContain("order by timestamp desc, position desc")
      expect(sql).toContain("limit $limit")
      expect(sql).not.toContain("TARGET.NOTE")
      expect(allSpy).not.toHaveBeenCalled()
      expect(decodeSpy.mock.calls.filter(([text]) => text.includes("acquired-"))).toHaveLength(2)
    } finally {
      querySpy.mockRestore()
      allSpy.mockRestore()
      decodeSpy.mockRestore()
    }
  })

  it("iterates payload predicates until enough matches, without applying an early SQL limit", () => {
    const { baseDir, dbPath, store } = workspace()
    for (let i = 1; i <= 10; i++) append(store, i, { payload: { marker: `acquired-${i}`, requestId: i === 5 ? "wanted" : "other" } })
    store.close()
    const db = new Database(dbPath)
    db.run("update event set payload = 'malformed' where position = 6")
    db.close()
    const querySpy = spyOn(Database.prototype, "query")
    const decodeSpy = spyOn(JSON, "parse")
    try {
      expect(searchEvents({ baseDir, requestId: "wanted", pattern: "acquired", limit: 1 }).matches.map(rowTimestamp))
        .toEqual([5])
      const sql = querySpy.mock.calls.map(([text]) => text).find((text) => text.includes("order by timestamp"))
      expect(sql).not.toContain("limit")
      expect(decodeSpy.mock.calls.filter(([text]) => text.includes("acquired-"))).toHaveLength(5)
      expect(() => searchEvents({ baseDir, limit: 0 })).toThrow("corrupt event row")
      expect(() => searchEvents({ baseDir, requestId: "absent", limit: 1 })).toThrow("corrupt event row")
      expect(() => searchEvents({ baseDir, errorsOnly: true, limit: 1 })).toThrow("corrupt event row")
    } finally {
      querySpy.mockRestore()
      decodeSpy.mockRestore()
    }
  })

  it("preserves literal, glob, Unicode, and empty-pattern semantics through bound exact types", () => {
    const { dbPath, store } = workspace()
    const types = ["pre.TARGET.NOTE.post", "targetXnote", "a%_[b].note", "ÉVÉNEMENT.Note", "other.note"]
    for (const type of types) append(store, 1, { type })
    store.close()
    const connection = openEventSearch(dbPath)!
    try {
      const cases: [string[], string[]][] = [
        [["target.note"], [types[0]!]],
        [["*TARGET.NOTE*"], [types[0]!]],
        [["a%_[b].*"], [types[2]!]],
        [["événement"], [types[3]!]],
        [["*ÉVÉNEMENT.*", "other"], types.slice(3)],
        [["' OR 1=1 --"], []],
        [[""], types],
        [[], types],
      ]
      for (const [typePatterns, expected] of cases) {
        expect([...connection.scan({ typePatterns })].map((row) => row.type)).toEqual(expected)
      }
      expect([...connection.scan({ types: ["target.note"] })]).toEqual([])
      expect([...connection.scan({ types: [types[0]!] })].map((row) => row.type)).toEqual([types[0]!])
    } finally {
      connection.close()
    }
  })

  it("keeps position ranges inclusive and metadata envelopes independent of payload decoding", () => {
    const { dbPath, store } = workspace()
    append(store, 30)
    append(store, 10)
    append(store, 20)
    store.close()
    const db = new Database(dbPath)
    db.run("update event set payload = '[]' where position = 2")
    db.close()
    const connection = openEventSearch(dbPath)!
    try {
      expect(connection.timestampRange({ positionRange: { start: 1, end: 3 } }))
        .toEqual({ sinceTimestamp: 10, untilTimestamp: 30 })
      expect(connection.timestampRange({ positionRange: { start: 90, end: 99 } })).toBeNull()
      expect([...connection.scan({ afterPosition: 2 })].map((row) => row.position)).toEqual([3])
      expect([...connection.scan({ afterPosition: 99, positionRange: { start: 3, end: 3 } })].map((row) => row.position)).toEqual([3])
      expect([...connection.scan({ sinceTimestamp: 20, untilTimestamp: 30, order: "desc" })].map((row) => row.position)).toEqual([3, 1])
      expect(() => [...connection.scan({ positionRange: { start: 2, end: 2 } })]).toThrow("corrupt event row")
    } finally {
      connection.close()
    }
  })

  it("bounds every timestamp-window pass by position across gaps and small timestamp inversions", () => {
    const { dbPath, store } = workspace()
    const sinceTimestamp = 90 * 120_000
    const untilTimestamp = 110 * 120_000
    const emptyConnection = openEventSearch(dbPath)!
    try {
      expect([...emptyConnection.scan({ sinceTimestamp, untilTimestamp })]).toEqual([])
    } finally {
      emptyConnection.close()
    }
    for (let i = 0; i < 200; i++) {
      const timestamp = i === 89 ? sinceTimestamp + 5 : i === 111 ? untilTimestamp - 5 : i * 120_000
      append(store, timestamp)
    }
    store.close()
    const db = new Database(dbPath)
    db.run("update event set position = position * 1000")
    const querySpy = spyOn(Database.prototype, "query")
    const connection = openEventSearch(dbPath)!
    try {
      const filter = { sinceTimestamp, untilTimestamp }
      const positions = [...connection.scan(filter)].map((fact) => fact.position)
      expect(positions).toEqual(Array.from({ length: 23 }, (_, i) => (90 + i) * 1000))
      expect(connection.timestampRange(filter)).toEqual({ sinceTimestamp, untilTimestamp })
      expect(connection.typeSummaries(filter)).toEqual([{
        type: "target.note", count: 23,
        firstPosition: 90_000, lastPosition: 112_000,
        firstTimestamp: sinceTimestamp, lastTimestamp: untilTimestamp,
      }])
      const windowStatements = querySpy.mock.results.flatMap((result, i) =>
        querySpy.mock.calls[i]![0].includes("$sinceTimestamp") && result.type === "return" ? [result.value] : [])
      expect(windowStatements).toHaveLength(3)
      for (const statement of windowStatements) {
        const plan = db.query<{ detail: string }, []>(`explain query plan ${statement.toString()}`).all()
        expect(plan.some(({ detail }) => detail.includes("rowid>? AND rowid<?"))).toBe(true)
      }
      // Without statistics SQLite prefers the type index, which walks every
      // session's rows of that type; a session-scoped read must seek the session.
      querySpy.mockClear()
      const sessionFilter = { sessionId: "session", typePatterns: ["target.note"] }
      expect([...connection.scan(sessionFilter)]).toHaveLength(200)
      expect(connection.timestampRange(sessionFilter)).toEqual({ sinceTimestamp: 0, untilTimestamp: 199 * 120_000 })
      expect(connection.typeSummaries(sessionFilter).map(({ count }) => count)).toEqual([200])
      const sessionStatements = querySpy.mock.results.flatMap((result, i) =>
        querySpy.mock.calls[i]![0].includes("$sessionId") && result.type === "return" ? [result.value] : [])
      expect(sessionStatements).toHaveLength(3)
      for (const statement of sessionStatements) {
        const plan = db.query<{ detail: string }, []>(`explain query plan ${statement.toString()}`).all()
        expect(plan.some(({ detail }) => detail.includes("event_session_idx"))).toBe(true)
      }
      expect([...connection.scan({ sinceTimestamp, afterPosition: 198_000 })].map((fact) => fact.position))
        .toEqual([199_000, 200_000])
      expect([...connection.scan({ untilTimestamp: 120_000 })].map((fact) => fact.position))
        .toEqual([1000, 2000])
      expect([...connection.scan({ ...filter, afterPosition: 199_000, positionRange: { start: 91_000, end: 95_000 } })]
        .map((fact) => fact.position)).toEqual([91_000, 92_000, 93_000, 94_000, 95_000])
      expect([...connection.scan({ sinceTimestamp: 200 * 120_000 })]).toEqual([])
      expect([...connection.scan({ untilTimestamp: -120_000 })]).toEqual([])
    } finally {
      connection.close()
      querySpy.mockRestore()
      db.close()
    }
  })

  it("searches hydrated text beyond the reference preview and keeps failed resolution strict", () => {
    const { baseDir, dbPath, store } = workspace()
    const text = `${"prefix ".repeat(800)}hidden-needle`
    const extracted = extractContent(text)
    if (extracted.kind !== "reference") throw new Error("expected reference fixture")
    expect(extracted.reference.preview).not.toContain("hidden-needle")
    store.append({
      aggregateId: "tool", type: "tool.execution_output.recorded", version: 2,
      timestamp: 1, actor: "flywheel", sessionId: "session",
      payload: { toolUseId: "tool-1", output: extracted.reference },
      contentRows: [extracted.row],
    })
    store.close()
    const matches = searchEvents({ baseDir, pattern: "hidden-needle", limit: 1 }).matches
    expect(matches.map(rowType)).toEqual(["tool.execution_output.recorded"])
    expect(matches[0]?.source === "store" && matches[0].fact.payload.output).toBe(text)
    const db = new Database(dbPath)
    db.run("delete from tool_content")
    db.close()
    expect(() => searchEvents({ baseDir, pattern: "hidden-needle", limit: 1 })).toThrow("missing")
  })

  it("keeps primary-key payload reads in the identity iterator's initial view", () => {
    const { dbPath, store } = workspace()
    for (const timestamp of [3, 1, 2]) append(store, timestamp)
    const writer = new Database(dbPath)
    const connection = openEventSearch(dbPath)!
    const facts: StoredFact[] = []
    try {
      for (const fact of connection.scan({ sortBy: "timestamp" })) {
        facts.push(fact)
        if (facts.length === 1) writer.run("update event set payload = 'malformed' where timestamp = 2")
      }
      expect(facts.map((fact) => fact.timestamp)).toEqual([1, 2, 3])
      expect(facts[1]?.payload).toEqual({ marker: "acquired-2" })
      expect(() => [...connection.scan({ sortBy: "timestamp" })]).toThrow("corrupt event row")
    } finally {
      connection.close()
      writer.close()
      store.close()
    }
  })

  it.each(["missing", "corrupt"] as const)("resolves %s references only for selected or matcher-needed facts", (failure) => {
    const { baseDir, dbPath, store } = workspace()
    const extracted = extractContent("large tool text ".repeat(500))
    if (extracted.kind !== "reference") throw new Error("expected reference fixture")
    store.append({
      aggregateId: "tool", type: "tool.execution_output.recorded", version: 2,
      timestamp: 1, actor: "flywheel", sessionId: "session",
      payload: { toolUseId: "tool-1", output: extracted.reference },
      contentRows: [extracted.row],
    })
    append(store, 2, { payload: { requestId: "wanted", outcome: "error" } })
    store.close()
    const db = new Database(dbPath)
    db.run(failure === "missing" ? "delete from tool_content" : "update tool_content set content = 'wrong bytes'")
    db.close()
    const querySpy = spyOn(Database.prototype, "query")
    const logScan = spyOn(debugLog, "scanDebugLogFiles").mockImplementation(function* () {
      yield { ts: 0, type: "log.info" }
    })
    try {
      expect(searchEvents({ baseDir, requestId: "wanted", limit: 1 }).matches.map(rowTimestamp)).toEqual([2])
      expect(searchEvents({ baseDir, errorsOnly: true, limit: 1 }).matches.map(rowTimestamp)).toEqual([2])
      expect(searchEvents({ baseDir, limit: 1 }).matches.map(rowType)).toEqual(["log.info"])
      expect(querySpy.mock.calls.some(([sql]) => sql.includes("select content from tool_content"))).toBe(false)
      const message = failure === "missing" ? "is missing" : "resolved to sha256"
      expect(() => searchEvents({ baseDir, typePatterns: ["tool.execution_output"], limit: 1 })).toThrow(message)
      expect(() => searchEvents({ baseDir, pattern: "not present", limit: 1 })).toThrow(message)
      expect(() => searchEvents({ baseDir, limit: 0 })).toThrow(message)
    } finally {
      querySpy.mockRestore()
      logScan.mockRestore()
    }
  })

  it("returns raw references from scan and hydrates selected output before closing", () => {
    const { baseDir, dbPath, store } = workspace()
    const text = "exact content ".repeat(500)
    const extracted = extractContent(text)
    if (extracted.kind !== "reference") throw new Error("expected reference fixture")
    store.append({
      aggregateId: "tool", type: "tool.result.recorded", version: 2,
      timestamp: 1, actor: "flywheel", sessionId: "session",
      payload: { toolUseId: "tool-1", parentToolUseId: "parent", outcome: "error", content: extracted.reference },
      contentRows: [extracted.row],
    })
    store.close()
    const connection = openEventSearch(dbPath)!
    try {
      const facts = [...connection.scan({})]
      expect(facts[0]?.version).toBe(2)
      expect(facts[0]?.payload.content).toEqual(extracted.reference)
    } finally {
      connection.close()
    }
    const querySpy = spyOn(Database.prototype, "query")
    try {
      for (const query of [{ errorsOnly: true }, { pattern: "exact content" }]) {
        querySpy.mockClear()
        const matches = searchEvents({ baseDir, ...query, limit: 1 }).matches
        expect(matches[0]?.source === "store" && matches[0].fact.payload.content).toBe(text)
        expect(matches[0]?.source === "store" && matches[0].fact.version).toBe(1)
        expect(querySpy.mock.calls.filter(([sql]) => sql.includes("select content from tool_content"))).toHaveLength(1)
      }
    } finally {
      querySpy.mockRestore()
    }
  })

  it("does not cap unlimited/count input at the default or the limited row count", () => {
    const { baseDir, store } = workspace()
    for (let i = 0; i < 130; i++) append(store, i % 9)
    store.close()
    const all = searchEvents({ baseDir, limit: 0 }).matches
    expect(all).toHaveLength(130)
    expect(searchEvents({ baseDir }).matches).toEqual(all.slice(0, 80))
    expect(searchEvents({ baseDir, limit: 3 }).matches).toEqual(all.slice(0, 3))
    expect(searchEvents({ baseDir, limit: 0, order: "desc" }).matches).toEqual(all.toReversed())
  })
})
