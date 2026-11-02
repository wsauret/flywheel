import { Database } from "bun:sqlite"
import { deserialize, serialize } from "bun:jsc"
import { HashMap, HashSet } from "effect"
import { errorMessage } from "./error-message.js"
import type { AsyncEventReadSurface, FoldAnchor, FoldEvidence } from "./event-store-types.js"
import { Log } from "./log.js"
import { durationMs } from "./operation-log.js"
import { admitPrivateDatabaseFiles, ensurePrivateFile } from "./private-path.js"
import { coalesceRepeats } from "./repeat-coalescer.js"
import { applySqliteBusyTimeout, applySqliteDurabilityPragmas, isSqliteBusyError } from "./sqlite-durability.js"

/** The persisted fold cache (ARCH-SUBSTRATE-003, ARCH-SUBSTRATE-020,
 *  ARCH-SUBSTRATE-046): the folded state of a held projection, saved so that
 *  a later process can start from it instead of from position 0.
 *
 *  It is disposable. An entry records the code identity that folded it, the
 *  position it folded through, the rewrite generation of its scope, and an
 *  anchor fact; a projection adopts an entry only when the store proves all
 *  of them current, and anything else is a miss that rebuilds. A failure of
 *  the cache file itself is also a miss: no projection ever fails because of
 *  this cache. */

const log = Log.create({ service: "projection-fold-cache" })

/** The layout of the file. A file of another layout is emptied when it opens,
 *  so no entry is ever decoded by code that did not write its layout. */
const FOLD_CACHE_FORMAT = 2
/** A state that compresses to more bytes is refused, because the write of
 *  one entry grows with its bytes: a 20 MB replace takes about 100 ms. The
 *  encoding counts the bytes slice by slice, so a refusal stops at the
 *  slice that passes the cap. */
const MAX_FOLD_BYTES = 8 * 1024 * 1024
/** The values that one slice of an encoding walks and serializes on the
 *  folding thread before the save yields: about 5 ms on a fast core. */
const SLICE_VALUES = 12_000
/** Folds that read this many facts since the last save, or spent this long
 *  reducing them, are worth saving so that the next process does not repeat
 *  them. The time counts reducing only, never the reads and yields between
 *  pages. */
const SAVE_AFTER_FACTS = 500
const SAVE_AFTER_FOLD_MS = 100
/** A slot saves once it has folded nothing for this long, so a busy
 *  aggregate never pays for an encoding per catch-up. */
const SAVE_QUIET_MS = 2_000
/** The file keeps at most this many state bytes; a write drops the entries
 *  written longest ago past it. */
const MAX_CACHE_BYTES = 256 * 1024 * 1024
/** A process that reads the cache must never wait for another one's lock. */
const BUSY_TIMEOUT_MS = 0
/** The one wait the cache allows: for another process that resets the
 *  format of the same file, which commits within a few milliseconds. */
const FORMAT_RESET_WAIT_MS = 1_000

/** One persisted fold, not yet proven current. */
export interface CachedFold {
  readonly position: number
  readonly readPosition: number
  readonly anchor: FoldAnchor | null
  readonly generation: number
  readonly bytes: Uint8Array
}

/** The fold of one held projection to persist. */
interface FoldToSave {
  readonly state: object
  readonly position: number
  readonly readPosition: number
  /** The scope's rewrite generation before the first fact that the fold read. */
  readonly generation: number
  /** What the store read at `readPosition`, after the last fold. */
  readonly evidence: FoldEvidence
  /** True once another task waits on the projection's read lane. The save
   *  holds that lane so that no fold changes the state between its slices,
   *  so it gives up rather than delay the waiting task. */
  readonly contended: () => boolean
}

