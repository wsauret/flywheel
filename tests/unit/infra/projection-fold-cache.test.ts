import { Database } from "bun:sqlite"
import { afterEach, expect, spyOn, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Equal, HashMap, HashSet, Option } from "effect"
import { createEventProjection } from "../../../src/infra/event-projection.js"
import { transferEventOwnership } from "../../../src/infra/event-owner-transfer.js"
import { asAsyncEventReadSurface, type AsyncEventReadSurface, type EventStoreAppend, type FactQuery, type StoredFact } from "../../../src/infra/event-store-types.js"
import { attachProjectionFoldCache, openProjectionFoldCache, type FoldCacheSlot, type FoldSavePolicy } from "../../../src/infra/projection-fold-cache.js"
import { heldProjection } from "../../../src/infra/projection-registry.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { migrateFactVersions } from "../../../src/orchestration/migrations/engine.js"
import { deleteRetiredFamilyChunk } from "../../../src/orchestration/session/event-store-maintenance.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const directory = temporaryDirectories()
const opened: { close(): void }[] = []
afterEach(() => {
  for (const owned of opened.splice(0).toReversed()) owned.close()
})

const HISTORY = 20
const KEY = "tally"
/** Saves every fold as soon as the folding task ends. */
const SAVE_AT_ONCE: FoldSavePolicy = { afterFacts: 1, quietMs: 0 }

interface Tally { counted: number; values: number[]; latestQueue: number | null }

type LocalSqliteEventStore = ReturnType<typeof createSqliteEventStore>

type TallyScope = Pick<FactQuery, "aggregateId" | "types">
const TALLY_SCOPE: TallyScope = { aggregateId: "tally:a" }

function tallyDefinition(onReduce: () => void, scope: TallyScope = TALLY_SCOPE): Parameters<typeof createEventProjection<Tally>>[1] {
  return {
    name: KEY,
    aggregateId: scope.aggregateId,
    factTypes: scope.types,
    initialState: () => ({ counted: 0, values: [], latestQueue: null }),
    // A replace-latest family folds to its newest row, so a prune of the
    // rows before it changes nothing; every other fact counts.
    reduce: (state: Tally, stored: StoredFact) => {
      onReduce()
      const value = typeof stored.payload.value === "number" ? stored.payload.value : -1
      return stored.type === "queue.state.changed"
        ? { ...state, latestQueue: value }
        : { ...state, counted: state.counted + 1, values: [...state.values, value] }
    },
  }
}

function fact(aggregateId: string, value: number, type = "tally.counted"): EventStoreAppend {
  return { aggregateId, sessionId: "s", type, version: 1, timestamp: value, actor: "flywheel", payload: { value } }
}

function fixture() {
  const root = directory("fold-cache-")
  const storePath = join(root, "events.sqlite")
  const store = createSqliteEventStore(storePath)
  opened.push(store)
  store.appendBatch(Array.from({ length: HISTORY }, (_, index) => fact("tally:a", index)))
  return { store, storePath, cachePath: join(root, "folds.sqlite") }
}

/** Lets the requested saves start, then waits for every one of them. */
async function saves(...replays: (() => Promise<object | null>)[]): Promise<void> {
  await Bun.sleep(1)
  for (const replay of replays) await replay()
}

/** One process over the store: its own reader, held registry, and cache. */
function processOver(store: LocalSqliteEventStore, cachePath: string, identity = "build-a", scope: TallyScope = TALLY_SCOPE) {
  const reader: AsyncEventReadSurface = { ...asAsyncEventReadSurface(store) }
  const cache = openProjectionFoldCache(cachePath, identity, SAVE_AT_ONCE)
  opened.push(cache)
  attachProjectionFoldCache([reader], cache, "executor")
  let reduced = 0
  const projection = () => heldProjection(reader, KEY, () => createEventProjection(reader, tallyDefinition(() => { reduced += 1 }, scope)))
  const replay = () => projection().replay()
  return { replay, reduced: () => reduced, saved: () => saves(replay), cache }
}

