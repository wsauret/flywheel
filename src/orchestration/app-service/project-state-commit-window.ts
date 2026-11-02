import { pageReadQuery, type FactQuery, type StoredFact } from "../../infra/event-store-types.js"
import { factRetention } from "../../infra/fact-retention-registry.js"
import { Log } from "../../infra/log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import type { ToolContentRow } from "../../infra/tool-content.js"
import { boundedProjectStateSlice, isDegradedStoredFact, PROJECT_STATE_MAX_BYTES, PROJECT_STATE_MAX_PAGE_ROWS } from "./project-state-protocol.js"

/** The heap the held facts retain (user decision). */
const RETAINED_BYTES = 8 * 1024 * 1024
/** A fact larger than this is indexed but not held, so one large fact cannot
 *  push the rest of the window out. A read that matches it goes remote. */
const MAX_HELD_FACT_BYTES = 512 * 1024
/** The heap of one entry beside its JSON characters: the entry object, its
 *  aggregate, type, session, and family strings, its held record, the five
 *  index slots that hold it with their array growth slack, and the string
 *  header of its JSON. Measured in Bun at about 345 bytes per fact, with
 *  distinct strings for every fact, over 10,000 facts of 160 sessions and
 *  20 types; the constant adds a margin. */
const FACT_OVERHEAD_BYTES = 384
/** The heap of one held content row beside its content characters: its
 *  SHA-256 key and the JSON syntax around it. */
const CONTENT_ROW_OVERHEAD_BYTES = 96
/** Keys of the recency index. Each committed aggregate, type, family, and
 *  session above the floor is one key; past this the window re-anchors. */
const MAX_RECENCY_KEYS = 65_536
const REANCHOR_REPORT_MS = 60_000

/** The query fields a local read can answer. Any other field goes remote. */
const LOCAL_QUERY_FIELDS = new Set(["aggregateId", "aggregateIds", "aggregatePrefix", "sessionId", "types", "afterPosition", "beforePosition", "order", "limit"])

interface Entry {
  readonly position: number
  readonly aggregateId: string
  readonly type: string
  readonly sessionId: string
  readonly family: string | undefined
  bytes: number
  /** The stored fact's JSON. Absent for a fact the window indexes but does
   *  not hold. */
  held: string | undefined
  /** The JSON of the tool content rows this executor appended with the
   *  fact, keyed by SHA-256. Absent for a fact another appender wrote. */
  content: string | undefined
}

/** One index key's entries in position order. Eviction removes the oldest
 *  entry of the window, which is the first entry of each list that holds it. */
interface EntryList {
  entries: Entry[]
  head: number
}

/** Fills the slot of an evicted entry, so an index list holds no entry the
 *  window dropped while it waits for compaction. */
const VACATED: Entry = { position: 0, aggregateId: "", type: "", sessionId: "", family: undefined, bytes: 0, held: undefined, content: undefined }
/** An index list compacts once this many of its slots are vacated and they
 *  are at least half of the list, in amortized constant time per eviction. */
const COMPACTION_FLOOR = 32

type ReanchorReason = "gap" | "unannounced" | "recency-bound"

/** Committed facts the executor heard in the `state.stored` broadcast, so a
 *  read of recent history can be answered without a state request.
 *
 *  The window is exact above its floor F: every fact committed at a position
 *  in (F, C] arrived, where C is the position it is complete through. The
 *  state Worker sends every commit notification before the response of any
 *  request that runs after the commit, stamps each response with the head it
 *  read after those notifications, and the account relays notifications and
 *  responses in order. A head H that the window has reached (C >= H)
 *  therefore proves that no committed fact at or below H is missing. A fact
 *  above C + 1 is a gap and a head above C is a commit that was never
 *  broadcast, such as a write by another process on the same store: both
 *  re-anchor the window at that position and clear it. The client serves a
 *  reader's barrier with the head of a response to a request sent after the
 *  reader's call, so a read through that head is never older than a read of
 *  the store at the call (ARCH-SUBSTRATE-019).
 *
 *  The window holds the newest facts within its byte budget. Older facts
 *  above the floor are dropped from the held suffix but stay in the recency
 *  index, which proves that a key did not move after a position. A degraded
 *  substitute and a fact over the size cap are indexed but not held, so a
 *  read whose range meets one goes to the state Worker.
 *
 *  A broadcast carries no tool content. The window also holds the content
 *  rows of the facts this executor appended, so a read of its own recent
 *  appends hydrates them without a content request. Content of any other
 *  fact hydrates from the store.
 *
 *  The store deletes superseded facts of replace-latest families
 *  (`factRetention`) out of band, and a prune sends no notification. Facts
 *  of those families are therefore indexed but never held either: a read
 *  that meets one goes to the store, and a read that only proves one moved
 *  stays exact, because a prune never deletes the newest fact of a key. */
