import { isAbortError } from "./abort.js"
import { yieldToNextTask } from "./task-scheduling.js"
import type { ContentResolver, ToolContentRow } from "./tool-content.js"
import type { SessionContentNodeRow, SessionContentRange, SessionContentReference } from "./session-content.js"
import { readSessionContentRange } from "./session-content.js"

export interface EventPayload { [key: string]: unknown }
type EventId = string

export interface EventStoreAppend {
  aggregateId: string
  type: string
  version: number
  timestamp: number
  actor: string
  sessionId: string
  payload: EventPayload
  runId?: string
  parentEventId?: string
  causedByEventId?: string
  /** Pre-serialized `payload`, exactly `JSON.stringify(payload)`. The writer
   *  lane serializes once at enqueue for true byte accounting and the store
   *  inserts this string verbatim instead of serializing again; other writers
   *  omit it and the store serializes at insert. A request attribute, never
   *  stored: StoredFact omits it. */
  payloadJson?: string
  /** Session-scoped `tool_content` rows this append's payload references
   *  (tool output dedup). The store inserts them idempotently inside the same
   *  commit unit, before this append's event rows, so a stored reference
   *  always has its bytes and a rolled-back append leaves none behind. A
   *  request attribute, never stored: StoredFact omits it. */
  contentRows?: readonly ToolContentRow[]
  /** Changes to in-flight recovery state, this session's unless a write names
   *  the session that holds its cell, applied inside the same commit unit as
   *  this append. Carried by the append that makes them
   *  true so the fact and the state it retires can never disagree: the fact
   *  that says an operation finished lands in the same transaction that drops
   *  what was held in case it did not. A request attribute, never stored:
   *  StoredFact omits it. */
  inFlight?: readonly InFlightWrite[]
}

/** Append shape for a compare-and-swap commit. At least one event in a guarded
 * batch carries `expectedSeq`; sibling events can remain unguarded when one
 * aggregate guard protects the whole atomic item. */
export interface GuardedEventStoreAppend extends EventStoreAppend {
  readonly expectedSeq?: number
  /** Read-only aggregate fences evaluated before this batch assigns any positions.
   * They protect an owner that the transaction reads without appending a shadow ownership fact. */
  readonly aggregateGuards?: readonly { readonly aggregateId: string; readonly expectedSeq: number }[]
}

/** One change to the in-flight companion table. Payloads are serialized once
 * by the writer lane when present, so every byte in the commit unit participates
 * in queue and batch limits. A guarded `swap` compares the exact stored text;
 * mismatch rejects the owning item without changing its facts or cell.
 *
 * A `drop` or `swap` that names `sessionId` retires a cell that another
 * session holds, in the same commit unit as the write that carries it: an
 * agent of a workflow writes its conversation in its own session, and the
 * commit that makes a message durable there retires the cell in which its
 * workflow held that message. Without it, the write applies to the session
 * of the write that carries it. */
export type InFlightWrite =
  | { readonly op: "put"; readonly kind: string; readonly key: string; readonly payload: unknown; readonly payloadJson?: string }
  | { readonly op: "drop"; readonly kind: string; readonly key: string; readonly sessionId?: string }
  | { readonly op: "clear"; readonly kind: string }
  | { readonly op: "clear_session" }
  | { readonly op: "swap"; readonly kind: string; readonly key: string; readonly expectedRaw: string | null; readonly payload: unknown | null; readonly payloadJson?: string | null; readonly sessionId?: string }

export type InFlightSwap = Extract<InFlightWrite, { readonly op: "swap" }>

/** One live in-flight value, in insertion order. `raw` is the exact stored
 *  payload text, the expectation token a `swapInFlight` caller passes back so
 *  its write lands only on the value it validated. */
export interface InFlightRecord {
  readonly kind: string
  readonly key: string
  readonly payload: { [key: string]: unknown }
  readonly raw: string
}

/** The exact-raw guard refused an in-flight transition because another writer
 * changed the cell first. The owning savepoint rolls back, including any
 * terminal facts carried by the same item. */
export class InFlightSwapConflictError extends Error {
  override readonly name = "InFlightSwapConflictError"

  constructor(readonly sessionId: string, readonly kind: string, readonly key: string) {
    super(`In-flight cell changed before guarded swap (${sessionId}/${kind}/${key})`)
  }
}

export type PersistenceWriteStage = "preparation" | "publication" | "final-result"

/** A local encoded request cannot cross the persistence boundary. It is not retryable. */
export class PersistenceWriteRefused extends Error {
  override readonly name = "PersistenceWriteRefused"
  requestId?: number
  constructor(readonly encodedBytes: number, readonly limitBytes: number, public stage?: PersistenceWriteStage) {
    super(`Flywheel could not save this operation: its encoded request is ${encodedBytes} bytes; the limit is ${limitBytes} bytes.`)
  }
}