/** The state a projection with no cache folds from every fact. */
function rebuilt(store: LocalSqliteEventStore, scope: TallyScope = TALLY_SCOPE): Promise<Tally> {
  return createEventProjection(asAsyncEventReadSurface(store), tallyDefinition(() => {}, scope)).replay()
}

async function savedFold(store: LocalSqliteEventStore, cachePath: string, scope: TallyScope = TALLY_SCOPE): Promise<void> {
  const first = processOver(store, cachePath, "build-a", scope)
  await first.replay()
  expect(first.reduced()).toBe(store.read(scope).length)
  await first.saved()
}

test("a later process starts from the saved fold, folds only the facts after it, and equals a full rebuild", async () => {
  const { store, cachePath } = fixture()
  await savedFold(store, cachePath)
  store.appendBatch([fact("tally:a", 1_000), fact("tally:a", 1_001)])
  const second = processOver(store, cachePath)
  expect(await second.replay()).toEqual(await rebuilt(store))
  expect(second.reduced()).toBe(2)
})

test("a process of another build never reads the fold", async () => {
  const { store, cachePath } = fixture()
  await savedFold(store, cachePath)
  const other = processOver(store, cachePath, "build-b")
  expect(await other.replay()).toEqual(await rebuilt(store))
  expect(other.reduced()).toBe(HISTORY)
})

test("a cache file of an older format is emptied when it opens, and then saves and loads", async () => {
  const path = join(directory("fold-cache-format-"), "folds.sqlite")
  const old = new Database(path)
  old.exec(`create table fold (role text not null, key text not null, code text not null, position integer not null, read_position integer not null,
    anchor_position integer, anchor_id text, generation integer not null, written_at integer not null, state blob not null, primary key (role, key))`)
  old.query("insert into fold values ('executor', ?, 'build-a', 1, 1, null, null, 0, 0, ?)").run(KEY, new Uint8Array([1, 2, 3]))
  old.exec("pragma user_version = 1")
  old.close()
  const slot = cacheSlot(path)
  expect(slot.load()).toBeUndefined()
  const reopened = new Database(path, { readonly: true })
  expect(reopened.query<{ user_version: number }, []>("pragma user_version").get()?.user_version).toBe(2)
  reopened.close()
  expect(await saveAt(slot, { at: 1 })).toBe(true)
  expect(slot.adopt(slot.load()!, evidenceAt(1))).toEqual({ at: 1 })
})

test("a fold that a rewrite in its scope overtook before the save is never saved", async () => {
  const { store, storePath, cachePath } = fixture()
  const first = processOver(store, cachePath)
  await first.replay()
  rawExec(storePath, "update event set payload = '{\"value\":7}' where position = 1")
  await first.saved()
  const second = processOver(store, cachePath)
  expect(await second.replay()).toEqual(await rebuilt(store))
  expect(second.reduced()).toBe(HISTORY)
})

function rawExec(storePath: string, sql: string): void {
  const db = new Database(storePath)
  try { db.exec(sql) } finally { db.close() }
}

interface RewriteCase {
  readonly name: string
  /** The folded scope, `tally:a` when absent. */
  readonly scope?: TallyScope
  readonly setup?: (store: LocalSqliteEventStore) => void
  readonly rewrite: (store: LocalSqliteEventStore, storePath: string) => void
  /** The fold stays current: the rewrite changed nothing that it folded. */
  readonly keeps: boolean
  /** No fact of the scope follows the rewrite, so the fold alone decides the state. */
  readonly last?: boolean
}