export interface ProjectStateCommitWindow {
  /** A `state.stored` broadcast, in arrival order. */
  receive(events: readonly StoredFact[]): void
  /** The tool content rows this executor appended with the fact at
   *  `position`. The append acknowledgement follows the fact's broadcast, so
   *  the fact is in the window when its appender calls this, unless the
   *  window does not hold it. The rows count against the same byte budget. */
  holdContent(position: number, rows: readonly ToolContentRow[]): void
  /** The content rows held with the fact at `position`, keyed by SHA-256. */
  contentOf(position: number): { readonly [sha256: string]: string } | undefined
  /** A committed position the state Worker read, such as a response head:
   *  anchors the window, or re-anchors it when commits at or below it never
   *  arrived. */
  observe(position: number): void
  /** The broadcast stream was interrupted. Until the next observation, every
   *  read goes remote. */
  unanchor(): void
  /** True when the window answers a page of `query` after `afterPosition`
   *  through what it heard now, so a read that pays for a capture first
   *  almost always reads no page from the store. */
  mayAnswerPage(query: FactQuery, afterPosition: number): boolean
  /** One page as the state Worker would answer it, or undefined when the
   *  window cannot prove it complete. */
  page(query: FactQuery, upperPosition: number, afterPosition: number): { facts: StoredFact[]; continuationPosition: number | null } | undefined
  /** True when the window answers a bounded slice of `query` through what
   *  it heard now. */
  maySlice(query: FactQuery): boolean
  /** The bounded slice of `query` through `upperPosition`, as SQL would order
   *  and limit it, or undefined when the window cannot prove it complete. */
  slice(query: FactQuery, upperPosition: number): StoredFact[] | undefined
  /** The store's sequence of `aggregateId` through what the window heard,
   *  or undefined when no fact of it arrived above the floor. The store
   *  answers a sequence from its per-aggregate counter, which no fact
   *  deletion lowers, so the newest fact heard carries the store's sequence. */
  sequence(aggregateId: string): number | undefined
  /** Ends the window: it answers nothing more and no later capture anchors
   *  it again. Idempotent. */
  close(): void
}