/** One writer-lane item: the facts and in-flight transitions of one session
 * that commit together under one savepoint. */
export interface EventStoreWriteItem {
  readonly sessionId: string
  readonly events: readonly GuardedEventStoreAppend[]
  readonly inFlight?: readonly InFlightWrite[]
  readonly sessionContentNodes?: readonly SessionContentNodeRow[]
}

/** A guarded append lost its compare-and-swap race. This is a normal domain
 * outcome, not an exception or substrate failure. */
export interface AggregateSeqConflict {
  readonly aggregateId: string
  readonly expectedSeq: number
  readonly actualSeq: number
}

export interface CorruptEventRowEvidence {
  readonly aggregateId: string
  readonly seq: number
  readonly type: string
  readonly version: number
  readonly timestamp: number
  readonly actor: string
  readonly sessionId: string
  readonly eventId: string
  readonly position: number
  readonly rawPayload: string
}

/** A stored row whose payload no longer parses as a JSON object: substrate
 *  corruption scoped to one row. Strict reads throw it (the reader does not
 *  widen), while the tolerant read variants return it in sequence position so
 *  the session catalog and the repair contract can isolate the damage to the
 *  owning session instead of losing the whole workspace listing. */
export class CorruptEventRowError extends Error {
  override readonly name = "CorruptEventRowError"
  constructor(readonly row: CorruptEventRowEvidence, detail: string) {
    super(`corrupt event row ${row.eventId} (session ${row.sessionId}, position ${row.position}): ${detail}`)
  }

  get sessionId(): string {
    return this.row.sessionId
  }

  get eventId(): string {
    return this.row.eventId
  }

  get position(): number {
    return this.row.position
  }
}

/** A state request the store boundary did not serve: the boundary refused it,
 *  for example as past its response budget, or could not reach the store. It
 *  says nothing about stored history. A reader that answers "unreadable" for
 *  corrupt history checks for this type and lets it propagate, so no caller
 *  decides from facts it never read. Each serving boundary throws its own
 *  subclass of it. */
export class StateRequestNotServedError extends Error {
  override readonly name: string = "StateRequestNotServedError"
}

/** Whether a failed read of one session's history says something about that
 *  history, so that a reader which crosses sessions may answer with that
 *  session's typed gap and go on with the others. A request the boundary did
 *  not serve and an interrupted read say nothing about history, so they
 *  propagate. */
export function isSessionHistoryFailure(error: unknown): boolean {
  return !(error instanceof StateRequestNotServedError) && !isAbortError(error)
}

export interface StoredFact extends Omit<EventStoreAppend, "payloadJson" | "contentRows"> {
  position: number
  id: EventId
  seq: number
}

/** What the store assigns to an appended fact. Every other field of the
 *  stored fact is the append's own. */
export type StoreAssignment = Pick<StoredFact, "id" | "position" | "seq">

/** The fact the store holds for one append: the append without its request
 *  attributes, plus what the store assigned. */
export function storedFact(event: GuardedEventStoreAppend, assigned: StoreAssignment): StoredFact {
  const { expectedSeq: _guard, aggregateGuards: _readGuards, payloadJson: _serialized, contentRows: _content, inFlight: _inFlight, ...fields } = event
  return { ...fields, ...assigned }
}

export type GuardedAppendResult =
  | { readonly kind: "stored"; readonly events: readonly StoredFact[] }
  | { readonly kind: "conflict"; readonly conflict: AggregateSeqConflict }

/** Per-item outcome of one writer-lane flush transaction. Guard conflicts are
 * normal compare-and-swap outcomes. A rejected item has a real substrate or
 * invariant failure and rolls back alone without disturbing its peers. */
export type EventStoreItemSettlement =
  | { readonly kind: "stored"; readonly events: readonly StoredFact[] }
  | { readonly kind: "conflict"; readonly conflict: AggregateSeqConflict }
  | { readonly kind: "rejected"; readonly error: unknown }

/** One filter object describes every fact read; absent fields do not filter.
 *  The composed WHERE clause is the whole vocabulary, so a new read shape is a
 *  new field here, not a new method on the reader. */