const rewrites: RewriteCase[] = [
  {
    name: "an update of a fact in scope by another connection, as a migration or CLI maintenance writes it",
    rewrite: (_store, storePath) => rawExec(storePath, "update event set payload = '{\"value\":-5}' where position = 10"),
    keeps: false,
  },
  {
    name: "a stored-fact version migration",
    rewrite: (_store, storePath) => {
      migrateFactVersions(storePath, "fold-cache-test", [{ type: "tally.counted", fromVersion: 1, rebuild: (payload, actor) => ({ version: 2, actor, payload: { ...payload, value: 0 } }) }])
    },
    keeps: false,
  },
  {
    name: "the deletion of the aggregate",
    rewrite: (store) => { store.deleteAggregate("tally:a") },
    keeps: false,
  },
  {
    name: "an owner transfer into the aggregate",
    setup: (store) => { store.append(fact("tally:b", 9_000)) },
    rewrite: (_store, storePath) => {
      const db = new Database(storePath)
      try {
        const moved = db.query<{ position: number }, []>("select position from event where aggregate_id = 'tally:b'").all().map((row) => row.position)
        db.exec("begin immediate")
        transferEventOwnership(db, moved, "s", "tally:a")
        db.exec("commit")
      } finally { db.close() }
    },
    keeps: false,
  },
  {
    name: "a prune of a retired family",
    setup: (store) => { store.append(fact("tally:a", 8_000, "span.started")) },
    rewrite: (_store, storePath) => { expect(deleteRetiredFamilyChunk(storePath, "span.started")).toBe(1) },
    keeps: false,
  },
  {
    name: "a prune of the superseded rows of a replace-latest family",
    setup: (store) => { store.appendBatch([fact("tally:a", 1, "queue.state.changed"), fact("tally:a", 2, "queue.state.changed")]) },
    rewrite: (store) => { expect(store.pruneSupersededEvents("tally:a", "queue.state.changed")).toBe(1) },
    keeps: true,
  },
  {
    name: "the deletion of an aggregate whose scope holds only replace-latest facts",
    scope: { aggregateId: "tally:a", types: ["queue.state.changed"] },
    // A later fact elsewhere keeps the store's head past the fold.
    setup: (store) => { store.appendBatch([fact("tally:a", 1, "queue.state.changed"), fact("tally:b", 1)]) },
    rewrite: (store) => { store.deleteAggregate("tally:a") },
    keeps: false,
    last: true,
  },
  {
    name: "an update of a fact of a family scope in another aggregate",
    scope: { types: ["tally.counted"] },
    setup: (store) => { store.append(fact("tally:b", 1)) },
    rewrite: (_store, storePath) => rawExec(storePath, "update event set payload = '{\"value\":4}' where aggregate_id = 'tally:b'"),
    keeps: false,
  },
  {
    name: "the deletion of an aggregate that a family scope reads only replace-latest facts of",
    scope: { types: ["tally.counted", "queue.state.changed"] },
    setup: (store) => { store.append(fact("tally:b", 1, "queue.state.changed")) },
    rewrite: (store) => { store.deleteAggregate("tally:b") },
    keeps: false,
  },
  {
    name: "an update of a fact of another family than a family scope reads",
    scope: { types: ["tally.counted"] },
    setup: (store) => { store.append(fact("tally:b", 1, "other.fact")) },
    rewrite: (_store, storePath) => rawExec(storePath, "update event set payload = '{\"value\":4}' where type = 'other.fact'"),
    keeps: true,
  },
  {
    name: "an update of a fact outside the scope",
    setup: (store) => { store.append(fact("tally:b", 1)) },
    rewrite: (_store, storePath) => rawExec(storePath, "update event set payload = '{\"value\":3}' where aggregate_id = 'tally:b'"),
    keeps: true,
  },
]

test.each(rewrites)("after $name, the next process equals a full rebuild", async ({ scope = TALLY_SCOPE, setup, rewrite, keeps, last = false }) => {
  const { store, storePath, cachePath } = fixture()
  setup?.(store)
  await savedFold(store, cachePath, scope)
  rewrite(store, storePath)
  if (!last) store.append(fact("tally:a", 2_000, scope.types?.[0]))
  const later = processOver(store, cachePath, "build-a", scope)
  expect(await later.replay()).toEqual(await rebuilt(store, scope))
  expect(later.reduced()).toBe(keeps ? 1 : store.read(scope).length)
})

