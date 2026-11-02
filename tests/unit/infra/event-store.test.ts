import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { DebugLogRecordInput } from "../../../src/infra/debug-log.js"
import type { EventStoreAppend, GuardedEventStoreAppend, LocalSqliteEventStore, StoredFact } from "../../../src/infra/event-store-types.js"
import { Log } from "../../../src/infra/log.js"
import { createRuntimeEventStore, createSqliteEventStore, openReadonlyEventReader } from "../../../src/infra/sqlite-event-store.js"
import { createSqliteEventInserter } from "../../../src/infra/sqlite-event-store-core.js"
import type { ToolContentRow } from "../../../src/infra/tool-content.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../src/infra/event-store-types.js"
import { buildSessionContent, type SessionContentNodeRow } from "../../../src/infra/session-content.js"
import { buildMutationEvidence, type MutationFileEvidence } from "../../../src/infra/mutation-evidence.js"
import { canObserveSqliteLocks, sqliteLocksSeenByOtherProcesses } from "../../helpers/sqlite-locks.js"

let tmpDir: string
let store: LocalSqliteEventStore

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-event-store-"))
  store = createSqliteEventStore(path.join(tmpDir, "flywheel.sqlite"))
})

afterEach(() => {
  store.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function appendFact(type: string, aggregateId = "session:txn") {
  return store.append({
    aggregateId,
    type,
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: aggregateId.replace(/^session:/, ""),
    payload: {},
  })
}

function eventWithoutId(event: StoredFact): Omit<StoredFact, "id"> {
  const { id: _id, ...rest } = event
  return rest
}

function batchFact(index: number): EventStoreAppend {
  const sessionIndex = index % 2
  return {
    aggregateId: `session:batch-${sessionIndex}`,
    type: "batch.fact",
    version: 1,
    timestamp: index,
    actor: "flywheel",
    sessionId: `batch-${sessionIndex}`,
    payload: { index },
  }
}

describe("EventStore", () => {
  test("commits multiple appends in one transaction", () => {
    store.transaction(() => {
      appendFact("a.one")
      appendFact("a.two")
    })

    const events = store.read({ aggregateId: "session:txn" })
    expect(events.map((event) => event.type)).toEqual(["a.one", "a.two"])
    expect(store.currentPosition()).toBe(2)
  })

  test("rejects thenable transaction callbacks, rolls back, and resets transaction state", () => {
    expect(() =>
      store.transaction(() => {
        appendFact("a.one")
        return { then() {} }
      }),
    ).toThrow("EventStore.transaction callback must be synchronous; received a Promise/thenable")

    expect(store.read({ aggregateId: "session:txn" })).toEqual([])

    appendFact("a.after")
    expect(store.read({ aggregateId: "session:txn" }).map((event) => event.type)).toEqual(["a.after"])
  })


  test("an in-memory store leaves no file named for SQLite's memory marker", () => {
    const cwd = process.cwd()
    process.chdir(tmpDir)
    try {
      const memory = createSqliteEventStore(":memory:")
      memory.append({ aggregateId: "session:mem", type: "a.one", version: 1, timestamp: 1, actor: "flywheel", sessionId: "mem", payload: {} })
      expect(memory.read({ aggregateId: "session:mem" }).map((event) => event.type)).toEqual(["a.one"])
      memory.close()
    } finally {
      process.chdir(cwd)
    }
    expect(fs.readdirSync(tmpDir).filter((name) => name.includes("memory"))).toEqual([])
  })

  test("does not create prune evidence storage", () => {
    const db = new Database(path.join(tmpDir, "flywheel.sqlite"), { readonly: true })
    try {
      expect(db.query("select name from sqlite_master where type = 'table' and name = 'event_prune'").get()).toBeNull()
    } finally {
      db.close()
    }
  })

  test("append delegates through the same single-event batch machinery", () => {
    const event: EventStoreAppend = {
      aggregateId: "session:single",
      type: "single.fact",
      version: 1,
      timestamp: 123,
      actor: "flywheel",
      sessionId: "single",
      payload: { fact: true },
    }
    const appendStore = createSqliteEventStore(path.join(tmpDir, "append.sqlite"))
    const batchStore = createSqliteEventStore(path.join(tmpDir, "batch.sqlite"))

    try {
      const appended = appendStore.append(event)
      const batched = batchStore.appendBatch([event])

      expect(batched.map(eventWithoutId)).toEqual([eventWithoutId(appended)])
      expect(batchStore.read({ aggregateId: "session:single" })).toEqual(batched)
    } finally {
      appendStore.close()
      batchStore.close()
    }
  })

  test("appends a batch with contiguous positions and per-session seq values", () => {
    const stored = store.appendBatch(Array.from({ length: 1_000 }, (_, index) => batchFact(index)))
    const nextSeqByAggregate = new Map<string, number>()

    expect(stored).toHaveLength(1_000)
    for (let index = 0; index < stored.length; index++) {
      const event = stored[index]!
      const expectedSeq = nextSeqByAggregate.get(event.aggregateId) ?? 0
      if (event.position !== index + 1) throw new Error(`position ${event.position} at index ${index}`)
      if (event.seq !== expectedSeq) throw new Error(`seq ${event.seq} for ${event.aggregateId} at index ${index}`)
      nextSeqByAggregate.set(event.aggregateId, expectedSeq + 1)
    }

    expect(store.currentPosition()).toBe(1_000)
    expect(store.countByAggregate("session:batch-0")).toBe(500)
    expect(store.countByAggregate("session:batch-1")).toBe(500)
  })

  test("counts events by aggregate without materializing rows", () => {
    appendFact("a.one", "session:count")
    appendFact("a.two", "session:count")
    appendFact("b.one", "session:other")

    const events = store.read({ aggregateId: "session:count" })
    expect(store.countByAggregate("session:count")).toBe(2)
    expect(store.countByAggregate("session:count")).toBe(events.length)
  })

  test("reads an aggregate suffix by indexed sequence", () => {
    appendFact("a.one", "workflow:suffix")
    appendFact("a.two", "workflow:suffix")
    appendFact("other", "workflow:other")
    appendFact("a.three", "workflow:suffix")

    const suffix = store.read({ aggregateId: "workflow:suffix", fromSeq: 1 })

    expect(suffix.map(({ seq, type }) => [seq, type])).toEqual([[1, "a.two"], [2, "a.three"]])
  })

  // POSIX releases every lock that a process holds on a file when the process
  // closes any descriptor of that file. A store without its locks looks closed
  // to other processes: the next one to open the database truncates the -shm
  // under this store's memory map, and on Linux the store's process dies with
  // SIGBUS.
  test.skipIf(!canObserveSqliteLocks)("keeps the locks that show other processes it is open, also when a second store opens beside it", () => {
    appendFact("a.one")
    const second = createSqliteEventStore(path.join(tmpDir, "flywheel.sqlite"))
    try {
      expect(second.currentPosition()).toBe(store.currentPosition())
      expect(sqliteLocksSeenByOtherProcesses(path.join(tmpDir, "flywheel.sqlite"))).toEqual({ database: true, sharedMemory: true })
    } finally {
      second.close()
    }
  })
})

describe("session and type index", () => {
  // The sqlite3 CLI and agent scripts cannot pin an index, so this filter
  // must find the right one by itself.
  test("a raw reader of a new store seeks one session's type through the session-type index", () => {
    appendFact("planner.fact", "session:planner")
    const raw = new Database(path.join(tmpDir, "flywheel.sqlite"), { readonly: true })
    try {
      const plan = raw.query<{ detail: string }, []>("explain query plan select payload from event where session_id = 'planner' and type = 'planner.fact'").all()
      expect(plan.map((row) => row.detail).join("\n")).toContain("event_session_type_position_idx (session_id=? AND type=?)")
    } finally {
      raw.close()
    }
  })
})

describe("keyed superseded-row pruning", () => {
  function appendKeyed(type: string, attemptId: string, count: number): void {
    store.append({
      aggregateId: "workflow:w1",
      type,
      version: 2,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "w1",
      payload: { attemptId, count },
    })
  }

  test("rolls back when event deletion fails", () => {
    appendFact("queue.state.changed", "workflow:w1")
    appendFact("queue.state.changed", "workflow:w1")
    const db = new Database(path.join(tmpDir, "flywheel.sqlite"))
    try {
      db.exec(`
        create trigger reject_queue_state_delete
        before delete on event
        when old.type = 'queue.state.changed'
        begin
          select raise(abort, 'induced prune failure');
        end
      `)
    } finally {
      db.close()
    }

    expect(() => store.pruneSupersededEvents("workflow:w1", "queue.state.changed"))
      .toThrow("induced prune failure")
    expect(store.read({ aggregateId: "workflow:w1" })).toHaveLength(2)
  })

  test("keeps the newest row per key and deletes each key's older rows", () => {
    appendKeyed("step.resume_revert.recorded", "alpha", 1)
    appendKeyed("step.resume_revert.recorded", "beta", 1)
    appendKeyed("step.resume_revert.recorded", "alpha", 2)
    appendKeyed("step.resume_revert.recorded", "alpha", 3)
    appendKeyed("other.type", "alpha", 9)

    expect(store.pruneSupersededKeyedEvents("workflow:w1", "step.resume_revert.recorded", "$.attemptId")).toBe(2)

    const survivors = store.read({ aggregateId: "workflow:w1", types: ["step.resume_revert.recorded"] })
      .map((event) => event.payload)
    // Per-key latest survives: pruning by type alone would have kept only
    // one attempt's row and lost the other attempt's live value.
    expect(survivors).toEqual([{ attemptId: "beta", count: 1 }, { attemptId: "alpha", count: 3 }])
    expect(store.read({ aggregateId: "workflow:w1", types: ["other.type"] })).toHaveLength(1)
    expect(store.countByAggregate("workflow:w1")).toBe(3)
  })
})

describe("optimistic concurrency guard", () => {
  function guardedFact(expectedSeq: number): GuardedEventStoreAppend {
    return {
      aggregateId: "session:guarded",
      type: "guarded.fact",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "guarded",
      payload: {},
      expectedSeq,
    }
  }

  test("commits a guarded append at the expected seq and strips the guard from the stored event", () => {
    const result = store.appendGuarded(guardedFact(0))
    if (result.kind !== "stored") throw new Error("expected stored result")
    const stored = result.events[0]
    if (!stored) throw new Error("guarded append returned no fact")
    expect(stored.seq).toBe(0)
    expect("expectedSeq" in stored).toBe(false)
    expect(store.aggregateSeq("session:guarded")).toBe(0)
  })

  test("refuses a stale guarded append and rolls the batch back", () => {
    store.appendGuarded(guardedFact(0))
    expect(store.appendGuarded(guardedFact(0))).toEqual({
      kind: "conflict",
      conflict: { aggregateId: "session:guarded", expectedSeq: 0, actualSeq: 1 },
    })
    expect(store.read({ aggregateId: "session:guarded" }).length).toBe(1)
    expect(store.aggregateSeq("session:guarded")).toBe(0)
  })

  test("refuses the loser when two connections race the same expected seq", () => {
    // Two connections to one file are the cross-process shape: both observe
    // an empty aggregate, both derive expectedSeq 0, only one may land.
    const other = createSqliteEventStore(path.join(tmpDir, "flywheel.sqlite"))
    try {
      expect(store.aggregateSeq("session:guarded")).toBe(-1)
      expect(other.aggregateSeq("session:guarded")).toBe(-1)
      other.appendGuarded(guardedFact(0))
      expect(store.appendGuarded(guardedFact(0))).toMatchObject({ kind: "conflict" })
      expect(store.read({ aggregateId: "session:guarded" }).length).toBe(1)
    } finally {
      other.close()
    }
  })

  test("aggregateSeq is -1 for an aggregate with no events", () => {
    expect(store.aggregateSeq("session:none")).toBe(-1)
  })
})

describe("tool content sidecar", () => {
  function contentRow(text: string): ToolContentRow {
    return {
      sha256: createHash("sha256").update(text, "utf8").digest("hex"),
      content: text,
      bytes: Buffer.byteLength(text),
    }
  }

  function referencingFact(sessionId: string, row: ToolContentRow, expectedSeq?: number): EventStoreAppend {
    return {
      aggregateId: `session:${sessionId}`,
      type: "tool.result.recorded",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId,
      payload: { contentSha256: row.sha256 },
      contentRows: [row],
      ...(expectedSeq !== undefined ? { expectedSeq } : {}),
    }
  }

  function toolContentRowCount(sessionId?: string): number {
    const db = new Database(path.join(tmpDir, "flywheel.sqlite"), { readonly: true })
    try {
      const row = sessionId === undefined
        ? db.query<{ count: number }, []>("select count(*) as count from tool_content").get()
        : db.query<{ count: number }, { $id: string }>("select count(*) as count from tool_content where session_id = $id").get({ $id: sessionId })
      return row?.count ?? 0
    } finally {
      db.close()
    }
  }

  test("duplicate (session, sha256) inserts are no-ops and sessions keep separate rows", () => {
    const row = contentRow("shared tool output ".repeat(200))

    store.append(referencingFact("s1", row))
    store.append(referencingFact("s1", row))
    store.append(referencingFact("s2", row))

    expect(toolContentRowCount("s1")).toBe(1)
    expect(toolContentRowCount()).toBe(2)
    expect(store.toolContent.resolve("s1", row.sha256)).toBe(row.content)
    expect(store.toolContent.resolve("s2", row.sha256)).toBe(row.content)
    expect(store.toolContent.resolve("s3", row.sha256)).toBeNull()
  })

  test("openReadonlyEventReader resolves content rows through the same surface", () => {
    const row = contentRow("readonly-visible tool output ".repeat(200))
    store.append(referencingFact("s1", row))

    const reader = openReadonlyEventReader(path.join(tmpDir, "flywheel.sqlite"))
    try {
      expect(reader.toolContent.resolve("s1", row.sha256)).toBe(row.content)
      expect(reader.toolContent.resolve("s1", "0".repeat(64))).toBeNull()
    } finally {
      reader.close()
    }
  })
})

describe("writer over a store from an older release", () => {
  test("preserves genuine old content rows without classifying JSON text as staged nodes", () => {
    const dbFile = path.join(tmpDir, "old-content.sqlite")
    const db = new Database(dbFile, { create: true })
    const content = JSON.stringify({ version: 1, kind: "text", text: "old ordinary output" })
    const sha256 = createHash("sha256").update(content).digest("hex")
    db.exec("create table tool_content (session_id text not null, sha256 text not null, content text not null, bytes integer not null, primary key(session_id, sha256))")
    db.query("insert into tool_content values (?, ?, ?, ?)").run("legacy", sha256, content, Buffer.byteLength(content))
    db.close()
    const old = createSqliteEventStore(dbFile)
    try {
      expect(old.toolContent.resolve("legacy", sha256)).toBe(content)
      expect(old.readSessionContentNode?.("legacy", sha256)).toBeNull()
    } finally {
      old.close()
    }
  })
  // Migration passes build inserters over raw connections before the store is
  // configured, and a store written by an older release lacks the companion
  // tables the inserter prepares against eagerly. This launch path must not
  // depend on a schema-init ritual at each call site.
  test("createSqliteEventInserter creates the companion tables it prepares against", () => {
    const dbFile = path.join(tmpDir, "legacy.sqlite")
    createSqliteEventStore(dbFile).close()
    const strip = new Database(dbFile)
    strip.exec("drop table in_flight")
    strip.exec("drop table tool_content")
    strip.close()

    const db = new Database(dbFile)
    try {
      const inserter = createSqliteEventInserter(db)
      inserter.writeInFlight("legacy", { op: "put", kind: "turn", key: "k", payload: { at: 1 } })
      const row = db.query<{ count: number }, []>("select count(*) as count from in_flight").get()
      expect(row?.count).toBe(1)
    } finally {
      db.close()
    }
  })
})

describe("staged session content", () => {
  const file = (reference: MutationFileEvidence["patch"]): MutationFileEvidence => ({
    version: 1, mutationId: "m1", path: "/scratch/a", displayPath: "a", change: "modified",
    before: null, after: null, retainedLines: 1, renderedLines: 1, omittedLines: 0,
    addedLines: 1, removedLines: 0, patch: reference, conflictMarkers: false,
  })

  test("refuses missing and wrong-length evidence atomically without discarding staged nodes", async () => {
    const nodes: SessionContentNodeRow[] = []
    const reference = await buildSessionContent("retained patch", async rows => { nodes.push(...rows) })
    const makeFact = (evidence: unknown): EventStoreAppend => ({
      ...batchFact(0), sessionId: "evidence", aggregateId: "session:evidence",
      type: "file.artifact.recorded", payload: { artifactKind: "mutation_diff", evidence },
      inFlight: [{ op: "put", kind: "cursor", key: "m1", payload: { settled: 1 } }],
    })
    const position = store.currentPosition()
    expect(() => store.append(makeFact(file({ kind: "retained", reference })))).toThrow()
    expect(store.currentPosition()).toBe(position)
    expect(store.aggregateSeq("session:evidence")).toBe(-1)
    expect(store.readInFlight("evidence", "cursor")).toEqual([])
    await asAsyncEventWriter(store).stageSessionContentNodes!("evidence", nodes)
    expect(() => store.append(makeFact(file({ kind: "retained", reference: { ...reference, bytes: reference.bytes + 1 } })))).toThrow()
    const summary = await buildMutationEvidence([{ kind: "applied", file: file({ kind: "retained", reference }) }],
      rows => asAsyncEventWriter(store).stageSessionContentNodes!("evidence", rows))
    const wrongSummary = await buildMutationEvidence([{ kind: "applied", file: file({ kind: "retained", reference: { ...reference, sha256: "0".repeat(64) } }) }],
      rows => asAsyncEventWriter(store).stageSessionContentNodes!("evidence", rows))
    expect(() => store.putInFlight("evidence", "finalized-tool-result", "t1", { details: { mutationEvidence: wrongSummary } })).toThrow()
    store.putInFlight("evidence", "finalized-tool-result", "t1", { details: { mutationEvidence: summary } })
    const raw = store.readInFlight("evidence", "finalized-tool-result")[0]!.raw
    expect(() => store.swapInFlight("evidence", "finalized-tool-result", "t1", raw, { details: { mutationEvidence: wrongSummary } })).toThrow()
    expect(store.readInFlight("evidence", "finalized-tool-result")[0]!.raw).toBe(raw)
    expect(() => store.putInFlight("other", "finalized-tool-result", "t1", { details: { mutationEvidence: summary } })).toThrow()
    expect(store.readInFlight("other", "finalized-tool-result")).toEqual([])
    store.append(makeFact(file({ kind: "retained", reference })))
    expect(store.currentPosition()).toBe(position + 1)
    expect(await asAsyncEventReadSurface(store).readSessionContentRange!("evidence", reference, 0, reference.bytes))
      .toMatchObject({ kind: "available", base64: Buffer.from("retained patch").toString("base64"), nextOffset: null })
    expect(await asAsyncEventReadSurface(store).readSessionContentNode!("other", reference.root)).toBeNull()
    const unknownMetadata = { version: 2, root: reference.root, before: { bytes: 9, sha256: "0".repeat(64) } }
    expect(() => store.putInFlight("evidence", "ordinary", "k", unknownMetadata)).not.toThrow()
    expect(store.readInFlight("evidence", "ordinary")[0]!.payload).toEqual(unknownMetadata)
  })

  test("promotes identical ordinary content without copying and stages through the runtime lane", async () => {
    const runtime = createRuntimeEventStore(path.join(tmpDir, "nodes.sqlite"))
    const nodes: SessionContentNodeRow[] = []
    const reference = await buildSessionContent("shared bytes", async rows => { nodes.push(...rows) })
    const row = nodes[0]!
    const content = JSON.stringify(row.node)
    try {
      await runtime.append({ ...batchFact(0), contentRows: [{ sha256: row.sha256, content, bytes: Buffer.byteLength(content) }] })
      expect(runtime.readSessionContentNode?.("batch-0", row.sha256)).toBeNull()
      await asAsyncEventWriter(runtime).stageSessionContentNodes!("batch-0", nodes)
      await asAsyncEventWriter(runtime).stageSessionContentNodes!("batch-0", nodes)
      expect(runtime.readSessionContentNode?.("batch-0", reference.root)).toEqual(row.node)
      expect(runtime.readSessionContentNode?.("other", reference.root)).toBeNull()
      const db = new Database(path.join(tmpDir, "nodes.sqlite"), { readonly: true })
      try {
        expect(db.query("select count(*) as count from tool_content").get()).toEqual({ count: 1 })
      } finally { db.close() }
      expect(runtime.currentPosition()).toBe(1)
    } finally { await runtime.close() }
  })

  test("admits indexes bottom-up only with matching child kinds and counts", async () => {
    const nodes: SessionContentNodeRow[] = []
    await buildSessionContent("x".repeat(100_000), async rows => { nodes.push(...rows) })
    const index = nodes.at(-1)!
    expect(index.node.kind).toBe("index")
    expect(() => store.stageSessionContentNodes("indexes", [index])).toThrow()
    store.stageSessionContentNodes("indexes", nodes.slice(0, -1))
    if (index.node.kind !== "index") throw new Error("Expected text index")
    const activeStore = store
    for (const node of [
      { ...index.node, tree: "records" as const },
      { ...index.node, children: index.node.children.map(child => ({ ...child, bytes: child.bytes + 1 })) },
    ]) {
      const sha256 = createHash("sha256").update(JSON.stringify(node)).digest("hex")
      expect(() => activeStore.stageSessionContentNodes("indexes", [{ sha256, node }])).toThrow()
    }
    store.stageSessionContentNodes("indexes", [index])
    expect(store.readSessionContentNode?.("indexes", index.sha256)).toEqual(index.node)
    expect(store.currentPosition()).toBe(0)
  })
})

describe("createRuntimeEventStore", () => {
  test("funnels the async write surface through its lane and reads its own writes", async () => {
    const runtimeStore = createRuntimeEventStore(path.join(tmpDir, "runtime.sqlite"))
    try {
      const single = await runtimeStore.append({
        aggregateId: "session:r1",
        type: "runtime.fact",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: "r1",
        payload: { text: "one" },
      })
      // Awaited commit precedes the read: the synchronous read surface sees
      // the fact immediately after the append resolves.
      expect(runtimeStore.read({ aggregateId: "session:r1" })).toEqual([single])
      expect(runtimeStore.aggregateSeq("session:r1")).toBe(0)
    } finally {
      await runtimeStore.close()
    }
  })

  test("appendBatch is atomic and guarded appends return typed conflicts", async () => {
    const runtimeStore = createRuntimeEventStore(path.join(tmpDir, "runtime.sqlite"))
    const append = (text: string, expectedSeq?: number): GuardedEventStoreAppend => ({
      aggregateId: "session:r1",
      type: "runtime.fact",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "r1",
      payload: { text },
      ...(expectedSeq !== undefined ? { expectedSeq } : {}),
    })
    try {
      await runtimeStore.appendBatch([append("one"), append("two")])
      await expect(runtimeStore.appendGuarded(append("stale", 0))).resolves.toMatchObject({ kind: "conflict" })
      await expect(runtimeStore.appendBatchGuarded([append("three"), append("stale", 0)])).resolves.toMatchObject({ kind: "conflict" })
      expect(runtimeStore.read({ aggregateId: "session:r1" }).map((event) => event.payload)).toEqual([{ text: "one" }, { text: "two" }])
    } finally {
      await runtimeStore.close()
    }
  })

  test("notifies onStored subscribers once per committed flush", async () => {
    const runtimeStore = createRuntimeEventStore(path.join(tmpDir, "runtime.sqlite"))
    const seen: string[][] = []
    const unsubscribe = runtimeStore.onStored((events) => { seen.push(events.map((event) => String(event.payload.text))) })
    try {
      const first = runtimeStore.append({
        aggregateId: "session:r1",
        type: "runtime.fact",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: "r1",
        payload: { text: "one" },
      })
      const second = runtimeStore.append({
        aggregateId: "session:r1",
        type: "runtime.fact",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        sessionId: "r1",
        payload: { text: "two" },
      })
      await Promise.all([first, second])
      expect(seen).toEqual([["one", "two"]])
    } finally {
      unsubscribe()
      await runtimeStore.close()
    }
  })

  // The dev and installed service lanes each hold the one account store. A
  // peer's open connection refuses the close's switch out of WAL mode at once,
  // whatever the busy timeout, so the lane that closes first must neither lose
  // a fact nor report that expected refusal as a fault.
  test("closing beside a peer connection keeps every fact and warns about nothing, and a lone close folds to one file", async () => {
    const dbFile = path.join(tmpDir, "account.sqlite")
    const fact = (text: string): EventStoreAppend => ({
      aggregateId: "session:r1",
      type: "runtime.fact",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: "r1",
      payload: { text },
    })
    const records: DebugLogRecordInput[] = []
    await Log.init({ forward: (record) => { records.push(record) } })
    const runtimeStore = createRuntimeEventStore(dbFile)
    const peer = new Database(dbFile)
    try {
      await runtimeStore.append(fact("one"))
      peer.query("select count(*) from event").get()
      await runtimeStore.append(fact("two"))
      await runtimeStore.close()
      expect(peer.query<{ text: string }, []>("select json_extract(payload, '$.text') as text from event order by position").all()).toEqual([{ text: "one" }, { text: "two" }])
    } finally {
      peer.close()
      await Log.closeGlobal()
    }
    expect(records.filter((record) => record.type === "log.warn")).toEqual([])

    await createRuntimeEventStore(dbFile).close()
    expect(fs.existsSync(`${dbFile}-wal`)).toBe(false)
    expect(fs.existsSync(`${dbFile}-shm`)).toBe(false)
  })
})