export interface FactQuery {
  aggregateId?: string
  /** Aggregate-family scope, including the trailing colon, such as `workflow:`.
   *  Excludes `aggregateId`. */
  aggregatePrefix?: string
  /** Facts of any of these aggregates, in workspace position order: one
   *  read for many sessions where a caller would otherwise read each one.
   *  Excludes `aggregateId`. Without `types`, bound it by position, as a
   *  catch-up after its cursor does. An explicit empty list matches nothing. */
  aggregateIds?: readonly string[]
  /** Filter by owning session across all its aggregates. */
  sessionId?: string
  /** Exact workspace source positions. An explicit empty list matches nothing. */
  positions?: readonly number[]
  /** Filter to these fact types. An explicit empty list matches nothing. */
  types?: readonly string[]
  /** Only facts strictly after this workspace position. */
  afterPosition?: number
  /** Only facts strictly before this workspace position. With `order: "desc"`
   *  and a `limit`, it pages backward from the newest fact one bounded read
   *  at a time. */
  beforePosition?: number
  /** Indexed suffix read by aggregate sequence, inclusive. Requires `aggregateId`. */
  fromSeq?: number
  /** One bounded child-fact read for all visible container parents. Requires
   *  `aggregateId` and `types`. An explicit empty list matches nothing. */
  parentToolUseIds?: readonly string[]
  /** Filter payloads to these canonical tool-use ids. Requires `aggregateId` and `types`. */
  toolUseIds?: readonly string[]
  /** Direction of the existing aggregate-sequence or workspace-position order. Defaults to ascending. */
  order?: "asc" | "desc"
  /** Maximum row count, a nonnegative integer. Zero matches nothing; absence means no limit. */
  limit?: number
  /** Maximum row count of each aggregate of `aggregateIds`, the first rows
   *  of each in `order`: one read of the newest facts of many aggregates
   *  that costs this bound for each, whatever history each holds. Requires
   *  `aggregateIds` and `types`, because each aggregate seeks its types. It
   *  bounds one slice, so a paged read refuses it. */
  limitPerAggregate?: number
}

/** Read surface of a concrete SQLite store connection: the fact reader plus
 *  the session-scoped tool_content resolver. Projections and other consumers
 *  keep depending on the narrower EventReader; the resolver is reached where
 *  a caller holds the store connection itself. */
export interface EventStoreReadSurface extends EventReader {
  readonly toolContent: ContentResolver
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: shared content readers validate raw immutable storage against referenced hashes and lengths.
  readSessionContentNode?(sessionId: string, sha256: string): unknown | null
  /** What a persisted fold of `scope` must match to be current
   *  (ARCH-SUBSTRATE-046). Reads only the scope's aggregates and types. */
  foldEvidence(scope: FoldScope, anchorAt: number): FoldEvidence
}

/** A scope whose fold may be persisted: named aggregates, families, or both.
 *  A prefix scope has no cheap evidence, so no fold of one is persisted. */
export type FoldScope = Pick<FactQuery, "aggregateId" | "aggregateIds" | "types">

/** One fact that names the history a fold has read: a different id at its
 *  position means a different or rewound store. */
export interface FoldAnchor {
  readonly position: number
  readonly id: string
}

/** Where the store stands for one projection scope. A persisted fold is
 *  current only when all three still match what it recorded. */
export interface FoldEvidence {
  /** The store's newest position. */
  readonly head: number
  /** The count of updates and deletes of the scope's facts, without the
   *  deletes of superseded rows of a replace-only family, which never change
   *  a fold. Any other rewrite advances it. */
  readonly generation: number
  /** The newest fact of the scope at or below the requested position whose
   *  family keeps its history, or null when there is none. A typed scope
   *  never anchors on a replace-only family, whose rows a prune deletes. */
  readonly anchor: FoldAnchor | null
}

/** Asks a page for the fold evidence of its query, anchored at `anchorAt`. */
export interface FoldEvidenceRequest {
  readonly anchorAt: number
}

interface AsyncEventReadSlice {
  readonly facts: readonly (StoredFact | CorruptEventRowError)[]
  readonly toolContent: ContentResolver
}

interface AsyncEventReadPage extends AsyncEventReadSlice {
  readonly upperPosition: number
  readonly continuationPosition: number | null
  /** Present when the request asked for it and the reader can read it. The
   *  reader reads it before the page's facts, so a rewrite between the two
   *  shows as a changed generation at the next evidence read. */
  readonly foldEvidence?: FoldEvidence
}

/** Ordered durable read boundary used by projections. One captured position
 * bounds every page in a catch-up, so a busy writer cannot extend that replay
 * indefinitely. Facts are in ascending workspace position order. Each page
 * carries referenced content for its facts, with integrity failures raised by
 * the resolver so historical reducers can record their own degraded gaps.
 * Metadata indexes can defer content; selected facts must then be read through
 * readSlice or contentFor before hydration. */