/** The cache entry of one held projection in one placement. */
export interface FoldCacheSlot {
  /** The stored entry of this code identity, or undefined. */
  load(): CachedFold | undefined
  /** The stored state when `evidence`, read at the entry's read position,
   *  proves the entry current, or undefined after it discards the entry. */
  adopt<S extends object>(fold: CachedFold, evidence: FoldEvidence): S | undefined
  /** Counts a fold of `facts` facts that spent `foldMs` reducing them. Once
   *  the folds since the last save are worth saving, it runs `save` after
   *  the slot has folded nothing for the quiet period. Closing the cache
   *  cancels it. Nothing waits for a save: a process that exits first keeps
   *  the fold it last saved. */
  folded(facts: number, foldMs: number, save: () => void): void
  /** False when no fold of this key can be written: the cache is closed or
   *  unavailable, or the key is recorded as uncacheable for this code
   *  identity. A save asks before it reads or encodes anything. */
  accepts(): boolean
  /** Encodes and writes the fold slice by slice, yielding to the event loop
   *  between slices, and resolves to whether it wrote it. It writes nothing
   *  when `accepts()` is false, when a rewrite in the scope overtook the
   *  fold, when the stored entry of this code identity folded further, or
   *  when the state cannot be cached. A state that holds a value the
   *  encoding cannot restore, or that compresses to too many bytes, records
   *  its key as uncacheable for this code identity, so no later process of
   *  this code encodes it again. A save that gives up because the fold is
   *  `contended` asks again after the next quiet period. */
  save(fold: FoldToSave): Promise<boolean>
}

export interface ProjectionFoldCache {
  slot(role: string, key: string): FoldCacheSlot
  /** Stops admission and closes the file: every requested save is
   *  cancelled, a save already queued writes nothing, later loads miss, and
   *  later requests do nothing. */
  close(): void
}

interface Attachment { readonly cache: ProjectionFoldCache; readonly role: string }
// Keyed by reader identity for the reason `heldProjection` keys by it: a held
// projection is held for one reader, and its placement's cache belongs to
// that reader's composition.
const attachments = new WeakMap<AsyncEventReadSurface, Attachment>()

/** Lets every projection held for these readers start from, and save to,
 *  `cache`. `role` names the placement: two placements may fold one key
 *  differently, so they never share an entry. */
export function attachProjectionFoldCache(readers: readonly AsyncEventReadSurface[], cache: ProjectionFoldCache, role: string): void {
  for (const reader of readers) attachments.set(reader, { cache, role })
}

/** The cache entry of the projection held for `key` over `reader`, or
 *  undefined when no cache is attached to the reader. */
export function foldCacheSlot(reader: AsyncEventReadSurface, key: string): FoldCacheSlot | undefined {
  const attachment = attachments.get(reader)
  return attachment?.cache.slot(attachment.role, key)
}

/** One decision about one entry, recorded once and then counted. */
interface FoldDecision {
  readonly decision: "stale" | "not saved" | "not cached"
  readonly role: string
  readonly key: string
  readonly reason: string
}

/** When a slot saves. Tests replace it to save small folds without waiting. */
export interface FoldSavePolicy {
  readonly afterFacts?: number
  readonly quietMs?: number
}

/** A cache in the SQLite file at `path`, opened on its first use so that
 *  composing it costs nothing. `codeIdentity` names the code that folds:
 *  an entry of another identity is never read. */