test("a store created before the rewrite generation existed records rewrites once it opens", () => {
  const storePath = join(directory("fold-cache-legacy-"), "events.sqlite")
  const legacy = createSqliteEventStore(storePath)
  legacy.append(fact("tally:a", 1))
  legacy.close()
  rawExec(storePath, "drop trigger event_rewrite_on_update; drop trigger event_rewrite_on_delete; drop trigger event_rewrite_on_aggregate_delete; drop table event_rewrite")
  const store = createSqliteEventStore(storePath)
  opened.push(store)
  rawExec(storePath, "update event set payload = '{\"value\":2}'")
  expect(store.foldEvidence({ aggregateId: "tally:a" }, 1).generation).toBe(1)
})

function cacheSlot(path = join(directory("fold-cache-slot-"), "folds.sqlite"), identity = "build-a", policy: FoldSavePolicy = {}): FoldCacheSlot {
  const cache = openProjectionFoldCache(path, identity, policy)
  opened.push(cache)
  return cache.slot("executor", KEY)
}

const evidenceAt = (readPosition: number) => ({ head: readPosition, generation: 0, anchor: null })

function saveAt<S extends object>(slot: FoldCacheSlot, state: S, readPosition = 1, contended = () => false): Promise<boolean> {
  return slot.save({ state, position: readPosition, readPosition, generation: 0, evidence: evidenceAt(readPosition), contended })
}

/** HashMap and HashSet entries in one order, so that two equal collections
 *  built in different orders compare equal. */
const sortedEntries = (collection: Iterable<unknown>): string[] => Array.from(collection, (entry) => JSON.stringify(entry)).sort()

test("Effect collections, shared references, and an own __proto__ key survive the cache, and a value it cannot restore refuses the state", async () => {
  const shared = { name: "shared" }
  // Handoff content is JSON that an agent wrote, and JSON.parse makes `__proto__` an own key.
  const handoff: object = JSON.parse('{"summary":"done","__proto__":{"polluted":true}}')
  const buffer = new Uint8Array([1, 2, 3, 4])
  const views = [buffer.subarray(0, 2), buffer.subarray(2)]
  const state = { map: HashMap.make(["a", shared]), set: HashSet.make("x", "y"), plain: new Map([["b", shared]]), when: new Date(5), handoff, views }
  const slot = cacheSlot()
  expect(await saveAt(slot, state)).toBe(true)
  const restored = slot.adopt<typeof state>(slot.load()!, evidenceAt(1))!
  expect(restored.views).toEqual(views)
  expect(restored.views[0]!.buffer).toBe(restored.views[1]!.buffer)
  expect(Equal.equals(HashSet.make("x", "y"), restored.set)).toBe(true)
  expect(Option.getOrUndefined(HashMap.get(restored.map, "a"))).toBe(restored.plain.get("b"))
  expect(restored.when).toEqual(new Date(5))
  expect(Object.getOwnPropertyDescriptor(restored.handoff, "__proto__")?.value).toEqual({ polluted: true })
  expect(Object.getPrototypeOf(restored.handoff)).toBe(Object.prototype)

  class Index { readonly entries = [1] }
  const withHidden = Object.defineProperty({}, "hidden", { value: 1, enumerable: false })
  const withGetter = Object.defineProperty({}, "computed", { get: () => 1, enumerable: true })
  // oxlint-disable-next-line no-sparse-arrays -- the hole is the value under test
  const sparse = [1, , 3]
  // An extra property would travel inline but be lost when its container is
  // rebuilt, so each is refused however small the container is.
  const extra = <T extends object>(value: T): T => Object.assign(value, { extra: 1 })
  const many = Array.from({ length: 50_000 }, (_, index) => index)
  const bytes = new Uint8Array(4)
  const unrestorables = [
    new Index(), new (class extends Map<string, number> {})(), { [Symbol("key")]: 1 }, withHidden, withGetter, Object.create(null), sparse,
    extra([1, 2]), extra(new Map([["a", 1]])), extra(new Date(5)),
    // Views of one buffer in two slices would restore with two buffers.
    [bytes.subarray(0, 2), many, bytes.subarray(2)],
  ]
  for (const unrestorable of unrestorables) {
    expect(await saveAt(cacheSlot(), { value: unrestorable })).toBe(false)
  }
})