export interface AsyncEventReadSurface {
  capturePosition(): Promise<number>
  /** Latest durable position for one fact type through a descending LIMIT 1 probe. */
  latestPosition?(type: string): Promise<number>
  /** One page of `query` in ascending position order, strictly after both
   * `query.afterPosition` and the `afterPosition` cursor, strictly before
   * `query.beforePosition`, and at or below `upperPosition`. `query.limit`
   * caps the rows of this page, not of the whole read; `pageReadQuery` owns
   * these bounds. A strict page decodes every row it reads, its lookahead
   * row included, and never reads a row past `upperPosition`. An absent
   * ceiling is captured in this first page and returned for continuations.
   * With `evidence`, the page also carries the fold evidence of `query`; a
   * reader that cannot read it returns the page without it. */
  readPage(
    query: FactQuery,
    upperPosition: number | undefined,
    afterPosition: number,
    tolerant?: boolean,
    content?: "eager" | "deferred",
    evidence?: FoldEvidenceRequest,
  ): Promise<AsyncEventReadPage>
}

/** The range of one captured read: facts strictly after `afterPosition` and
 *  at or below `upperPosition`. An absent ceiling is captured when the read
 *  starts, so a busy writer cannot extend the read. */
interface CapturedReadBounds {
  readonly upperPosition?: number
  readonly afterPosition?: number
}

/** Strict read of every `query` match in ascending position order through one
 *  captured ceiling. It throws the first corrupt row, because its callers fold
 *  current Flywheel facts that must decode. It yields to the task queue
 *  between pages: a local reader answers each page in microtasks, so a long
 *  scan would otherwise hold the event loop for the whole history. Pages defer
 *  their content because the caller receives the facts without a resolver.
 * @yields {StoredFact} Each match inside the bounds. */
export async function* capturedFacts(reader: AsyncEventReadSurface, query: FactQuery, bounds: CapturedReadBounds = {}): AsyncGenerator<StoredFact> {
  const upper = bounds.upperPosition ?? await reader.capturePosition()
  let position = bounds.afterPosition ?? 0
  // A cursor at the ceiling has nothing above it, so an idle catch-up costs no page.
  if (position >= upper) return
  for (;;) {
    const page = await reader.readPage(query, upper, position, false, "deferred")
    for (const fact of page.facts) {
      // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the narrowed durable-row Error and its identity
      if (fact instanceof CorruptEventRowError) throw fact
      yield fact
    }
    if (page.continuationPosition === null) return
    position = page.continuationPosition
    await yieldToNextTask()
  }
}

/** Every match of `capturedFacts`, for a caller that needs the whole set before it folds. */
export function readCapturedFacts(reader: AsyncEventReadSurface, query: FactQuery, bounds: CapturedReadBounds = {}): Promise<StoredFact[]> {
  return Array.fromAsync(capturedFacts(reader, query, bounds))
}

/** Exact asynchronous state reads used by interactive executors and by local
 * offline compositions through the direct adapter. */
export interface AsyncEventStateReadSurface extends AsyncEventReadSurface {
  /** Session-scoped immutable nodes. Absence is not an empty content node. */
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: transport preserves malformed storage values for the shared unavailable-evidence decoder.
  readSessionContentNode?(sessionId: string, sha256: string): Promise<unknown | null>
  /** Raw byte windows preserve partial UTF-8 characters. */
  readSessionContentRange?(sessionId: string, reference: SessionContentReference, offset: number, length: number): Promise<SessionContentRange>
  latestPosition(type: string): Promise<number>
  readLatestPayloadByAggregateAndType(aggregateId: string, type: string): Promise<string | null>
  readLatestByAggregateAndTypes(aggregateId: string, types: readonly string[]): Promise<StoredFact[]>
  readInFlight(sessionId: string, kind: string | readonly string[], keyPrefix?: string): Promise<InFlightRecord[]>
  sessionsWithInFlight(kind: string): Promise<string[]>
  /** Keys of a profile's pending or measured in-flight cells of `kind`, across sessions, in one read. */
  inFlightProfileKeys(kind: string, profileId: string): Promise<string[]>
  countByAggregate(aggregateId: string): Promise<number>
  aggregateSeq(aggregateId: string): Promise<number>
  /** Finishes the work that a sequence read or a write of the named sessions
   *  would otherwise start inside the caller. A caller that holds an ordered
   *  lane across such reads and writes calls it before it takes the lane,
   *  because work started inside the lane can need the same lane. Only a
   *  reader whose reads start such work, such as the state Worker's, which
   *  recovers an owed session first, has it. */
  settleBefore?(sessionIds: readonly string[]): Promise<void>
  /** Exact query. A query with a limit or positions is one indexed probe
   * whose order and limit reach the owning reader unchanged; any other
   * query reads every match through one captured position. */
  readSlice(query: FactQuery, tolerant?: boolean): Promise<AsyncEventReadSlice>
  /** The content that `facts` reference, for facts that reached the caller
   *  without a page, such as a post-commit broadcast. */
  contentFor(facts: readonly StoredFact[]): Promise<ContentResolver>
}