export function openProjectionFoldCache(path: string, codeIdentity: string, policy: FoldSavePolicy = {}): ProjectionFoldCache {
  const afterFacts = policy.afterFacts ?? SAVE_AFTER_FACTS
  const quietMs = policy.quietMs ?? SAVE_QUIET_MS
  let db: Database | undefined
  let unavailable = false
  const requestedSaves = new Set<ReturnType<typeof setTimeout>>()
  const failures = coalesceRepeats<string>({
    windowMs: 60_000,
    first: (operation, error) => log.warn("projection fold cache failed", { operation, error }),
    repeated: (operation, repeats) => log.warn("projection fold cache failures repeated", { operation, count: repeats.count, windowMs: repeats.windowMs }),
  })
  const decisions = coalesceRepeats<FoldDecision>({
    windowMs: 60_000,
    first: (_condition, { decision, role, key, reason }) => log.info(`projection fold ${decision}`, { key, role, reason }),
    repeated: (condition, repeats) => log.info("projection fold decisions repeated", { condition, count: repeats.count, windowMs: repeats.windowMs }),
  })
  // A reason of its own is a decision of its own, so a save that gives up
  // never hides behind a save that a rewrite overtook.
  const decide = (entry: FoldDecision): void => decisions.observe(`${entry.decision}:${entry.reason}:${entry.role}:${entry.key}`, entry)

  function database(): Database | undefined {
    if (db || unavailable) return db
    try {
      // Private before the first open, as every database of the workspace is.
      admitPrivateDatabaseFiles(path)
      ensurePrivateFile(path)
      const opened = new Database(path)
      try {
        applySqliteDurabilityPragmas(opened, BUSY_TIMEOUT_MS)
        const prepare = opened.transaction(() => {
          if (opened.query<{ user_version: number }, []>("pragma user_version").get()?.user_version !== FOLD_CACHE_FORMAT) {
            opened.exec(`drop table if exists fold; drop table if exists uncacheable; pragma user_version = ${FOLD_CACHE_FORMAT}`)
          }
          opened.exec(`create table if not exists fold (
            role text not null, key text not null, code text not null,
            position integer not null, read_position integer not null,
            anchor_position integer, anchor_id text, generation integer not null,
            written_at integer not null, state blob not null,
            primary key (role, key)
          ) without rowid`)
          opened.exec(`create table if not exists uncacheable (
            role text not null, key text not null, code text not null,
            primary key (role, key)
          ) without rowid`)
        })
        try {
          prepare()
        } catch (error) {
          if (!isSqliteBusyError(error)) throw error
          // Two processes that open a file of an old format at once both
          // reset it. The loser reads the old version and then fails at once
          // to upgrade its read to a write, which no busy timeout covers, and
          // an immediate second deferred attempt fails the same way. A
          // write transaction from its start waits for the winner's commit,
          // after which the format is current and nothing is reset.
          applySqliteBusyTimeout(opened, FORMAT_RESET_WAIT_MS)
          prepare.immediate()
          applySqliteBusyTimeout(opened, BUSY_TIMEOUT_MS)
        }
      } catch (error) {
        opened.close()
        throw error
      }
      db = opened
    } catch (error) {
      unavailable = true
      log.warn("projection fold cache unavailable", { path, error: errorMessage(error) })
    }
    return db
  }

  // A failed cache operation is a miss: the file is disposable, and the
  // projection it would have sped up folds from the store instead.
  function attempt<T>(operation: string, run: (db: Database) => T): T | undefined {
    const open = database()
    if (!open) return undefined
    try {
      return run(open)
    } catch (error) {
      failures.observe(operation, errorMessage(error))
      return undefined
    }
  }

  function slot(role: string, key: string): FoldCacheSlot {
    let requested: ReturnType<typeof setTimeout> | undefined
    let requestedSave: (() => void) | undefined
    let unsavedFacts = 0
    let unsavedFoldMs = 0
    const discard = (readPosition: number): void => {
      attempt("discard", (open) => open.query("delete from fold where role = ? and key = ? and read_position = ?").run(role, key, readPosition))
    }
    const accepts = (): boolean => attempt("accepts", (open) =>
      open.query("select 1 from uncacheable where role = ? and key = ? and code = ?").get(role, key, codeIdentity) === null) ?? false
    const refuse = (reason: string): false => {
      decide({ decision: "not cached", role, key, reason })
      attempt("refuse", (open) => open.query("insert into uncacheable (role, key, code) values (?, ?, ?) on conflict (role, key) do update set code = excluded.code")
        .run(role, key, codeIdentity))
      return false
    }
    const request = (save: () => void): void => {
      if (unavailable) return
      requestedSave = save
      if (requested) {
        clearTimeout(requested)
        requestedSaves.delete(requested)
      }
      const timer = setTimeout(() => {
        requestedSaves.delete(timer)
        requested = undefined
        save()
      }, quietMs)
      timer.unref?.()
      requested = timer
      requestedSaves.add(timer)
    }
    return {
      load() {
        const start = performance.now()
        const row = attempt("load", (open) => open.query<{
          position: number; read_position: number; anchor_position: number | null; anchor_id: string | null; generation: number; state: Uint8Array
        }, [string, string, string]>("select position, read_position, anchor_position, anchor_id, generation, state from fold where role = ? and key = ? and code = ?").get(role, key, codeIdentity))
        if (!row) return undefined
        log.debug("projection fold loaded", { key, role, bytes: row.state.byteLength, durationMs: durationMs(start) })
        return {
          position: row.position,
          readPosition: row.read_position,
          anchor: row.anchor_position === null || row.anchor_id === null ? null : { position: row.anchor_position, id: row.anchor_id },
          generation: row.generation,
          bytes: row.state,
        }
      },
      adopt<S extends object>(fold: CachedFold, evidence: FoldEvidence): S | undefined {
        const stale = staleReason(fold, evidence)
        if (stale) {
          decide({ decision: "stale", role, key, reason: stale })
          discard(fold.readPosition)
          return undefined
        }
        const start = performance.now()
        try {
          const state = decodeFoldState(fold.bytes)
          log.debug("projection fold restored", { key, role, bytes: fold.bytes.byteLength, decodeMs: durationMs(start), readPosition: fold.readPosition })
          // SAFETY: the role and key name one projection, whose own state
          // this entry encoded, and the code identity names its code.
          // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: decoded bytes of a state this slot's projection saved
          return state as S
        } catch (error) {
          decide({ decision: "stale", role, key, reason: `undecodable: ${errorMessage(error)}` })
          discard(fold.readPosition)
          return undefined
        }
      },
      folded(facts, foldMs, save) {
        if (unavailable) return
        unsavedFacts += facts
        unsavedFoldMs += foldMs
        if (unsavedFacts < afterFacts && unsavedFoldMs < SAVE_AFTER_FOLD_MS) return
        request(save)
      },
      accepts,
      async save(fold) {
        if (!accepts()) return false
        if (fold.evidence.generation !== fold.generation) {
          unsavedFacts = 0
          unsavedFoldMs = 0
          decide({ decision: "not saved", role, key, reason: "rewritten" })
          return false
        }
        const start = performance.now()
        let encoded: EncodedFold | undefined
        try {
          encoded = await encodeFoldState(fold, () => unavailable || fold.contended())
        } catch (error) {
          unsavedFacts = 0
          unsavedFoldMs = 0
          if (error instanceof UncacheableState) return refuse(error.message)
          failures.observe("encode", errorMessage(error))
          return false
        }
        // The folds since the last save still count, so a fold that moves
        // the state further asks again too.
        if (!encoded) {
          decide({ decision: "not saved", role, key, reason: unavailable ? "closed" : "contended" })
          if (requestedSave) request(requestedSave)
          return false
        }
        unsavedFacts = 0
        unsavedFoldMs = 0
        const encodeMs = durationMs(start)
        const writeStart = performance.now()
        const anchor = fold.evidence.anchor
        const { bytes, slices } = encoded
        const written = attempt("save", (open) => open.transaction(() => {
          const { changes } = open.query(`insert into fold (role, key, code, position, read_position, anchor_position, anchor_id, generation, written_at, state)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (role, key) do update set code = excluded.code, position = excluded.position, read_position = excluded.read_position,
              anchor_position = excluded.anchor_position, anchor_id = excluded.anchor_id, generation = excluded.generation,
              written_at = excluded.written_at, state = excluded.state
            where fold.code <> excluded.code or fold.read_position < excluded.read_position`)
            .run(role, key, codeIdentity, fold.position, fold.readPosition, anchor?.position ?? null, anchor?.id ?? null,
              fold.generation, Date.now(), bytes)
          if (changes > 0) evictPastCap(open)
          return changes > 0
        })()) === true
        log.debug("projection fold written", { key, role, written, bytes: bytes.byteLength, slices, encodeMs, writeMs: durationMs(writeStart), readPosition: fold.readPosition })
        return written
      },
    }
  }

  return {
    slot,
    close() {
      unavailable = true
      for (const timer of requestedSaves) clearTimeout(timer)
      requestedSaves.clear()
      failures.end()
      decisions.end()
      db?.close()
      db = undefined
    },
  }
}

