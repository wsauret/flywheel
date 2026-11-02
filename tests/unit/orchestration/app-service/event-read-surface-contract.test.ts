import { describe, expect, test, afterEach, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanup, closeFixtures, fixture } from "./_project-state-worker-fixture.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import {
  asAsyncEventReadSurface,
  capturedFacts,
  CorruptEventRowError,
  readCapturedFacts,
  type AsyncEventStateReadSurface,
  type EventStoreAppend,
  type FactQuery,
  type LocalSqliteEventStore,
  type StoredFact,
} from "../../../../src/infra/event-store-types.js"
import { extractContent, resolveToolContentReference } from "../../../../src/infra/tool-content.js"
import { InvariantViolation } from "../../../../src/infra/invariant.js"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"

afterEach(closeFixtures)

/** One read surface under test, with the store connection behind it. The
 *  store seeds facts and in-flight values and owns the database file, so a
 *  case can damage a row exactly as a broken disk would. */
interface ContractSurface {
  readonly reader: AsyncEventStateReadSurface
  readonly store: LocalSqliteEventStore
  readonly path: string
}

/** Every consumer test runs on the local adapter, and every interactive
 *  runtime reads through the state Worker. Those tests prove the runtime
 *  only while both surfaces answer every case below the same way. */
const surfaces: ReadonlyArray<readonly [string, () => Promise<ContractSurface>]> = [
  ["local adapter", async () => {
    const directory = mkdtempSync(join(tmpdir(), "read-contract-"))
    const path = join(directory, "events.sqlite")
    const store = createSqliteEventStore(path)
    cleanup.push(async () => {
      try { store.close() } finally { rmSync(directory, { recursive: true, force: true }) }
    })
    return { reader: asAsyncEventReadSurface(store), store, path }
  }],
  ["state Worker client", async () => {
    const { client, store, path } = await fixture()
    return { reader: client, store, path }
  }],
]

function fact(type: string, payload: { [key: string]: unknown } = {}, aggregate = "s"): EventStoreAppend {
  return { aggregateId: `session:${aggregate}`, type, sessionId: aggregate, version: 1, timestamp: 1, actor: "test", payload }
}

function corruptRow(path: string, position: number): void {
  const db = new Database(path)
  try {
    db.query("UPDATE event SET payload = ? WHERE position = ?").run("{bad json", position)
  } finally {
    db.close()
  }
}