export interface EventReader {
  read(query?: FactQuery): StoredFact[]
  /** Tolerant variant for the sanctioned per-session-isolation consumers --
   *  the workspace session catalog and session repair (ARCH-BOUNDARIES-001 and ARCH-SUBSTRATE-013 permit
   *  tolerant parsing only inside such contracts). Corrupt rows come back as
   *  `CorruptEventRowError` values in sequence position instead of aborting
   *  the whole read. */
  readTolerant(query?: FactQuery): Array<StoredFact | CorruptEventRowError>
  readLatestPayloadByAggregateAndType(aggregateId: string, type: string): string | null
  /** Latest row for each requested type through bounded aggregate/type index probes. */
  readLatestByAggregateAndTypes(aggregateId: string, types: readonly string[]): StoredFact[]
  /** This session's live in-flight values for one or more kinds, in shared
   *  insertion order. Never a fact source: read only by the recovery path that
   *  resumes an interrupted operation. An optional literal key prefix restricts
   *  the rows at the storage boundary. */
  readInFlight(sessionId: string, kind: string | readonly string[], keyPrefix?: string): InFlightRecord[]
  /** Sessions holding any live in-flight value of `kind`. The workspace sweep
   *  that reconciles interrupted operations needs to find them without a fact
   *  to scan for. */
  sessionsWithInFlight(kind: string): string[]
  /** Keys of the cells whose payload.profileId or payload.entry.profileId names the profile, without reading
   *  session cells. */
  inFlightProfileKeys(kind: string, profileId: string): string[]
  currentPosition(): number
  countByAggregate(aggregateId: string): number
  /** Last assigned per-aggregate seq from the `event_sequence` counter (-1
   *  when the aggregate has no events). The token a guarded append's
   *  `expectedSeq` is derived from; NOT max(seq) of surviving rows, which
   *  out-of-band deletion can lower while the counter stays monotonic. */
  aggregateSeq(aggregateId: string): number
}

interface PageRead {
  /** The page's exclusive lower position. */
  readonly after: number
  /** The most rows the page holds. */
  readonly rows: number
  readonly query: FactQuery
}

/** One `readPage` call as one store query, shared by every reader so all
 * readers page alike. The cursor composes with the query's own lower bound
 * rather than replacing it, so a caller's filter survives paging, and the
 * ceiling composes with the query's own upper bound in the same way. The
 * ceiling is part of the store query, so no reader decodes a row past it. The
 * row count is clamped to [1, maxRows]: a page always holds at least one row,
 * so a paging loop always advances. The store query asks for one lookahead
 * row, which shows whether a next page exists. */
export function pageReadQuery(query: FactQuery, upperPosition: number, afterPosition: number, maxRows: number): PageRead {
  // Each page would apply the bound again, so the pages together would not.
  if (query.limitPerAggregate !== undefined) throw new Error("FactQuery.limitPerAggregate bounds one slice and cannot be paged")
  const after = Math.max(query.afterPosition ?? 0, afterPosition)
  const before = Math.min(query.beforePosition ?? Number.POSITIVE_INFINITY, upperPosition + 1)
  const rows = Math.max(1, Math.min(query.limit ?? maxRows, maxRows))
  return { after, rows, query: { ...query, afterPosition: after, beforePosition: before, order: "asc", limit: rows + 1 } }
}

const LOCAL_READ_PAGE_ROWS = 256
const localReadSurfaces = new WeakMap<EventReader, AsyncEventStateReadSurface>()

/** Direct adapter for offline commands and focused tests that own a local
 * SQLite reader. Interactive runtimes use the project-state read port. */