test("a state that spans many slices round-trips exactly, with every container kind split across slices", async () => {
  const rows = Array.from({ length: 30_000 }, (_, index) => ({ index, name: `row ${index}`, tags: [index % 7, [index % 3]] }))
  const state = {
    rows,
    nested: [Array.from({ length: 25_000 }, (_, index) => index), [[1, 2], { deep: "value" }]],
    record: Object.fromEntries(Array.from({ length: 25_000 }, (_, index) => [`key ${index}`, { index }])),
    plainMap: new Map(Array.from({ length: 20_000 }, (_, index) => [index, `value ${index}`])),
    plainSet: new Set(Array.from({ length: 20_000 }, (_, index) => `member ${index}`)),
    hashMap: HashMap.fromIterable(Array.from({ length: 20_000 }, (_, index) => [`session ${index}`, { index, set: HashSet.make(index) }] as const)),
    hashSet: HashSet.fromIterable(Array.from({ length: 20_000 }, (_, index) => `id ${index}`)),
    when: new Date(7),
    bytes: new Uint8Array([1, 2, 3]),
    small: { a: 1, list: [] },
  }
  const slot = cacheSlot()
  expect(await saveAt(slot, state)).toBe(true)
  const restored = slot.adopt<typeof state>(slot.load()!, evidenceAt(1))!
  const comparable = (value: typeof state) => ({
    ...value,
    hashMap: sortedEntries(HashMap.map(value.hashMap, (entry) => ({ index: entry.index, set: sortedEntries(entry.set) }))),
    hashSet: sortedEntries(value.hashSet),
  })
  expect(comparable(restored)).toEqual(comparable(state))
  expect(Option.getOrUndefined(HashMap.get(restored.hashMap, "session 3"))?.set.pipe(HashSet.has(3))).toBe(true)
  expect([...restored.plainMap.keys()]).toEqual([...state.plainMap.keys()])
  expect(Object.keys(restored.record)).toEqual(Object.keys(state.record))
})

test("a save yields to the event loop between the slices that it walks", async () => {
  // On a busy host the compression can complete before the event loop runs
  // a timer or an immediate, as a compression that has already finished does.
  const compress = spyOn(Bun, "zstdCompress").mockImplementation(async (data, options) => Bun.zstdCompressSync(data, options))
  let ticks = 0
  let ticking = true
  const tick = (): void => { ticks += 1; if (ticking) setImmediate(tick) }
  setImmediate(tick)
  // The walk reads every property through this trap, so it records which
  // turn of the event loop each slice of the walk ran in.
  const target = Object.fromEntries(Array.from({ length: 100_000 }, (_, index) => [`key ${index}`, index]))
  const walkedIn = new Set<number>()
  const rows = new Proxy(target, { getOwnPropertyDescriptor: (object, key) => { walkedIn.add(ticks); return Reflect.getOwnPropertyDescriptor(object, key) } })
  const slot = cacheSlot()
  try {
    expect(await saveAt(slot, { rows })).toBe(true)
  } finally {
    ticking = false
    compress.mockRestore()
  }
  expect(walkedIn.size).toBeGreaterThan(5)
  expect(slot.adopt<{ rows: object }>(slot.load()!, evidenceAt(1))?.rows).toEqual(target)
})

test("a contended save gives up between slices without writing, and a later save writes", async () => {
  const state = { rows: Array.from({ length: 100_000 }, (_, index) => index) }
  const slot = cacheSlot()
  let asked = 0
  expect(await saveAt(slot, state, 1, () => { asked += 1; return true })).toBe(false)
  expect(asked).toBe(1)
  expect(slot.load()).toBeUndefined()
  expect(slot.accepts()).toBe(true)
  expect(await saveAt(slot, state)).toBe(true)
  expect(slot.adopt(slot.load()!, evidenceAt(1))).toEqual(state)

  // A save of one slice holds the lane for no longer than a fold would.
  asked = 0
  const single = cacheSlot()
  expect(await saveAt(single, { at: 1 }, 1, () => { asked += 1; return true })).toBe(true)
  expect(asked).toBe(0)
  expect(single.adopt(single.load()!, evidenceAt(1))).toEqual({ at: 1 })
})