function staleReason(fold: CachedFold, evidence: FoldEvidence): string | undefined {
  if (evidence.head < fold.readPosition) return "store-behind"
  if (evidence.generation !== fold.generation) return "rewritten"
  if (evidence.anchor?.position !== fold.anchor?.position || evidence.anchor?.id !== fold.anchor?.id) return "anchor"
  return undefined
}

function evictPastCap(db: Database): void {
  let total = 0
  for (const row of db.query<{ role: string; key: string; bytes: number }, []>("select role, key, length(state) as bytes from fold order by written_at desc").all()) {
    total += row.bytes
    if (total > MAX_CACHE_BYTES) db.query("delete from fold where role = ? and key = ?").run(row.role, row.key)
  }
}

// The encoding. Structured clone restores plain objects, arrays, Map, Set,
// Date, and byte arrays exactly, but one clone of a large state pauses the
// folding thread for its whole length. So the encoding walks the state
// depth first and cuts it into slices of about SLICE_VALUES values, each
// cloned on its own and compressed off the thread while the event loop runs.
//
// A slice is the structured clone of `[values, ops]`, where `ops` holds pairs
// of a code and a count for a stack machine: PUSH puts the next `count`
// entries of `values` on the stack, and a build code replaces the top
// `count` entries (or `count` key and value pairs, key first) with one new
// container. A container whose whole subtree falls in one slice travels
// inline as one value; a container that spans slices, or that holds an
// Effect HashMap or HashSet, which a clone would flatten, is rebuilt by its
// build code, so decoding touches only those containers. The entry is the
// concatenation of the slices, each prefixed by its byte length as a
// little-endian u32 and compressed as its own zstd frame, which one
// decompression reads back as the concatenated slices.
//
// The accepted shapes are the ones that restore the same way whether they
// travel inline or rebuilt: a plain object whose own keys are all strings
// and enumerable data properties; an array whose own keys are exactly its
// indices and `length`, whose elements the walk reads as values; a Map, Set,
// or Date with no own keys; and a Uint8Array, which the walk reads as its
// bytes only, because the one check for its own keys lists every index
// (about 2 s for 9 MB) and no producer gives a byte array a property.
// Any other shape, class instance, function, or symbol refuses the state
// rather than restoring a different value. A clone keeps a reference, or a
// byte array's buffer, shared within one slice, but not across two, so a
// state that shares one across slices, or with a rebuilt container, is
// refused as well.
const PUSH = 0
const ARRAY = 1
const RECORD = 2
const MAP = 3
const SET = 4
const HASH_MAP = 5
const HASH_SET = 6
const KEYED: ReadonlySet<number> = new Set([RECORD, MAP, HASH_MAP])
/** Marks an object in `seen` that its build code rebuilds. */
const REBUILT = -1