export function asAsyncEventReadSurface(store: EventReader | EventStoreReadSurface): AsyncEventStateReadSurface {
  const existing = localReadSurfaces.get(store)
  if (existing) return existing
  const readNode = "readSessionContentNode" in store ? store.readSessionContentNode?.bind(store) : undefined
  const surface: AsyncEventStateReadSurface = {
    ...(readNode ? {
      readSessionContentNode: async (sessionId: string, sha256: string) => readNode(sessionId, sha256),
      readSessionContentRange: async (sessionId: string, reference: SessionContentReference, offset: number, length: number) =>
        readSessionContentRange(reference, offset, length, async sha256 => readNode(sessionId, sha256)),
    } : {}),
    capturePosition: async () => store.currentPosition(),
    latestPosition: async (type) => store.readTolerant({ types: [type], order: "desc", limit: 1 })[0]?.position ?? 0,
    readLatestPayloadByAggregateAndType: async (aggregateId, type) => store.readLatestPayloadByAggregateAndType(aggregateId, type),
    readLatestByAggregateAndTypes: async (aggregateId, types) => store.readLatestByAggregateAndTypes(aggregateId, types),
    readInFlight: async (sessionId, kind, keyPrefix) => store.readInFlight(sessionId, kind, keyPrefix),
    sessionsWithInFlight: async (kind) => store.sessionsWithInFlight(kind),
    inFlightProfileKeys: async (kind, profileId) => store.inFlightProfileKeys(kind, profileId),
    countByAggregate: async (aggregateId) => store.countByAggregate(aggregateId),
    aggregateSeq: async (aggregateId) => store.aggregateSeq(aggregateId),
    contentFor: async () => "toolContent" in store ? store.toolContent : NO_CONTENT,
    readSlice: async (query, tolerant = false) => ({
      facts: tolerant ? store.readTolerant(query) : store.read(query),
      toolContent: "toolContent" in store ? store.toolContent : NO_CONTENT,
    }),
    readPage: async (query, upperPosition, afterPosition, tolerant, content, evidence) => {
      const foldEvidence = evidence && "foldEvidence" in store ? store.foldEvidence(query, evidence.anchorAt) : undefined
      const ceiling = upperPosition ?? store.currentPosition()
      const page = pageReadQuery(query, ceiling, afterPosition, LOCAL_READ_PAGE_ROWS)
      // An idle page captures only the position, without querying fact rows.
      const rows = ceiling <= page.after ? [] : tolerant ? store.readTolerant(page.query) : store.read(page.query)
      const facts = rows.slice(0, page.rows)
      const continuationPosition = rows.length > facts.length ? (facts.at(-1)?.position ?? page.after) : null
      return {
        facts,
        upperPosition: ceiling,
        continuationPosition,
        toolContent: content !== "deferred" && "toolContent" in store ? store.toolContent : NO_CONTENT,
        ...(foldEvidence ? { foldEvidence } : {}),
      }
    },
  }
  localReadSurfaces.set(store, surface)
  return surface
}

/** The page hands its reader the store's own resolver. Verification is not
 *  the page's job: every durable reader hydrates through
 *  `resolveToolContentReference`, which proves each reference exactly where
 *  the text is used, so walking every payload node here to pre-resolve and
 *  hash content the reducer will hash again would only double the work. */
const NO_CONTENT: ContentResolver = { resolve: () => null }

interface EventWriter {
  append(event: EventStoreAppend): StoredFact
  appendBatch(events: readonly EventStoreAppend[]): StoredFact[]
  appendGuarded(event: GuardedEventStoreAppend): GuardedAppendResult
  appendBatchGuarded(events: readonly GuardedEventStoreAppend[]): GuardedAppendResult
}

/** The fact-append surface every recorder targets. Aggregates that are
 *  append-only by design (the chat tree, ARCH-SESSIONS-047) take exactly this, so
 *  delete and prune are unrepresentable for them at the type level. */
export interface AsyncEventAppender {
  append(event: EventStoreAppend): Promise<StoredFact>
  appendBatch(events: readonly EventStoreAppend[]): Promise<StoredFact[]>
}

export interface AsyncGuardedEventAppender extends AsyncEventAppender {
  appendGuarded(event: GuardedEventStoreAppend): Promise<GuardedAppendResult>
  appendBatchGuarded(events: readonly GuardedEventStoreAppend[]): Promise<GuardedAppendResult>
}

export function requireGuardedEventAppender(
  writer: AsyncEventAppender,
  message: string,
): AsyncGuardedEventAppender {
  if (!isAsyncGuardedEventAppender(writer)) throw new Error(message)
  return writer
}

function isAsyncGuardedEventAppender(writer: AsyncEventAppender): writer is AsyncGuardedEventAppender {
  return (
    "appendGuarded" in writer && typeof writer.appendGuarded === "function"
    && "appendBatchGuarded" in writer && typeof writer.appendBatchGuarded === "function"
  )
}

/** Out-of-band maintenance for replace-only projections: superseded-row
 *  pruning. Never part of the event-sourcing append path. */
interface AsyncEventMaintenance {
  pruneSupersededEvents(aggregateId: string, eventType: string): Promise<number>
  /** Keyed sibling of `pruneSupersededEvents`: keep the newest row of
   *  `eventType` per distinct `payloadKey` JSON-path value, delete the rest.
   *  Optional: a store that cannot prune does not offer it. */
  pruneSupersededKeyedEvents?(aggregateId: string, eventType: string, payloadKey: string): Promise<number>
  /** Records in-flight recovery state for an operation that has just begun,
   *  with no fact beside it. Optional: a store that cannot hold it does not
   *  offer it, and a caller that needs it fails loudly rather than recording
   *  nothing. The returned promise settles when the state is durable; a
   *  caller whose contract is record-before-act must await it and treat a
   *  rejection as the operation being refused. Retirement rides the append
   *  that records the outcome. */
  putInFlight?(sessionId: string, kind: string, key: string, payload: unknown): Promise<void>
  /** Retires one in-flight value outside an append, for the rare settlement
   *  with no fact beside it (a queued input recalled back into the editor).
   *  Ordinary retirement rides the outcome append's `inFlight` writes. */
  dropInFlight?(sessionId: string, kind: string, key: string): Promise<void>
}