export function createProjectStateCommitWindow(): ProjectStateCommitWindow {
  const log = Log.create({ service: "project-state-commit-window" })
  const reanchors = coalesceRepeats<{ readonly floor: number }>({
    windowMs: REANCHOR_REPORT_MS,
    first: (reason, { floor }) => log.info("commit window re-anchored", { reason, floor }),
    repeated: (reason, repeats) => log.info("commit window re-anchored repeatedly", { reason, count: repeats.count, windowMs: repeats.windowMs }),
  })
  let anchored = false
  let closed = false
  let floor = 0
  let complete = 0
  let retainedFloor = 0
  let retainedBytes = 0
  let all: EntryList = { entries: [], head: 0 }
  const lists = { aggregate: new Map<string, EntryList>(), type: new Map<string, EntryList>(), family: new Map<string, EntryList>(), session: new Map<string, EntryList>() }
  const newest = { aggregate: new Map<string, number>(), type: new Map<string, number>(), family: new Map<string, number>(), session: new Map<string, number>() }
  /** The newest sequence of each aggregate in `newest.aggregate`. */
  const sequences = new Map<string, number>()

  function anchorAt(position: number): void {
    anchored = true
    floor = position
    complete = position
    retainedFloor = position
    retainedBytes = 0
    all = { entries: [], head: 0 }
    for (const map of Object.values(lists)) map.clear()
    for (const map of Object.values(newest)) map.clear()
    sequences.clear()
  }

  function reanchor(position: number, reason: ReanchorReason): void {
    anchorAt(position)
    reanchors.observe(reason, { floor: position })
  }

  function add(fact: StoredFact): void {
    const family = familyOf(fact.aggregateId)
    let held: Entry["held"]
    let bytes = FACT_OVERHEAD_BYTES
    if (!isDegradedStoredFact(fact) && !prunable(fact.type)) {
      // The store holds the payload's JSON form, which can differ from the
      // appender's object: a key set to `undefined` survives the broadcast
      // but not the store. A local read answers with the stored form.
      const json = JSON.stringify({ ...storedFields(fact), payload: fact.payload })
      const jsonBytes = heapBytes(json)
      if (jsonBytes + FACT_OVERHEAD_BYTES <= MAX_HELD_FACT_BYTES) {
        held = json
        bytes += jsonBytes
      }
    }
    const entry: Entry = { position: fact.position, aggregateId: fact.aggregateId, type: fact.type, sessionId: fact.sessionId, family, bytes, held, content: undefined }
    all.entries.push(entry)
    append(lists.aggregate, entry.aggregateId, entry)
    append(lists.type, entry.type, entry)
    append(lists.session, entry.sessionId, entry)
    if (family !== undefined) append(lists.family, family, entry)
    newest.aggregate.set(entry.aggregateId, entry.position)
    sequences.set(entry.aggregateId, fact.seq)
    newest.type.set(entry.type, entry.position)
    newest.session.set(entry.sessionId, entry.position)
    if (family !== undefined) newest.family.set(family, entry.position)
    retainedBytes += bytes
    while (retainedBytes > RETAINED_BYTES) evictOldest()
  }

  function evictOldest(): void {
    // SAFETY: retainedBytes is positive only while an entry remains.
    const entry = all.entries[all.head]!
    advance(all)
    entry.held = undefined
    entry.content = undefined
    retainedBytes -= entry.bytes
    retainedFloor = entry.position
    shift(lists.aggregate, entry.aggregateId)
    shift(lists.type, entry.type)
    shift(lists.session, entry.sessionId)
    if (entry.family !== undefined) shift(lists.family, entry.family)
  }

  /** The held entry of the fact at `position`, if the window holds it. */
  function heldAt(position: number): Entry | undefined {
    if (!anchored) return undefined
    const entry = all.entries[firstAbove(all, position - 1)]
    return entry?.position === position && entry.held !== undefined ? entry : undefined
  }

  function recencyKeys(): number {
    return newest.aggregate.size + newest.type.size + newest.family.size + newest.session.size
  }

  /** True when no fact matching `query` was committed in (after, C]. Valid
   *  only for `after >= floor`. */
  function provesNoneAfter(query: FactQuery, after: number): boolean {
    const unmoved = (map: Map<string, number>, key: string) => (map.get(key) ?? 0) <= after
    if (complete <= after) return true
    if (query.aggregateId !== undefined && unmoved(newest.aggregate, query.aggregateId)) return true
    if (query.aggregateIds?.every((id) => unmoved(newest.aggregate, id))) return true
    if (query.types?.every((type) => unmoved(newest.type, type))) return true
    if (query.sessionId !== undefined && unmoved(newest.session, query.sessionId)) return true
    return query.aggregatePrefix !== undefined && unmoved(newest.family, query.aggregatePrefix)
  }

  /** The entry lists of the most selective field of `query` in (after, upper]. */
  function candidates(query: FactQuery, after: number, upper: number): EntryList[] {
    const keyed = (map: Map<string, EntryList>, keys: Iterable<string>) => [...new Set(keys)].flatMap((key) => map.get(key) ?? [])
    const options: EntryList[][] = []
    if (query.aggregateId !== undefined) options.push(keyed(lists.aggregate, [query.aggregateId]))
    if (query.aggregateIds !== undefined) options.push(keyed(lists.aggregate, query.aggregateIds))
    if (query.types !== undefined) options.push(keyed(lists.type, query.types))
    if (query.sessionId !== undefined) options.push(keyed(lists.session, [query.sessionId]))
    if (query.aggregatePrefix !== undefined) options.push(keyed(lists.family, [query.aggregatePrefix]))
    if (options.length === 0) return [all]
    let best: EntryList[] = []
    let bestCount = Number.POSITIVE_INFINITY
    for (const option of options) {
      const count = option.reduce((total, list) => total + countWithin(list, after, upper), 0)
      if (count < bestCount) {
        best = option
        bestCount = count
      }
    }
    return best
  }

  /** The matches of `query` in (after, upper], in `order`, up to `limit`, or
   *  undefined when one of them is indexed but not held. */
  function collect(query: FactQuery, after: number, upper: number, order: "asc" | "desc", limit: number): StoredFact[] | undefined {
    const facts: StoredFact[] = []
    if (limit <= 0) return facts
    const aggregateIds = query.aggregateIds && new Set(query.aggregateIds)
    const types = query.types && new Set(query.types)
    for (const entry of merged(candidates(query, after, upper), after, upper, order)) {
      if (query.aggregateId !== undefined && entry.aggregateId !== query.aggregateId) continue
      if (aggregateIds && !aggregateIds.has(entry.aggregateId)) continue
      if (types && !types.has(entry.type)) continue
      if (query.sessionId !== undefined && entry.sessionId !== query.sessionId) continue
      if (query.aggregatePrefix !== undefined && entry.family !== query.aggregatePrefix) continue
      if (entry.held === undefined) return undefined
      // Each read parses its own copy, so no decoded object graph outlives
      // the read and the heap the window retains is its JSON alone.
      const fact: StoredFact = JSON.parse(entry.held)
      facts.push(fact)
      if (facts.length === limit) break
    }
    return facts
  }

  return {
    receive(events) {
      if (!anchored) return
      for (const fact of events) {
        if (fact.position <= complete) continue
        if (fact.position > complete + 1) reanchor(fact.position - 1, "gap")
        complete = fact.position
        add(fact)
      }
      if (recencyKeys() > MAX_RECENCY_KEYS) reanchor(complete, "recency-bound")
    },
    holdContent(position, rows) {
      const entry = heldAt(position)
      // The request codec's UTF-8 encoding replaces an unpaired surrogate, so
      // only well-formed text is held exactly as the store keeps it.
      if (!entry || !rows.every((row) => row.content.isWellFormed())) return
      // A fresh JSON copy, so the window retains no string of the appender.
      const json = JSON.stringify(Object.fromEntries(rows.map((row) => [row.sha256, row.content])))
      const bytes = heapBytes(json) + rows.length * CONTENT_ROW_OVERHEAD_BYTES
      // Content that would pass the size cap hydrates from the store.
      if (entry.bytes + bytes > MAX_HELD_FACT_BYTES) return
      entry.content = json
      entry.bytes += bytes
      retainedBytes += bytes
      while (retainedBytes > RETAINED_BYTES) evictOldest()
    },
    contentOf(position) {
      const content = heldAt(position)?.content
      return content === undefined ? undefined : JSON.parse(content)
    },
    observe(position) {
      if (closed) return
      if (!anchored) anchorAt(position)
      else if (complete < position) reanchor(position, "unannounced")
    },
    unanchor() {
      anchored = false
    },
    mayAnswerPage(query, afterPosition) {
      return page(query, complete, afterPosition) !== undefined
    },
    page,
    maySlice(query) {
      return boundedProjectStateSlice(query, PROJECT_STATE_MAX_PAGE_ROWS, PROJECT_STATE_MAX_BYTES) && slice(query, complete) !== undefined
    },
    slice,
    sequence(aggregateId) {
      return anchored ? sequences.get(aggregateId) : undefined
    },
    close() {
      if (closed) return
      closed = true
      anchored = false
      reanchors.end()
    },
  }

  function page(query: FactQuery, upperPosition: number, afterPosition: number): { facts: StoredFact[]; continuationPosition: number | null } | undefined {
    if (!anchored || !locallyAnswerable(query) || upperPosition > complete) return undefined
    const bounds = pageReadQuery(query, upperPosition, afterPosition, PROJECT_STATE_MAX_PAGE_ROWS)
    // SAFETY: pageReadQuery always sets the composed upper bound.
    const upper = Math.min(upperPosition, bounds.query.beforePosition! - 1)
    if (upper <= bounds.after) return { facts: [], continuationPosition: null }
    if (bounds.after < floor) return undefined
    if (provesNoneAfter(bounds.query, bounds.after)) return { facts: [], continuationPosition: null }
    if (bounds.after < retainedFloor) return undefined
    // The lookahead fact shows whether a next page exists, as in the store's page.
    const facts = collect(bounds.query, bounds.after, upper, "asc", bounds.rows + 1)
    if (!facts) return undefined
    const answered = facts.slice(0, bounds.rows)
    // SAFETY: a lookahead fact past the page means the page holds bounds.rows >= 1 facts.
    return { facts: answered, continuationPosition: facts.length > answered.length ? answered.at(-1)!.position : null }
  }

  function slice(query: FactQuery, upperPosition: number): StoredFact[] | undefined {
    if (!anchored || !locallyAnswerable(query) || query.limit === undefined || upperPosition > complete) return undefined
    const after = query.afterPosition ?? 0
    const upper = Math.min(upperPosition, (query.beforePosition ?? Number.POSITIVE_INFINITY) - 1)
    if (query.limit === 0 || upper <= after) return []
    if (after >= floor && provesNoneAfter(query, after)) return []
    const order = query.order ?? "asc"
    if (order === "asc" && after < retainedFloor) return undefined
    const facts = collect(query, Math.max(after, retainedFloor), upper, order, query.limit)
    // A newest-first read below the held suffix is complete only when it
    // found its limit inside it.
    if (!facts || (after < retainedFloor && facts.length < query.limit)) return undefined
    return facts
  }
}