test.each([
  { contender: "a pushed fact", newFact: true },
  { contender: "a queued read", newFact: true },
  { contender: "a queued read with no new fact", newFact: false },
])("$contender makes the save in progress give up, and a later save writes the newest fold unasked", async ({ contender, newFact }) => {
  const { store, cachePath } = fixture()
  const reader: AsyncEventReadSurface = { ...asAsyncEventReadSurface(store) }
  // The first evidence read proves the first page; the second one starts the save.
  let evidenceReads = 0
  const saving = Promise.withResolvers<void>()
  const counted: AsyncEventReadSurface = {
    ...reader,
    readPage: (...args) => {
      if (args[5]) evidenceReads += 1
      if (evidenceReads === 2) saving.resolve()
      return reader.readPage(...args)
    },
  }
  // A catch-up of one fact never asks for a save, so only the give-up can.
  const cache = openProjectionFoldCache(cachePath, "build-a", { afterFacts: 2, quietMs: 0 })
  opened.push(cache)
  attachProjectionFoldCache([counted], cache, "executor")
  // Each fact adds many values, so the fold takes many slices to save.
  let reduced = 0
  const definition = {
    ...tallyDefinition(() => {}),
    reduce: (state: Tally, stored: StoredFact) => {
      reduced += 1
      return { ...state, counted: state.counted + 1, values: [...state.values, ...Array.from({ length: 10_000 }, () => Number(stored.payload.value))] }
    },
  }
  const projection = heldProjection(counted, KEY, () => createEventProjection(counted, definition))
  await projection.replay()
  await saving.promise
  await Bun.sleep(1)
  const later = newFact ? store.appendBatch([fact("tally:a", 3_000)])[0]! : undefined
  await (contender === "a pushed fact" ? projection.apply(later!) : projection.replay())
  const slot = cacheSlot(cachePath)
  expect(slot.load()).toBeUndefined()
  const written = (later ?? store.read(TALLY_SCOPE).at(-1)!).position
  for (let wait = 0; wait < 500 && slot.load()?.readPosition !== written; wait += 1) await Bun.sleep(2)
  expect(slot.load()?.readPosition).toBe(written)
  const rebuiltState = await createEventProjection(asAsyncEventReadSurface(store), definition).replay()

  const next: AsyncEventReadSurface = { ...asAsyncEventReadSurface(store) }
  const nextCache = openProjectionFoldCache(cachePath, "build-a", SAVE_AT_ONCE)
  opened.push(nextCache)
  attachProjectionFoldCache([next], nextCache, "executor")
  reduced = 0
  expect(await heldProjection(next, KEY, () => createEventProjection(next, definition)).replay()).toEqual(rebuiltState)
  expect(reduced).toBe(0)
})

test("a reference shared across slices refuses the state for its build", async () => {
  const path = join(directory("fold-cache-shared-"), "folds.sqlite")
  const shared = { name: "shared" }
  expect(await saveAt(cacheSlot(path), { first: shared, between: Array.from({ length: 50_000 }, (_, index) => index), second: shared })).toBe(false)
  expect(cacheSlot(path).accepts()).toBe(false)
})

test("a state is refused for its build when its compressed bytes pass the cap, and saved when only its raw bytes do", async () => {
  const path = join(directory("fold-cache-bytes-"), "folds.sqlite")
  expect(await saveAt(cacheSlot(path), { bytes: new Uint8Array(randomBytes(9 * 1024 * 1024)) })).toBe(false)
  expect(cacheSlot(path).accepts()).toBe(false)
  expect(cacheSlot(path).load()).toBeUndefined()

  // The large bytes fill a slice by their size, and the refusal comes before
  // the walk reaches the next slice.
  let visited = 0
  const after = new Proxy({}, { getPrototypeOf: (target) => { visited += 1; return Reflect.getPrototypeOf(target) } })
  expect(await saveAt(cacheSlot(), { bytes: new Uint8Array(randomBytes(13 * 1024 * 1024)), after })).toBe(false)
  expect(visited).toBe(0)

  const text = "x".repeat(9 * 1024 * 1024)
  const slot = cacheSlot()
  expect(await saveAt(slot, { text })).toBe(true)
  expect(slot.load()!.bytes.byteLength).toBeLessThan(1024 * 1024)
  expect(slot.adopt<{ text: string }>(slot.load()!, evidenceAt(1))?.text).toBe(text)
})