export interface AsyncEventWriter extends AsyncEventAppender, AsyncEventMaintenance {
  /** Stage immutable nodes in the existing session content ownership. A fact
   * may name a root only after the writer proves its complete staged closure. */
  stageSessionContentNodes?(sessionId: string, nodes: readonly SessionContentNodeRow[]): Promise<void>
  appendGuarded?(event: GuardedEventStoreAppend): Promise<GuardedAppendResult>
  appendBatchGuarded?(events: readonly GuardedEventStoreAppend[]): Promise<GuardedAppendResult>
  /** Serializes a compare-and-swap through the process's writer lane. */
  swapInFlight?(sessionId: string, kind: string, key: string, expectedRaw: string | null, payload: unknown | null): Promise<boolean>
  /** Atomically applies an exact-raw guarded cell set through the writer lane. */
  swapInFlightBatch?(sessionId: string, swaps: readonly InFlightSwap[]): Promise<boolean>
}

export interface AsyncGuardedEventWriter extends AsyncEventWriter {
  appendGuarded(event: GuardedEventStoreAppend): Promise<GuardedAppendResult>
  appendBatchGuarded(events: readonly GuardedEventStoreAppend[]): Promise<GuardedAppendResult>
}

export interface LocalSqliteEventStore extends EventStoreReadSurface, EventWriter {
  stageSessionContentNodes(sessionId: string, nodes: readonly SessionContentNodeRow[]): void
  /** Local SQLite callback transaction for in-process callers only; it is not
   *  cross-process-safe and does not translate to an async writer boundary. */
  transaction(fn: () => void): void
  /** The writer-lane commit seam: one flush transaction, one settlement per
   *  item, each item isolated behind a savepoint. Only a writer lane over
   *  this connection calls it; every runtime durable append funnels through
   *  that lane rather than the synchronous methods above. */
  commitItems(items: ReadonlyArray<EventStoreWriteItem>): EventStoreItemSettlement[]
  /** Post-commit broadcast of every fact stored through this connection.
   *  Fires synchronously after the owning commit (never for a rolled-back
   *  fact), so in-process projections can fold pushed events instead of
   *  polling SQLite for freshness. Returns the unsubscribe. */
  onStored(listener: (events: readonly StoredFact[]) => void): () => void
  /** Out-of-band retirement for an aggregate whose domain declares its whole
   *  history disposable. Deletes the sequence authority so the next append
   *  starts at seq 0, and returns the number of fact rows removed. */
  deleteAggregate(aggregateId: string): number
  /** Out-of-band maintenance: delete every row of `type` on `aggregateId`
   *  except the latest, returning the number pruned. For replace-only
   *  projections (where each event supersedes the prior) the older rows are
   *  loss-free dead weight. Never called inside `append()`; it mutates rows,
   *  which the event-sourcing write path must not. `event_sequence` is
   *  untouched, so the aggregate's seq counter stays monotonic. */
  pruneSupersededEvents(aggregateId: string, eventType: string): number
  /** Keyed sibling of `pruneSupersededEvents`: keep the newest row per
   *  distinct `payloadKey` JSON-path value (e.g. `$.attemptId`). */
  pruneSupersededKeyedEvents(aggregateId: string, eventType: string, payloadKey: string): number
  /** Records in-flight recovery state with no fact beside it, for the moment an
   *  operation begins. Its retirement rides the append that records the
   *  outcome, so the two can never disagree. Synchronous on this local
   *  connection: when it returns, the state is durable; when it throws, the
   *  caller knows nothing was recorded. */
  putInFlight(sessionId: string, kind: string, key: string, payload: unknown): void
  /** Retires one in-flight value outside an append (a settlement with no
   *  fact beside it, such as a queued input recalled into the editor). */
  dropInFlight(sessionId: string, kind: string, key: string): void
  /** Optimistic concurrency for a contended in-flight cell, the cell-shaped
   *  sibling of a guarded append's `expectedSeq`: the write lands only when
   *  the stored payload still matches `expectedRaw` (`null` expects absence),
   *  so two processes racing for one cell settle in a single atomic
   *  statement. A `null` payload retires the cell under the same guard.
   *  Returns whether this caller's write won. */
  swapInFlight(sessionId: string, kind: string, key: string, expectedRaw: string | null, payload: unknown | null): boolean
  swapInFlightBatch(sessionId: string, swaps: readonly InFlightSwap[]): boolean
  close(): void
}

export type EventStore = LocalSqliteEventStore

/** In-process write surface backing an `AsyncEventWriter`: the synchronous
 *  tooling store or the lane-owned runtime store, whose methods already
 *  return promises. Either way the writes land on a local connection. */