/** A state that the encoding cannot restore exactly, or that it cannot store. */
class UncacheableState extends Error {}

/** How the walk reads the entries of one container. */
type Entries =
  | { readonly kind: typeof ARRAY; readonly items: readonly unknown[] }
  | { readonly kind: typeof RECORD; readonly keys: readonly string[] }
  | { readonly kind: typeof MAP | typeof HASH_MAP; readonly pairs: Iterator<readonly [unknown, unknown]> }
  | { readonly kind: typeof SET | typeof HASH_SET; readonly members: Iterator<unknown> }

interface Container {
  readonly value: object
  readonly entries: Entries
  /** The value of the keyed entry whose key the walk visited last. */
  held: unknown
  /** The next step: a keyed container yields a key, then its value. */
  step: number
  count: number
  /** The length of the pending values when the walk entered it. */
  readonly mark: number
  /** Rebuilt by its build code: it spans slices or holds such a container. */
  rebuilt: boolean
}

interface SliceEncoder {
  /** The next slice as length-prefixed clone bytes, or undefined after the
   *  last one. The state must not change between two calls. */
  next(): Uint8Array | undefined
  finished(): boolean
}

function sliceEncoder(fold: FoldToSave): SliceEncoder {
  const stack: Container[] = []
  const seen = new Map<object, number>()
  const revisited = new Set<object>()
  let pending: unknown[] = []
  let values: unknown[] = []
  let ops: number[] = []
  let slice = 0
  let walked = 0
  let started = false

  const path = (): string => ["state", ...stack.map(({ entries, step, count }) => entries.kind === RECORD ? entries.keys[(step - 1) >> 1] : `<${count - 1}>`)].join(".")
  const refusal = (reason: string): UncacheableState => new UncacheableState(`${reason} at ${path()}`)

  // A container's ancestors span what it spans, so they are rebuilt too.
  const rebuildOpen = (): void => {
    for (const container of stack.toReversed()) {
      if (container.rebuilt) return
      if (revisited.has(container.value)) throw refusal("reference shared with a rebuilt container")
      container.rebuilt = true
      seen.set(container.value, REBUILT)
    }
  }
  const flush = (): void => {
    if (pending.length === 0) return
    ops.push(PUSH, pending.length)
    for (const value of pending) values.push(value)
    pending = []
  }
  const close = (): Uint8Array => {
    const clone = new Uint8Array(serialize([values, ops]))
    values = []
    ops = []
    slice += 1
    const framed = new Uint8Array(4 + clone.byteLength)
    new DataView(framed.buffer).setUint32(0, clone.byteLength, true)
    framed.set(clone, 4)
    return framed
  }

  // A value counts toward the slice by what it costs: a long string or byte
  // array by its size, which the clone copies, and an array also by the
  // keys that its admission lists, about a fifth of a value each.
  const visit = (value: unknown): void => {
    walked += 1
    if (value === null || typeof value !== "object") {
      if (typeof value === "function" || typeof value === "symbol") throw refusal(typeof value)
      if (typeof value === "string") walked += value.length >> 10
      pending.push(value)
      return
    }
    const at = seen.get(value)
    if (at !== undefined) {
      if (at !== slice) throw refusal("reference shared across slices")
      revisited.add(value)
      pending.push(value)
      return
    }
    // A subclass of a built-in collection would come back as the built-in.
    const prototype: unknown = Object.getPrototypeOf(value)
    let entries: Entries
    if (prototype === Object.prototype) {
      const keys: string[] = []
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key === "symbol") throw refusal("symbol key")
        keys.push(key)
      }
      entries = { kind: RECORD, keys }
    } else if (prototype === Array.prototype && Array.isArray(value)) {
      // An extra, hidden, or symbol key, or a hole, changes the count. A
      // hole that an extra key hides is refused when the walk reaches it.
      if (Reflect.ownKeys(value).length !== value.length + 1) throw refusal("array with own keys other than its indices")
      walked += value.length >> 3
      entries = { kind: ARRAY, items: value }
    } else if (prototype === Uint8Array.prototype && value instanceof Uint8Array) {
      // Two views of one buffer restore sharing it only from one slice.
      const owner = seen.get(value.buffer)
      if (owner !== undefined && owner !== slice) throw refusal("buffer shared across slices")
      walked += value.byteLength >> 10
      seen.set(value.buffer, slice)
      seen.set(value, slice)
      pending.push(value)
      return
    } else if (prototype === Date.prototype && value instanceof Date) {
      if (Reflect.ownKeys(value).length !== 0) throw refusal("date with an own property")
      seen.set(value, slice)
      pending.push(value)
      return
    } else if (prototype === Map.prototype && value instanceof Map) {
      if (Reflect.ownKeys(value).length !== 0) throw refusal("map with an own property")
      entries = { kind: MAP, pairs: value.entries() }
    } else if (prototype === Set.prototype && value instanceof Set) {
      if (Reflect.ownKeys(value).length !== 0) throw refusal("set with an own property")
      entries = { kind: SET, members: value.values() }
    } else if (HashMap.isHashMap(value)) entries = { kind: HASH_MAP, pairs: value[Symbol.iterator]() }
    else if (HashSet.isHashSet(value)) entries = { kind: HASH_SET, members: value[Symbol.iterator]() }
    // A null prototype would come back as Object.prototype.
    else throw refusal(prototype === null ? "null-prototype object" : `${value.constructor.name} instance`)
    seen.set(value, slice)
    stack.push({ value, entries, held: undefined, step: 0, count: 0, mark: pending.length, rebuilt: false })
    if (entries.kind === HASH_MAP || entries.kind === HASH_SET) rebuildOpen()
  }
  /** Visits the container's next key or value, or returns false once none remains. */
  const advance = (container: Container): boolean => {
    const { entries } = container
    const step = container.step
    container.step += 1
    if (step % 2 === 1 && KEYED.has(entries.kind)) {
      visit(container.held)
      return true
    }
    switch (entries.kind) {
      case ARRAY: {
        if (step >= entries.items.length) return false
        // A hole would come back as undefined.
        if (!Object.hasOwn(entries.items, step)) throw refusal("sparse array")
        container.count += 1
        visit(entries.items[step])
        return true
      }
      case RECORD: {
        const key = entries.keys[step >> 1]
        if (key === undefined) return false
        // A clone keeps only enumerable data properties.
        const descriptor = Object.getOwnPropertyDescriptor(container.value, key)
        if (!descriptor?.enumerable) throw refusal(`non-enumerable property ${key}`)
        if (!("value" in descriptor)) throw refusal(`accessor property ${key}`)
        container.held = descriptor.value
        container.count += 1
        visit(key)
        return true
      }
      case MAP:
      case HASH_MAP: {
        const entry = entries.pairs.next()
        if (entry.done) return false
        container.held = entry.value[1]
        container.count += 1
        visit(entry.value[0])
        return true
      }
      default: {
        const member = entries.members.next()
        if (member.done) return false
        container.count += 1
        visit(member.value)
        return true
      }
    }
  }
  const complete = (container: Container): void => {
    stack.pop()
    if (!container.rebuilt) {
      // Nothing was flushed since the container was entered, so its
      // pending children become the one inline value.
      pending.length = container.mark
      pending.push(container.value)
      return
    }
    flush()
    ops.push(container.entries.kind, container.count)
  }

  const finished = (): boolean => started && stack.length === 0
  const next = (): Uint8Array | undefined => {
    if (finished()) return undefined
    walked = 0
    if (!started) {
      started = true
      visit(fold.state)
    }
    for (let top = stack.at(-1); top; top = stack.at(-1)) {
      if (walked >= SLICE_VALUES) {
        rebuildOpen()
        flush()
        return close()
      }
      if (!advance(top)) complete(top)
    }
    flush()
    return close()
  }
  return { next, finished }
}