/** A fact of a family whose superseded facts the store prunes. */
function prunable(type: string): boolean {
  const policy = factRetention(type)?.policy
  return policy === "replace-latest" || policy === "replace-latest-keyed"
}

function locallyAnswerable(query: FactQuery): boolean {
  for (const [field, value] of Object.entries(query)) {
    if (value !== undefined && !LOCAL_QUERY_FIELDS.has(field)) return false
  }
  // The store refuses these shapes as producer bugs; the remote read keeps
  // that refusal. A prefix deeper than one family has no family index.
  if (query.aggregateId !== undefined && (query.aggregateIds !== undefined || query.aggregatePrefix !== undefined)) return false
  return query.aggregatePrefix === undefined || familyOf(query.aggregatePrefix) === query.aggregatePrefix
}

/** The aggregate family of an id, `workflow:` for `workflow:abc`, as a
 *  `FactQuery.aggregatePrefix` names it. */
function familyOf(aggregateId: string): string | undefined {
  const separator = aggregateId.indexOf(":")
  return separator === -1 ? undefined : aggregateId.slice(0, separator + 1)
}

/** The fields of a fact as the store returns them: optional references that
 *  are absent or empty are omitted, as the row mapping omits them. */
function storedFields(fact: StoredFact): Omit<StoredFact, "payload"> {
  return {
    position: fact.position, id: fact.id, aggregateId: fact.aggregateId, seq: fact.seq, type: fact.type,
    version: fact.version, timestamp: fact.timestamp, actor: fact.actor, sessionId: fact.sessionId,
    ...(fact.runId ? { runId: fact.runId } : {}),
    ...(fact.parentEventId ? { parentEventId: fact.parentEventId } : {}),
    ...(fact.causedByEventId ? { causedByEventId: fact.causedByEventId } : {}),
  }
}