describe.each(surfaces)("event read surface contract: %s", (_surface, open) => {
  test("readSlice composes every filter, the lower and upper bounds, the order, and the limit", async () => {
    const { reader, store } = await open()
    const a1 = store.append(fact("one"))
    const a2 = store.append(fact("two"))
    const a3 = store.append(fact("one"))
    const b1 = store.append(fact("one", {}, "other"))
    const a4 = store.append(fact("two"))
    const s = "session:s"
    const cases: ReadonlyArray<readonly [FactQuery, readonly StoredFact[]]> = [
      [{ aggregateId: s }, [a1, a2, a3, a4]],
      [{ aggregateId: s, afterPosition: a1.position }, [a2, a3, a4]],
      [{ aggregateId: s, afterPosition: a1.position, order: "desc" }, [a4, a3, a2]],
      [{ aggregateId: s, beforePosition: a4.position }, [a1, a2, a3]],
      [{ aggregateId: s, afterPosition: a1.position, beforePosition: a4.position, order: "desc" }, [a3, a2]],
      [{ aggregateId: s, fromSeq: 1 }, [a2, a3, a4]],
      [{ aggregateId: s, order: "desc", limit: 2 }, [a4, a3]],
      [{ aggregateId: s, types: ["one"], beforePosition: a3.position, order: "desc", limit: 1 }, [a1]],
      [{ aggregateId: s, limit: 0 }, []],
      [{ types: ["one"] }, [a1, a3, b1]],
      [{ types: ["two", "one", "two"], order: "desc", limit: 3 }, [a4, b1, a3]],
      [{ aggregateId: s, types: ["two", "one"], afterPosition: a1.position, beforePosition: a4.position, order: "desc", limit: 1 }, [a3]],
      [{ sessionId: "s", types: ["two", "one"], limit: 3 }, [a1, a2, a3]],
      [{ positions: [a3.position, a1.position], types: ["two", "one"] }, [a1, a3]],
      [{ types: [] }, []],
      [{ sessionId: "other" }, [b1]],
      [{ positions: [a3.position, a1.position] }, [a1, a3]],
      [{ positions: [] }, []],
      [{ aggregateIds: [s, "session:other"], types: ["one", "two"], order: "desc", limitPerAggregate: 2, limit: 4 }, [a4, b1, a3]],
    ]
    for (const [query, expected] of cases) {
      expect({ query, facts: (await reader.readSlice(query)).facts }).toEqual({ query, facts: [...expected] })
    }
  })

  test("readPage caps a page at the query limit, the row cap, and the ceiling, and keeps the query's own bounds", async () => {
    const { reader, store } = await open()
    const appended = store.appendBatch(Array.from({ length: 1025 }, (_, value) => fact(["one", "two", "ignored"][value % 3]!, { value }, value % 2 === 0 ? "s" : "other")))
    const first = await reader.readPage({}, undefined, 0)
    const ceiling = first.upperPosition
    expect(ceiling).toBe(appended.at(-1)!.position)
    store.append(fact("one", { value: "later" }))

    expect([first.facts.length, first.continuationPosition]).toEqual([256, 256])
    const last = await reader.readPage({}, ceiling, 256)
    expect(last.upperPosition).toBe(ceiling)
    expect([last.facts.map(({ position }) => position), last.continuationPosition]).toEqual([appended.slice(256, 512).map(({ position }) => position), 512])

    for (const query of [
      { types: ["two", "one", "one"], limit: 17 },
      { aggregateId: "session:s", types: ["two", "one"], limit: 17 },
      { sessionId: "s", types: ["two", "one"], limit: 17 },
      { aggregateIds: ["session:s", "session:other", "session:s"], types: ["two", "one"], limit: 17 },
    ]) {
      const seen: number[] = []
      let position = 0
      const statements = _surface === "local adapter" && "aggregateIds" in query ? spyOn(Database.prototype, "query") : undefined
      try {
        for (;;) {
          const page = await reader.readPage(query, ceiling, position)
          if (statements) {
            expect(statements).toHaveBeenCalledTimes(1)
            statements.mockClear()
          }
          seen.push(...page.facts.map((item) => item.position))
          if (page.continuationPosition === null) break
          expect(page.continuationPosition).toBe(seen.at(-1)!)
          position = page.continuationPosition
        }
      } finally {
        statements?.mockRestore()
      }
      const expected = appended.filter((item) => item.type !== "ignored" && (!("aggregateId" in query || "sessionId" in query) || item.sessionId === "s"))
      expect(seen).toEqual(expected.map((item) => item.position))
    }

    const limited = await reader.readPage({ limit: 1 }, ceiling, 0)
    expect([limited.facts.map(({ position }) => position), limited.continuationPosition]).toEqual([[1], 1])
    const afterQuery = await reader.readPage({ afterPosition: 1, limit: 1 }, ceiling, 0)
    expect(afterQuery.facts.map(({ position }) => position)).toEqual([2])
    const beforeQuery = await reader.readPage({ beforePosition: 3 }, ceiling, 0)
    expect([beforeQuery.facts.map(({ position }) => position), beforeQuery.continuationPosition]).toEqual([[1, 2], null])
    const pastCeiling = await reader.readPage({ beforePosition: ceiling + 5 }, ceiling, 1024)
    expect([pastCeiling.facts.map(({ position }) => position), pastCeiling.continuationPosition]).toEqual([[1025], null])
    const read = spyOn(store, "read")
    const readTolerant = spyOn(store, "readTolerant")
    try {
      const position = store.currentPosition()
      for (const tolerant of [false, true]) {
        const idle = await reader.readPage({}, undefined, position, tolerant)
        expect([idle.facts, idle.upperPosition, idle.continuationPosition]).toEqual([[], position, null])
      }
      expect(read).not.toHaveBeenCalled()
      expect(readTolerant).not.toHaveBeenCalled()
    } finally {
      read.mockRestore()
      readTolerant.mockRestore()
    }
  })

  test("a strict read rejects a corrupt row and a tolerant read returns it in position", async () => {
    const { reader, store, path } = await open()
    store.appendBatch([fact("one"), fact("one")])
    corruptRow(path, 1)
    const ceiling = await reader.capturePosition()
    await expect(reader.readPage({}, ceiling, 0)).rejects.toBeInstanceOf(CorruptEventRowError)
    await expect(reader.readSlice({ positions: [1] })).rejects.toBeInstanceOf(CorruptEventRowError)
    await expect(reader.readSlice({ aggregateId: "session:s" })).rejects.toBeInstanceOf(CorruptEventRowError)
    for (const facts of [
      (await reader.readPage({}, ceiling, 0, true)).facts,
      (await reader.readSlice({ aggregateId: "session:s" }, true)).facts,
    ]) {
      expect(facts[0]).toBeInstanceOf(CorruptEventRowError)
      expect(facts[0]).toMatchObject({ position: 1 })
      expect(facts[1]).toMatchObject({ position: 2 })
    }
  })

  test("a strict page reads no row past its ceiling, so later corruption cannot fail it", async () => {
    const { reader, store, path } = await open()
    store.append(fact("one"))
    const ceiling = await reader.capturePosition()
    store.append(fact("one"))
    corruptRow(path, 2)
    const page = await reader.readPage({}, ceiling, 0)
    expect([page.facts.map(({ position }) => position), page.continuationPosition]).toEqual([[1], null])
    // Inside the ceiling, the lookahead row that shows a next page is read
    // like any other row, so a strict page fails on it on both surfaces.
    await expect(reader.readPage({ limit: 1 }, await reader.capturePosition(), 0)).rejects.toBeInstanceOf(CorruptEventRowError)
  })

  test("capturedFacts streams strict matches through one ceiling, yields between pages, and reads nothing above a spent cursor", async () => {
    const { reader, store, path } = await open()
    const appended = store.appendBatch(Array.from({ length: 257 }, (_, value) => fact("one", { value })))
    const ceiling = await reader.capturePosition()
    store.append(fact("one", { value: "later" }))

    let queuedRan = false
    setImmediate(() => { queuedRan = true })
    const seen: { readonly position: number; readonly queuedRan: boolean }[] = []
    for await (const stored of capturedFacts(reader, { types: ["one"] }, { upperPosition: ceiling })) seen.push({ position: stored.position, queuedRan })
    expect(seen.map(({ position }) => position)).toEqual(appended.map(({ position }) => position))
    // A local page answers in microtasks, so only the yield between pages lets queued work run before the last page.
    expect(seen.at(-1)?.queuedRan).toBe(true)

    expect((await readCapturedFacts(reader, { types: ["one"] }, { afterPosition: 255 })).map(({ position }) => position)).toEqual([256, 257, 258])

    let pages = 0
    const counted: AsyncEventStateReadSurface = { ...reader, readPage: (...args) => { pages += 1; return reader.readPage(...args) } }
    expect(await readCapturedFacts(counted, {}, { upperPosition: ceiling, afterPosition: ceiling })).toEqual([])
    expect(pages).toBe(0)

    corruptRow(path, 2)
    await expect(readCapturedFacts(reader, { types: ["one"] })).rejects.toBeInstanceOf(CorruptEventRowError)
  })

  test("latest reads answer the newest row of each type", async () => {
    const { reader, store } = await open()
    expect(await reader.latestPosition("one")).toBe(0)
    expect(await reader.readLatestPayloadByAggregateAndType("session:s", "one")).toBeNull()
    expect(await reader.readLatestByAggregateAndTypes("session:s", ["one"])).toEqual([])
    store.append(fact("one", { value: 1 }))
    const second = store.append(fact("two", { value: 2 }))
    const third = store.append(fact("one", { value: 3 }))
    expect(await reader.latestPosition("one")).toBe(third.position)
    expect(await reader.readLatestPayloadByAggregateAndType("session:s", "one")).toBe(JSON.stringify({ value: 3 }))
    expect(await reader.readLatestByAggregateAndTypes("session:s", ["one", "two", "missing"])).toEqual([second, third])
  })

  test("in-flight reads keep insertion order across kinds and name the sessions that hold a kind", async () => {
    const { reader, store } = await open()
    expect(await reader.readInFlight("s", "tool")).toEqual([])
    expect(await reader.sessionsWithInFlight("tool")).toEqual([])
    store.putInFlight("s", "tool", "later", { order: 2 })
    store.putInFlight("s", "review", "middle", { order: 1 })
    store.putInFlight("t", "review", "other", {})
    expect(await reader.readInFlight("s", ["tool", "review"])).toEqual([
      { kind: "tool", key: "later", payload: { order: 2 }, raw: JSON.stringify({ order: 2 }) },
      { kind: "review", key: "middle", payload: { order: 1 }, raw: JSON.stringify({ order: 1 }) },
    ])
    expect(await reader.sessionsWithInFlight("tool")).toEqual(["s"])
    expect(await reader.sessionsWithInFlight("review")).toEqual(["s", "t"])
    store.putInFlight("s", "tool", "agent_1%:one", {})
    store.putInFlight("s", "tool", "agentX1Z:two", {})
    store.putInFlight("s", "tool", "agent_1%2:three", {})
    expect((await reader.readInFlight("s", "tool", "agent_1%:")).map(row => row.key)).toEqual(["agent_1%:one"])
  })

  test("profile presence follows pending, measured, and retired cells through the owner", async () => {
    const { reader, store } = await open()
    const kind = "usage.settlement"
    expect(await reader.hasInFlightProfile(kind, "profile")).toBe(false)
    store.putInFlight("s", kind, "attempt", { state: "pending", profileId: "profile" })
    expect(await reader.hasInFlightProfile(kind, "profile")).toBe(true)
    store.putInFlight("s", kind, "attempt", { state: "measured", entry: { profileId: "profile" } })
    store.putInFlight("other", kind, "attempt", { profileId: "other-profile" })
    expect(await reader.hasInFlightProfile(kind, "profile")).toBe(true)
    expect(await reader.hasInFlightProfile("other-kind", "profile")).toBe(false)
    store.append({ ...fact("settled"), inFlight: [{ op: "drop", kind, key: "attempt" }] })
    expect(await reader.hasInFlightProfile(kind, "profile")).toBe(false)
    expect(await reader.hasInFlightProfile(kind, "other-profile")).toBe(true)
    store.append({ ...fact("deleted", {}, "other"), inFlight: [{ op: "clear_session" }] })
    expect(await reader.hasInFlightProfile(kind, "other-profile")).toBe(false)
  })

  test("the aggregate count follows surviving rows and the sequence keeps the last assigned value", async () => {
    const { reader, store } = await open()
    expect([await reader.countByAggregate("session:s"), await reader.aggregateSeq("session:s")]).toEqual([0, -1])
    store.appendBatch([fact("queue.state.changed"), fact("queue.state.changed"), fact("queue.state.changed")])
    expect([await reader.countByAggregate("session:s"), await reader.aggregateSeq("session:s")]).toEqual([3, 2])
    expect(store.pruneSupersededEvents("session:s", "queue.state.changed")).toBe(2)
    expect([await reader.countByAggregate("session:s"), await reader.aggregateSeq("session:s")]).toEqual([1, 2])
  })

  test("eager reads and contentFor resolve every reference site and no other field, deferred pages resolve none, and integrity gaps fail at the hydration seam", async () => {
    const { reader, store } = await open()
    // Each reference site holds its own text, so a surface that skips one
    // site cannot resolve that site's row through another site.
    const referenced = (text: string) => {
      const extracted = extractContent(`${text} `.repeat(256))
      if (extracted.kind !== "reference") throw new Error("missing reference")
      return extracted
    }
    const result = referenced("verified text")
    const readView = referenced("read view")
    const searchView = referenced("search view")
    const output = referenced("execution output")
    const chatOutput = referenced("chat tool output")
    const reference = result.reference
    const missing = { ...reference, sha256: "missing" }
    const damaged = { ...reference, bytes: reference.bytes + 1 }
    const toolResult = store.append({
      ...fact("tool.result.recorded", { toolUseId: "t", outcome: "ok", parentToolUseId: "p", content: reference, details: { displayContent: { text: readView.reference, startLine: 1 } } }),
      version: 2, contentRows: [result.row, readView.row],
    })
    const searchResult = store.append({
      ...fact("tool.result.recorded", { toolUseId: "u", outcome: "ok", parentToolUseId: "p", content: damaged, details: { displayContent: searchView.reference } }),
      version: 2, contentRows: [searchView.row],
    })
    const executionOutput = store.append({ ...fact("tool.execution_output.recorded", { toolUseId: "t", output: output.reference }), version: 2, contentRows: [output.row] })
    const missingOutput = store.append({ ...fact("tool.execution_output.recorded", { toolUseId: "u", output: missing }), version: 2 })
    const chat = store.append({
      ...fact("chat.entries.appended", { conversationId: "c", entries: [{ kind: "message", id: "e", parentId: null, message: { kind: "toolResult", toolUseId: "t", content: [{ type: "text_reference", ...chatOutput.reference }] } }] }),
      version: 3, contentRows: [chatOutput.row],
    })
    // A handoff's content evidence has the reference shape but names no
    // content row, so no surface may treat it as a reference.
    const evidence = contentEvidence("handoff body")
    const handoff = store.append({ ...fact("handoff.written", { stepId: "step", content: { summary: "done" }, ...evidence }), actor: "worker" })
    const stored = [toolResult, searchResult, executionOutput, missingOutput, chat, handoff]
    const resolved = [result, readView, searchView, output, chatOutput]
    const at = { eventType: toolResult.type, eventPosition: toolResult.position, aggregateId: toolResult.aggregateId }
    const ceiling = await reader.capturePosition()

    const deferred = await reader.readPage({}, ceiling, 0, false, "deferred")
    expect(deferred.toolContent.resolve("s", reference.sha256)).toBeNull()
    const eager = await reader.readPage({}, ceiling, 0)
    expect(eager.facts).toEqual(stored)
    for (const resolver of [
      eager.toolContent,
      (await reader.readSlice({ positions: stored.map(({ position }) => position) })).toolContent,
      (await reader.readSlice({ aggregateId: "session:s" })).toolContent,
      await reader.contentFor(stored),
    ]) {
      for (const { reference: site, row } of resolved) expect(resolveToolContentReference(resolver, "s", site, at)).toBe(row.content)
      expect(() => resolveToolContentReference(resolver, "s", missing, at)).toThrow(InvariantViolation)
      expect(() => resolveToolContentReference(resolver, "s", damaged, at)).toThrow(InvariantViolation)
      expect(resolver.resolve("s", evidence.sha256)).toBeNull()
      expect(resolver.resolve("other-session", reference.sha256)).toBeNull()
    }
  })
})