interface EncodedFold {
  readonly bytes: Uint8Array
  readonly slices: number
}

/** Encodes the fold's state slice by slice. Each slice compresses on another
 *  thread, and the encoding then waits for one turn of the event loop before
 *  the next slice, and resolves to undefined when `stop` is true before a
 *  slice. Throws `UncacheableState` for a state it cannot restore, and once
 *  the compressed bytes pass MAX_FOLD_BYTES. */
async function encodeFoldState(fold: FoldToSave, stop: () => boolean): Promise<EncodedFold | undefined> {
  const encoder = sliceEncoder(fold)
  const compressed: Uint8Array[] = []
  let bytes = 0
  for (let slice = encoder.next(); slice; slice = encoder.next()) {
    const frame = await Bun.zstdCompress(slice, { level: 1 })
    bytes += frame.byteLength
    if (bytes > MAX_FOLD_BYTES) throw new UncacheableState(`compressed to more than ${MAX_FOLD_BYTES} bytes`)
    compressed.push(frame)
    // The compression's completion alone is no turn of the event loop: on a
    // busy host Bun can run it and the next slice before any timer or
    // immediate, so the whole save would hold the thread.
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    if (!encoder.finished() && stop()) return undefined
  }
  return { bytes: Buffer.concat(compressed), slices: compressed.length }
}

