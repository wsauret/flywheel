import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import type { EventStore, EventStoreAppend, InFlightWrite } from "../../../src/infra/event-store-types.js"

const dirs: string[] = []
const stores: EventStore[] = []

function openStore(): EventStore {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-in-flight-"))
  dirs.push(dir)
  const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
  stores.push(store)
  return store
}

function fact(sessionId: string, inFlight?: readonly InFlightWrite[]): EventStoreAppend {
  return {
    aggregateId: `session:${sessionId}`,
    sessionId,
    type: "session.label.updated",
    version: 1,
    actor: "flywheel",
    timestamp: Date.now(),
    payload: {},
    ...(inFlight ? { inFlight } : {}),
  }
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("in-flight recovery state", () => {
  test("a value written many times keeps exactly one row", () => {
    const store = openStore()
    for (const attempt of ["first", "second", "third"]) {
      store.append(fact("s1", [{ op: "put", kind: "file.mutation", key: "m1", payload: { attempt } }]))
    }
    const live = store.readInFlight("s1", "file.mutation")
    expect(live).toHaveLength(1)
    expect(live[0]?.payload.attempt).toBe("third")
  })

  test("settling drops only its own key", () => {
    const store = openStore()
    store.append(fact("s1", [{ op: "put", kind: "file.mutation", key: "m1", payload: { path: "a" } }]))
    store.append(fact("s1", [{ op: "put", kind: "file.mutation", key: "m2", payload: { path: "b" } }]))
    store.append(fact("s1", [{ op: "drop", kind: "file.mutation", key: "m1" }]))

    expect(store.readInFlight("s1", "file.mutation").map((row) => row.key)).toEqual(["m2"])
  })

  test("a commit clears a whole chained kind at once", () => {
    const store = openStore()
    for (const key of ["e1", "e2", "e3"]) {
      store.append(fact("s1", [{ op: "put", kind: "chat.provisional", key, payload: { key } }]))
    }
    store.append(fact("s1", [{ op: "clear", kind: "chat.provisional" }]))
    expect(store.readInFlight("s1", "chat.provisional")).toEqual([])
  })

  test("reads back in insertion order, which an upsert preserves", () => {
    const store = openStore()
    for (const key of ["e1", "e2", "e3"]) {
      store.append(fact("s1", [{ op: "put", kind: "chat.provisional", key, payload: { key } }]))
    }
    // Rewriting the first entry must not move it to the end of the chain.
    store.append(fact("s1", [{ op: "put", kind: "chat.provisional", key: "e1", payload: { key: "e1", revised: true } }]))

    const chain = store.readInFlight("s1", "chat.provisional")
    expect(chain.map((row) => row.key)).toEqual(["e1", "e2", "e3"])
    expect(chain[0]?.payload.revised).toBe(true)
  })

  test("kinds and sessions never see each other", () => {
    const store = openStore()
    store.append(fact("s1", [{ op: "put", kind: "file.mutation", key: "m1", payload: {} }]))
    store.append(fact("s2", [{ op: "put", kind: "file.mutation", key: "m1", payload: {} }]))
    store.append(fact("s1", [{ op: "clear", kind: "chat.provisional" }]))

    expect(store.readInFlight("s1", "file.mutation")).toHaveLength(1)
    expect(store.readInFlight("s2", "file.mutation")).toHaveLength(1)
  })

  test("it is never a fact source: nothing lands in the event log", () => {
    const store = openStore()
    store.append(fact("s1", [{ op: "put", kind: "file.mutation", key: "m1", payload: { secret: "x" } }]))
    const stored = store.read({ aggregateId: "session:s1" })
    expect(stored).toHaveLength(1)
    // The request attribute is stripped, exactly like contentRows.
    expect("inFlight" in stored[0]!).toBe(false)
  })

  test("a standalone put records state with no fact beside it", () => {
    const store = openStore()
    // Preparation has no accompanying fact: the outcome fact comes later.
    store.putInFlight("s1", "file.mutation", "m1", { path: "a.ts", before: null })

    expect(store.readInFlight("s1", "file.mutation")).toHaveLength(1)
    // Nothing entered the log.
    expect(store.read({ aggregateId: "session:s1" })).toHaveLength(0)
  })

  test("the outcome fact and the retirement of its state land together", () => {
    const store = openStore()
    store.putInFlight("s1", "file.mutation", "m1", { path: "a.ts" })
    store.append(fact("s1", [{ op: "drop", kind: "file.mutation", key: "m1" }]))

    expect(store.readInFlight("s1", "file.mutation")).toEqual([])
    expect(store.read({ aggregateId: "session:s1" })).toHaveLength(1)
  })

  test("swap lands only on the exact value the caller validated", () => {
    const store = openStore()
    // Insert-if-absent: the second racer's expectation of absence fails.
    expect(store.swapInFlight("s1", "lease", "core", null, { owner: "a" })).toBe(true)
    expect(store.swapInFlight("s1", "lease", "core", null, { owner: "b" })).toBe(false)

    const cell = store.readInFlight("s1", "lease", )[0]
    if (!cell) throw new Error("expected a cell")
    // Replace-if-matching: a stale expectation loses, the exact bytes win.
    expect(store.swapInFlight("s1", "lease", "core", JSON.stringify({ owner: "stale" }), { owner: "c" })).toBe(false)
    expect(store.swapInFlight("s1", "lease", "core", cell.raw, { owner: "c" })).toBe(true)

    // Delete-if-matching: same guard, payload null retires the cell.
    const replaced = store.readInFlight("s1", "lease")[0]
    if (!replaced) throw new Error("expected a cell")
    expect(store.swapInFlight("s1", "lease", "core", cell.raw, null)).toBe(false)
    expect(store.swapInFlight("s1", "lease", "core", replaced.raw, null)).toBe(true)
    expect(store.readInFlight("s1", "lease")).toEqual([])
  })

  test("a stale terminal swap rolls back its fact and preserves the cell", () => {
    const store = openStore()
    store.putInFlight("s1", "file.mutation", "tool", { cursor: 0 })
    const cell = store.readInFlight("s1", "file.mutation")[0]
    if (!cell) throw new Error("expected a cell")

    expect(() => store.append(fact("s1", [{
      op: "swap",
      kind: "file.mutation",
      key: "tool",
      expectedRaw: JSON.stringify({ cursor: 1 }),
      payload: null,
    }]))).toThrow()
    expect(store.read({ aggregateId: "session:s1" })).toEqual([])
    expect(store.readInFlight("s1", "file.mutation")[0]?.raw).toBe(cell.raw)

    store.append(fact("s1", [{ op: "swap", kind: "file.mutation", key: "tool", expectedRaw: cell.raw, payload: null }]))
    expect(store.read({ aggregateId: "session:s1" })).toHaveLength(1)
    expect(store.readInFlight("s1", "file.mutation")).toEqual([])
  })

  test("one append atomically settles several exact checkpoint values", () => {
    const store = openStore()
    store.putInFlight("s1", "finalized-tool-result", "t1", { ordinal: 0 })
    store.putInFlight("s1", "finalized-tool-result", "t2", { ordinal: 1 })
    const [first, second] = store.readInFlight("s1", "finalized-tool-result")
    if (!first || !second) throw new Error("expected finalized result cells")

    store.append(fact("s1", [
      { op: "swap", kind: "finalized-tool-result", key: "t1", expectedRaw: first.raw, payload: null },
      { op: "swap", kind: "finalized-tool-result", key: "t2", expectedRaw: second.raw, payload: null },
    ]))

    expect(store.readInFlight("s1", "finalized-tool-result")).toEqual([])
    expect(store.read({ aggregateId: "session:s1" })).toHaveLength(1)
  })

  test("a state-only guarded batch retires all cells or none", () => {
    const store = openStore()
    store.putInFlight("s1", "finalized-tool-result", "t1", { ordinal: 0 })
    store.putInFlight("s1", "finalized-tool-result", "t2", { ordinal: 1 })
    const [first, second] = store.readInFlight("s1", "finalized-tool-result")
    if (!first || !second) throw new Error("expected finalized result cells")

    expect(store.swapInFlightBatch("s1", [
      { op: "swap", kind: first.kind, key: first.key, expectedRaw: first.raw, payload: null },
      { op: "swap", kind: second.kind, key: second.key, expectedRaw: "stale", payload: null },
    ])).toBe(false)
    expect(store.readInFlight("s1", "finalized-tool-result")).toHaveLength(2)

    expect(store.swapInFlightBatch("s1", [
      { op: "swap", kind: first.kind, key: first.key, expectedRaw: first.raw, payload: null },
      { op: "swap", kind: second.kind, key: second.key, expectedRaw: second.raw, payload: null },
    ])).toBe(true)
    expect(store.readInFlight("s1", "finalized-tool-result")).toEqual([])
  })

  test("swap refuses to expect absence and write absence", () => {
    const store = openStore()
    expect(() => store.swapInFlight("s1", "lease", "core", null, null)).toThrow()
  })
})