test("a write never moves a fold of the same build back, and reports that it wrote nothing", async () => {
  const slot = cacheSlot()
  expect(await saveAt(slot, { at: 10 }, 10)).toBe(true)
  expect(await saveAt(slot, { at: 5 }, 5)).toBe(false)
  expect(slot.load()?.readPosition).toBe(10)
})

test("a fold that a rewrite overtook is not written", async () => {
  const slot = cacheSlot()
  expect(await slot.save({ state: { at: 1 }, position: 1, readPosition: 1, generation: 0, evidence: { head: 1, generation: 1, anchor: null }, contended: () => false })).toBe(false)
  expect(slot.load()).toBeUndefined()
})

test("closing the cache cancels the saves that its projections requested, before they read or encode anything", async () => {
  const { store, cachePath } = fixture()
  const reader: AsyncEventReadSurface = { ...asAsyncEventReadSurface(store) }
  let evidenceReads = 0
  const counted: AsyncEventReadSurface = { ...reader, readPage: (...args) => { if (args[5]) evidenceReads += 1; return reader.readPage(...args) } }
  const cache = openProjectionFoldCache(cachePath, "build-a", SAVE_AT_ONCE)
  attachProjectionFoldCache([counted], cache, "executor")
  const projection = heldProjection(counted, KEY, () => createEventProjection(counted, tallyDefinition(() => {})))
  await projection.replay()
  expect(evidenceReads).toBe(1)
  cache.close()
  cache.close()
  await saves(() => projection.replay())
  expect(evidenceReads).toBe(1)
  expect(cacheSlot(cachePath).load()).toBeUndefined()

  const slot = cacheSlot(cachePath)
  const closing = openProjectionFoldCache(cachePath, "build-a", SAVE_AT_ONCE)
  const queued = closing.slot("executor", KEY)
  let ran = 0
  queued.folded(1, 0, () => { ran += 1 })
  closing.close()
  await Bun.sleep(1)
  expect(ran).toBe(0)
  expect(queued.accepts()).toBe(false)
  expect(await saveAt(queued, { at: 1 })).toBe(false)
  expect(slot.load()).toBeUndefined()
})

test.skipIf(process.platform === "win32")("the cache file is private to its owner", async () => {
  const path = join(directory("fold-cache-private-"), "folds.sqlite")
  writeFileSync(path, "", { mode: 0o644 })
  expect(await saveAt(cacheSlot(path), { at: 1 })).toBe(true)
  expect(statSync(path).mode & 0o777).toBe(0o600)
})

test("M cached projections read evidence once each and save once each, however many catch-ups they fold", async () => {
  const { store, cachePath } = fixture()
  const local = asAsyncEventReadSurface(store)
  const evidence: unknown[] = []
  const reader: AsyncEventReadSurface = { ...local, readPage: (...args) => { if (args[5]) evidence.push(args[5]); return local.readPage(...args) } }
  const cache = openProjectionFoldCache(cachePath, "build-a", SAVE_AT_ONCE)
  opened.push(cache)
  attachProjectionFoldCache([reader], cache, "executor")
  const aggregates = ["tally:a", "tally:b", "tally:c"]
  const projections = aggregates.map((aggregateId) =>
    heldProjection(reader, `tally:${aggregateId}`, () => createEventProjection(reader, tallyDefinition(() => {}, { aggregateId }))))
  for (const projection of projections) await projection.replay()
  // Each catch-up folds with no task boundary between them, so all of them
  // fall in one quiet period.
  for (let round = 0; round < 4; round += 1) {
    for (const [index, projection] of projections.entries()) {
      store.append(fact(aggregates[index]!, round))
      await projection.replay()
    }
  }
  expect(evidence).toHaveLength(aggregates.length)
  await saves(...projections.map((projection) => () => projection.replay()))
  expect(evidence).toHaveLength(2 * aggregates.length)
})