/** The heap bytes of a string's characters. The engine stores a string with
 *  only Latin-1 characters in one byte per character and any other string
 *  in two. */
function heapBytes(text: string): number {
  return /[\u0100-\uffff]/.test(text) ? text.length * 2 : text.length
}

function append(map: Map<string, EntryList>, key: string, entry: Entry): void {
  const list = map.get(key)
  if (list) list.entries.push(entry)
  else map.set(key, { entries: [entry], head: 0 })
}

function advance(list: EntryList): void {
  list.entries[list.head] = VACATED
  list.head += 1
  if (list.head >= COMPACTION_FLOOR && list.head * 2 >= list.entries.length) {
    list.entries = list.entries.slice(list.head)
    list.head = 0
  }
}

function shift(map: Map<string, EntryList>, key: string): void {
  // SAFETY: every evicted entry was appended to its key's list.
  const list = map.get(key)!
  advance(list)
  if (list.head >= list.entries.length) map.delete(key)
}

/** The index of the first entry of `list` above `position`. */
function firstAbove(list: EntryList, position: number): number {
  let low = list.head
  let high = list.entries.length
  while (low < high) {
    const middle = (low + high) >>> 1
    // SAFETY: middle lies in [head, length).
    if (list.entries[middle]!.position <= position) low = middle + 1
    else high = middle
  }
  return low
}

function countWithin(list: EntryList, after: number, upper: number): number {
  return firstAbove(list, upper) - firstAbove(list, after)
}

/** The entries of `lists` in (after, upper], merged in position order. Each
 *  step costs the number of lists, so a read costs its matches, never the
 *  size of the window.
 *  @yields {Entry} Each entry in (after, upper], in `order`. */
function* merged(lists: readonly EntryList[], after: number, upper: number, order: "asc" | "desc"): Generator<Entry> {
  const cursors = lists.map((list) => ({ list, index: order === "asc" ? firstAbove(list, after) : firstAbove(list, upper) - 1, end: order === "asc" ? firstAbove(list, upper) : firstAbove(list, after) - 1 }))
  for (;;) {
    let next: { readonly cursor: (typeof cursors)[number]; readonly entry: Entry } | undefined
    for (const cursor of cursors) {
      if (cursor.index === cursor.end) continue
      // SAFETY: the index lies strictly between the cursor's bounds.
      const entry = cursor.list.entries[cursor.index]!
      if (!next || (order === "asc" ? entry.position < next.entry.position : entry.position > next.entry.position)) next = { cursor, entry }
    }
    if (!next) return
    yield next.entry
    next.cursor.index += order === "asc" ? 1 : -1
  }
}