function pairsOf(items: readonly unknown[]): [unknown, unknown][] {
  const pairs: [unknown, unknown][] = []
  for (let index = 0; index < items.length; index += 2) pairs.push([items[index], items[index + 1]])
  return pairs
}

/** Replaces the top entries of `stack` with the container that `code` builds of them. */
function pushRebuilt(stack: unknown[], code: number, count: number): void {
  const items = stack.splice(stack.length - (KEYED.has(code) ? 2 * count : count))
  switch (code) {
    case ARRAY: stack.push(items); return
    case RECORD: {
      const record: { [key: string]: unknown } = {}
      for (let index = 0; index < items.length; index += 2) {
        const key = items[index]
        if (typeof key !== "string") throw new Error("a record key is not a string")
        // A data property even for the key `__proto__`, which JSON.parse
        // makes an own key and which an assignment would make the prototype.
        if (key === "__proto__") Object.defineProperty(record, key, { value: items[index + 1], writable: true, enumerable: true, configurable: true })
        else record[key] = items[index + 1]
      }
      stack.push(record)
      return
    }
    case MAP: stack.push(new Map(pairsOf(items))); return
    case SET: stack.push(new Set(items)); return
    case HASH_MAP: stack.push(HashMap.fromIterable(pairsOf(items))); return
    case HASH_SET: stack.push(HashSet.fromIterable(items)); return
    default: throw new Error(`unknown build code ${code}`)
  }
}