type LocalEventWrites = {
  stageSessionContentNodes?(sessionId: string, nodes: readonly SessionContentNodeRow[]): void | Promise<void>
  append(event: EventStoreAppend): StoredFact | Promise<StoredFact>
  appendBatch(events: readonly EventStoreAppend[]): StoredFact[] | Promise<StoredFact[]>
  appendGuarded(event: GuardedEventStoreAppend): GuardedAppendResult | Promise<GuardedAppendResult>
  appendBatchGuarded(events: readonly GuardedEventStoreAppend[]): GuardedAppendResult | Promise<GuardedAppendResult>
  pruneSupersededEvents(aggregateId: string, eventType: string): number | Promise<number>
  pruneSupersededKeyedEvents?(aggregateId: string, eventType: string, payloadKey: string): number | Promise<number>
  putInFlight?(sessionId: string, kind: string, key: string, payload: unknown): void | Promise<void>
  dropInFlight?(sessionId: string, kind: string, key: string): void | Promise<void>
  swapInFlight?(sessionId: string, kind: string, key: string, expectedRaw: string | null, payload: unknown | null): boolean | Promise<boolean>
  swapInFlightBatch?(sessionId: string, swaps: readonly InFlightSwap[]): boolean | Promise<boolean>
}
type LocalEventAppends = Pick<LocalEventWrites, "append" | "appendBatch" | "appendGuarded" | "appendBatchGuarded">

/** Adapt a local store to the `AsyncEventAppender` boundary. A synchronous
 *  store resolves immediately; the lane-owned runtime store resolves when its
 *  flush commits. */
export function asAsyncEventAppender(store: LocalEventAppends): AsyncGuardedEventAppender {
  return {
    append: async (event) => store.append(event),
    appendBatch: async (events) => store.appendBatch(events),
    appendGuarded: async (event) => store.appendGuarded(event),
    appendBatchGuarded: async (events) => store.appendBatchGuarded(events),
  }
}

/** Adapt a local store to the full `AsyncEventWriter` boundary: the append
 *  surface plus the maintenance surface. */
export function asAsyncEventWriter(store: LocalEventWrites): AsyncGuardedEventWriter {
  const stageNodes = store.stageSessionContentNodes?.bind(store)
  return {
    ...(stageNodes ? {
      stageSessionContentNodes: async (sessionId: string, nodes: readonly SessionContentNodeRow[]) => { await stageNodes(sessionId, nodes) },
    } : {}),
    ...asAsyncEventAppender(store),
    pruneSupersededEvents: async (aggregateId, eventType) => store.pruneSupersededEvents(aggregateId, eventType),
    ...(store.pruneSupersededKeyedEvents
      ? { pruneSupersededKeyedEvents: async (aggregateId: string, eventType: string, payloadKey: string) => store.pruneSupersededKeyedEvents?.(aggregateId, eventType, payloadKey) ?? 0 }
      : {}),
    // Optional on the boundary: a store that cannot hold in-flight state does
    // not offer the methods, and a caller that needs them fails loudly.
    ...(store.putInFlight
      ? { putInFlight: async (sessionId: string, kind: string, key: string, payload: unknown) => { await store.putInFlight?.(sessionId, kind, key, payload) } }
      : {}),
    ...(store.dropInFlight
      ? { dropInFlight: async (sessionId: string, kind: string, key: string) => { await store.dropInFlight?.(sessionId, kind, key) } }
      : {}),
    ...(store.swapInFlight
      ? { swapInFlight: async (sessionId: string, kind: string, key: string, expectedRaw: string | null, payload: unknown | null) => store.swapInFlight?.(sessionId, kind, key, expectedRaw, payload) ?? false }
      : {}),
    ...(store.swapInFlightBatch
      ? { swapInFlightBatch: async (sessionId: string, swaps: readonly InFlightSwap[]) => store.swapInFlightBatch?.(sessionId, swaps) ?? false }
      : {}),
  }
}

/** A reader given no explicit writer must be a local writable store. Cross-process
 *  replay readers cannot append, so narrow structurally and throw `message` rather than
 *  silently dropping writes. */
export function requireLocalAsyncWriter(store: EventReader, message: string): AsyncGuardedEventWriter {
  if (!isLocalEventWrites(store)) throw new Error(message)
  return asAsyncEventWriter(store)
}

function isLocalEventWrites(store: EventReader): store is EventReader & LocalEventWrites {
  return (
    "append" in store && typeof store.append === "function" &&
    "appendBatch" in store && typeof store.appendBatch === "function" &&
    "appendGuarded" in store && typeof store.appendGuarded === "function" &&
    "appendBatchGuarded" in store && typeof store.appendBatchGuarded === "function" &&
    "pruneSupersededEvents" in store && typeof store.pruneSupersededEvents === "function"
  )
}