/** The state that `encodeFoldState` encoded, with every reference that it
 *  shared within a slice shared. */
function decodeFoldState(bytes: Uint8Array): object {
  const stream = Bun.zstdDecompressSync(bytes)
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength)
  const stack: unknown[] = []
  for (let at = 0; at < stream.byteLength;) {
    const length = view.getUint32(at, true)
    const slice: unknown = deserialize(stream.subarray(at + 4, at + 4 + length))
    at += 4 + length
    if (!Array.isArray(slice) || !Array.isArray(slice[0]) || !Array.isArray(slice[1])) throw new Error("a slice is not values and operations")
    const values: unknown[] = slice[0]
    const ops: unknown[] = slice[1]
    let taken = 0
    for (let index = 0; index < ops.length; index += 2) {
      const code = ops[index]
      const count = ops[index + 1]
      if (typeof code !== "number" || typeof count !== "number") throw new Error("an operation is not a code and a count")
      if (code === PUSH) {
        if (taken + count > values.length) throw new Error("a slice pushes more values than it holds")
        for (let pushed = 0; pushed < count; pushed += 1) stack.push(values[taken + pushed])
        taken += count
      } else {
        if ((KEYED.has(code) ? 2 * count : count) > stack.length) throw new Error("a container takes more entries than the stack holds")
        pushRebuilt(stack, code, count)
      }
    }
  }
  const state = stack[0]
  if (stack.length !== 1 || typeof state !== "object" || state === null) throw new Error("fold state is not one object")
  return state
}
