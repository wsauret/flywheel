import { errorDetail, errorMessage } from "./error-message.js"
import { probeLoopUnit } from "./event-loop-lag.js"
import {
  CorruptEventRowError,
  type AsyncEventReadSurface,
  type FoldEvidenceRequest,
  type StoredFact,
} from "./event-store-types.js"
import { InvariantViolation } from "./invariant.js"
import { Log } from "./log.js"
import { durationMs, logCompletion } from "./operation-log.js"
import { foldCacheSlot, type CachedFold, type FoldCacheSlot } from "./projection-fold-cache.js"
import { createReadQueue } from "./read-queue.js"
import { yieldToNextTask } from "./task-scheduling.js"
import type { ContentResolver } from "./tool-content.js"

interface ProjectionSeed<S> { state: S; position: number }

/** What a projection reads. An untyped family has no index that orders it by
 *  position, so its catch-up walks every workspace row after its cursor. Its
 *  definition must therefore start from a captured position: a cold read
 *  from position 0 walks the whole event table. */
type ProjectionScope<S> =
  | {
    aggregatePrefix?: undefined
    aggregateId?: string
    aggregateIds?: readonly string[]
    factTypes?: readonly string[]
    seed?: () => Promise<ProjectionSeed<S> | undefined> | ProjectionSeed<S> | undefined
  }
  | {
    aggregatePrefix: string
    aggregateId?: undefined
    aggregateIds?: undefined
    factTypes?: undefined
    seed: () => Promise<ProjectionSeed<S>> | ProjectionSeed<S>
  }
  | {
    aggregatePrefix: string
    aggregateId?: undefined
    aggregateIds?: undefined
    factTypes: readonly string[]
    seed?: () => Promise<ProjectionSeed<S> | undefined> | ProjectionSeed<S> | undefined
  }

/** A family of root facts, the newest of which can replace the folded state.
 *  A catch-up reads the root types with the folded types and resets at the
 *  newest root of each page before it folds that page, so a live catch-up
 *  needs no separate probe of the root. */
interface ResetBoundary {
  /** The root types. A catch-up folds a root only when the definition's
   *  `factTypes` also name its type. */
  readonly types: readonly string[]
  /** The reset position at the newest root in history. The first catch-up
   *  reads it once, before any fact, so a cold fold never folds superseded
   *  history. Throws when the newest root is invalid. */
  read(): Promise<number | undefined> | number | undefined
  /** The reset position at the newest root among `facts`, or undefined when
   *  that root resets nothing or `facts` hold no root. Throws when that root
   *  is invalid. */
  within(facts: readonly (StoredFact | CorruptEventRowError)[]): number | undefined
}

type ProjectionDefinition<S extends object> = ProjectionScope<S> & {
  name?: string
  /** Fold a damaged row of an untyped scope through `reduceCorruptRow`
   *  instead of failing the read. A typed scope always does. */
  tolerateScopedCorruption?: boolean
  resetBoundary?: ResetBoundary
  /** The reducer reads no tool content. A pushed fact of `aggregateId` whose
   *  seq directly follows the aggregate's facts that this projection has
   *  accounted for then folds without a read, because the per-aggregate seq
   *  proves that no writer committed a fact between them. */
  foldsPushedFacts?: boolean
  /** The reducer reads the tool content that its facts reference, so each
   *  page carries it. Every other projection reads pages without content. */
  readsToolContent?: boolean
  initialState(): S
  /** Returns a copy of a published state that `reduce` and `reduceCorruptRow`
   *  may change in place and return. Each catch-up makes one draft, at its
   *  first folded fact, so a fold whose pure step would copy the whole state
   *  costs one copy per catch-up instead of one per fact. A reducer must not
   *  change the draft and then throw: the facts folded before a failure stay
   *  published. Without this hook, the reducers must return new states. */
  draft?(state: S): S
  reduce(state: S, event: StoredFact, toolContent: ContentResolver): S
  reduceCorruptRow?(state: S, corrupt: CorruptEventRowError): S
  /** The family's salvage rule for a fact whose body its strict parser
   *  refused (`parseProjectionFact`). The fact keeps its bytes; the hook
   *  folds what the family can still state without it, such as an absent
   *  value it rebuilds from other facts or a typed gap, and the fold moves
   *  past the fact. Without this hook, the refusal fails the catch-up at
   *  that fact. */
  reduceUnreadableFact?(state: S, event: StoredFact, violation: InvariantViolation): S
}

export interface EventProjection<S extends object> {
  /** Last folded state, initially the empty state. Await replay or apply before use. */
  getState(): S
  /** Position of the last folded fact. A seed or a reset boundary also sets it. */
  getPosition(): number
  /** Fold through a committed position captured after this call, after all
   *  earlier queued operations. Callers that wait together share one fold. */
  replay(): Promise<S>
  /** Notify of committed facts. Read their ordered history and content from
   *  the same authority. A fact outside the aggregates or types of the
   *  definition causes no read: a reader that must see the facts other
   *  writers committed before it calls `replay`. */
  apply(events: StoredFact | readonly StoredFact[]): Promise<S>
}

type FactEnvelope = { type: string; version: number; actor: string; payload: unknown }
type FactParser<T> = (value: FactEnvelope) => T
const log = Log.create({ service: "event-projection" })
/** A catch-up this slow is a pause a person can notice. */
const SLOW_CATCHUP_MS = 1_000
/** A replay from the start over this many events rebuilds a whole aggregate.
 *  A held projection does it once, when it is built; a projection rebuilt
 *  from the start on every store change is the replay starvation that froze
 *  a worker once, and it stays visible only if each rebuild records, however
 *  fast. */
const FULL_REPLAY_NOTABLE_EVENTS = 1_000
const EMPTY_CONTENT: ContentResolver = { resolve: () => null }

type ReadPage = Awaited<ReturnType<AsyncEventReadSurface["readPage"]>>
type ProjectionPage = Pick<ReadPage, "facts" | "toolContent">
/** The next page strictly after `afterPosition`, at or below the ceiling. */
type PageSource = (upperPosition: number | undefined, afterPosition: number, evidence?: FoldEvidenceRequest) => Promise<ReadPage>

const heldKeyBinders = new WeakMap<object, (key: string) => void>()

/** Names the key under which the projection registry holds `projection`, so
 *  a projection that `createEventProjection` built may start from and save
 *  to the fold cache attached to its reader (ARCH-SUBSTRATE-016). Must run
 *  before the projection's first operation; any other object is ignored. */
export function bindHeldKey<P extends object>(projection: P, key: string): void {
  heldKeyBinders.get(projection)?.(key)
}

export interface PositionedEventProjection<S extends object> extends EventProjection<S> {
  /** Captured read ceiling, including facts outside the filter. */
  getReadPosition(): number
  /** Folds facts that the caller read for this projection, with no durable
   *  request, so one read of many aggregates can advance many projections.
   *  The caller must have read, through `upperPosition`, every committed fact
   *  of this projection's scope after `getReadPosition()`, with the same
   *  tolerance as the projection's own reads, and pass them as pages in
   *  position order. Facts at or below the read position are skipped, so a
   *  read that started below it is safe. Runs after every earlier queued
   *  operation, initializes the projection first, and then sets the read
   *  position to `upperPosition`. A projection with a reset boundary can
   *  still read that boundary after a failed fold. */
  foldRead(pages: readonly ProjectionPage[], upperPosition: number): Promise<S>
}

/** Serves supplied pages to a catch-up. A retry from an earlier position,
 *  after a reset, gets the first page that holds a fact after it again. */
function suppliedPages(pages: readonly ProjectionPage[], upperPosition: number): PageSource {
  const lastPosition = (page: ProjectionPage): number => page.facts.at(-1)?.position ?? 0
  return async (_upperPosition, afterPosition) => {
    const index = pages.findIndex((page) => lastPosition(page) > afterPosition)
    const page = pages[index]
    if (!page) return { facts: [], toolContent: EMPTY_CONTENT, upperPosition, continuationPosition: null }
    return { ...page, upperPosition, continuationPosition: index < pages.length - 1 ? lastPosition(page) : null }
  }
}

export function createEventProjection<S extends object>(
  reader: AsyncEventReadSurface,
  definition: ProjectionDefinition<S>,
): PositionedEventProjection<S> {
  let position = 0
  // Every committed fact at or below this position has been read. It runs
  // ahead of `position` when the facts read after the last fold matched no
  // filter, so a filtered projection reads each committed range once. Writers
  // commit in position order, so a read through a committed position is complete.
  let readPosition = 0
  let state = definition.initialState()
  let initialized = false
  // With `foldsPushedFacts`: the seq through which every fact of the aggregate
  // has been folded or proved irrelevant. Undefined until a read or a push proves one.
  let accountedSeq: number | undefined
  const projection = projectionName(definition)
  const boundary = definition.resetBoundary
  const factTypes = definition.factTypes && new Set(definition.factTypes)
  // Root types that a catch-up reads only to find a reset, never to fold.
  const rootOnlyTypes = boundary && factTypes && new Set(boundary.types.filter((type) => !factTypes.has(type)))
  const readTypes = rootOnlyTypes && definition.factTypes ? [...definition.factTypes, ...rootOnlyTypes] : definition.factTypes
  const readTypeSet = readTypes && new Set(readTypes)
  const scope = { aggregateId: definition.aggregateId, aggregateIds: definition.aggregateIds, aggregatePrefix: definition.aggregatePrefix, types: readTypes }
  const tolerant = Boolean(definition.reduceCorruptRow && (definition.factTypes || definition.tolerateScopedCorruption))
  const content = definition.readsToolContent ? "eager" : "deferred"
  // The fold cache. A seeded projection starts from its seed instead, which
  // may read beyond its own facts, and a prefix scope has no cheap evidence.
  // `generation` is the scope's rewrite generation before the first fact
  // this instance folded; until a page proves it, nothing is saved, and
  // after it changes no save of this instance writes.
  let cache: FoldCacheSlot | undefined
  let cachedFold: CachedFold | undefined
  let generation: number | undefined

  async function initialize(): Promise<void> {
    if (initialized) return
    const seed = await definition.seed?.()
    if (seed) {
      state = seed.state
      position = seed.position
      readPosition = seed.position
    } else {
      cachedFold = cache?.load()
    }
    if (boundary) {
      let reset: number | undefined
      try {
        reset = await boundary.read()
      } catch (error) {
        state = definition.initialState()
        throw error
      }
      if (reset !== undefined && reset > position) {
        state = definition.initialState()
        position = reset
        // No folded fact lies after the boundary, so the facts between the boundary
        // and the read position matched no filter. The read position never moves back.
        readPosition = Math.max(readPosition, reset)
      }
    }
    // A fold that a newer root supersedes is history this projection discards.
    if (cachedFold && cachedFold.position < position) cachedFold = undefined
    initialized = true
  }

  const readStoredPage: PageSource = (upperPosition, afterPosition, evidence) =>
    reader.readPage(scope, upperPosition, afterPosition, tolerant, content, evidence)

  const requestSave = (): void => {
    reads.run(saveFold).catch((error: unknown) => log.debug("projection fold save failed", { projection, error: errorMessage(error) }))
  }

  async function saveFold(): Promise<S> {
    if (!cache?.accepts() || generation === undefined) return state
    const at = readPosition
    const { foldEvidence } = await reader.readPage(scope, at, at, tolerant, "deferred", { anchorAt: at })
    // A reader that proved the first page reads evidence for every page.
    if (foldEvidence) await cache.save({ state, position, readPosition: at, generation, evidence: foldEvidence, contended: reads.contended })
    return state
  }

  async function catchUpToPosition(pushedPosition?: number, readNextPage: PageSource = readStoredPage): Promise<S> {
    await initialize()
    let upperPosition = pushedPosition
    if (upperPosition !== undefined && upperPosition <= readPosition) return state
    const start = performance.now()
    const fromPosition = readPosition
    let afterPosition = readPosition
    let count = 0
    let foldMs = 0
    // A catch-up publishes its folded state and position together once it
    // ends, so no reader sees a partial fold and a draft is never shared.
    let folded: S | undefined
    let foldedPosition = position
    let readThrough = readPosition
    // True when the reset moved past the folded position.
    const resetAt = (reset: number | undefined): boolean => {
      if (reset === undefined || reset <= foldedPosition) return false
      folded = definition.initialState()
      foldedPosition = reset
      readThrough = Math.max(readThrough, reset)
      return true
    }
    // An invalid newest root leaves no current state. Nothing of this
    // catch-up publishes, so the next one reads that root again.
    const invalidate = (): void => {
      folded = undefined
      foldedPosition = position
      readThrough = readPosition
      state = definition.initialState()
    }
    const resetWithin = (current: ResetBoundary, facts: readonly (StoredFact | CorruptEventRowError)[]): void => {
      let reset: number | undefined
      try {
        reset = current.within(facts)
      } catch (error) {
        invalidate()
        throw error
      }
      resetAt(reset)
    }
    // A page can fail on history that a valid root in a later page, or in
    // the same page behind a row that does not parse, supersedes. Only the
    // family's newest root decides, so a failure costs one boundary read and
    // a successful catch-up none. Without a newer reset, the original failure
    // propagates. A boundary read that the damaged newest root refuses also
    // clears the state; a read that fails for another reason, such as a
    // project-state request that is not served, changes nothing.
    const resetAfterFailure = async (current: ResetBoundary): Promise<boolean> => {
      try {
        return resetAt(await current.read())
      } catch (error) {
        if (error instanceof CorruptEventRowError || error instanceof InvariantViolation) invalidate()
        return false
      }
    }
    const applyPage = (page: ReadPage, ceiling: number): void => {
      if (boundary) resetWithin(boundary, page.facts)
      for (const entry of page.facts) {
        if (entry.position > ceiling || entry.position <= readThrough) continue
        if (rootOnlyTypes?.has(entry instanceof CorruptEventRowError ? entry.row.type : entry.type)) {
          readThrough = entry.position
          continue
        }
        folded ??= definition.draft ? definition.draft(state) : state
        if (entry instanceof CorruptEventRowError) {
          // SAFETY: tolerant pages are requested only when this reducer is supplied.
          folded = definition.reduceCorruptRow!(folded, entry)
        } else {
          folded = reduceReadable(definition, folded, entry, page.toolContent)
        }
        foldedPosition = entry.position
        readThrough = entry.position
      }
    }
    // The first page that a cache-backed projection reads carries the fold
    // evidence: it proves the cached fold before any of the page is folded,
    // or it records the generation that a later save must still find.
    let proving = cache !== undefined && generation === undefined
    try {
      while (true) {
        try {
          const fold = proving ? cachedFold : undefined
          const page = await readNextPage(upperPosition, fold?.readPosition ?? afterPosition, proving ? { anchorAt: fold?.readPosition ?? readPosition } : undefined)
          upperPosition ??= page.upperPosition
          if (proving) {
            proving = false
            cachedFold = undefined
            const evidence = page.foldEvidence
            generation = evidence?.generation
            // A page source that holds no evidence, such as supplied pages,
            // can neither prove a fold nor let one be saved.
            if (!evidence) cache = undefined
            if (fold) {
              const adopted = evidence && cache?.adopt<S>(fold, evidence)
              if (!adopted) continue
              state = adopted
              position = fold.position
              foldedPosition = fold.position
              readPosition = fold.readPosition
              readThrough = fold.readPosition
            }
          }
          if (upperPosition <= readPosition) return state
          const ceiling = upperPosition
          const applyStart = performance.now()
          probeLoopUnit("projection-apply", projection, () => applyPage(page, ceiling))
          foldMs += performance.now() - applyStart
          count += page.facts.length
          if (page.continuationPosition === null) break
          afterPosition = page.continuationPosition
        } catch (error) {
          if (!boundary || !await resetAfterFailure(boundary)) throw error
          afterPosition = foldedPosition
          continue
        }
        await yieldToNextTask()
      }
    } catch (error) {
      log.error("projection catch-up failed", {
        projection, fromPosition, currentPosition: upperPosition, lastAppliedPosition: foldedPosition,
        events: count, durationMs: durationMs(start), error: errorMessage(error), errorDetail: errorDetail(error),
      })
      throw error
    } finally {
      if (folded) state = folded
      position = foldedPosition
      readPosition = readThrough
    }
    readPosition = upperPosition
    const fields = { projection, fromPosition, currentPosition: upperPosition, lastAppliedPosition: position, events: count }
    const elapsed = durationMs(start)
    if (count > 0) cache?.folded(count, foldMs, requestSave)
    if (fromPosition === 0 && count >= FULL_REPLAY_NOTABLE_EVENTS) log.info("projection catch-up done", { ...fields, durationMs: elapsed, fullReplay: true })
    else logCompletion(log, "projection catch-up done", fields, { durationMs: elapsed, slowMs: SLOW_CATCHUP_MS })
    return state
  }

  const reads = createReadQueue(() => catchUpToPosition())

  /** Folds a pushed fact only when its seq directly follows `accountedSeq`,
   *  and skips the rest, so a later fact never folds before a fact that
   *  another writer committed ahead of it. */
  function foldContiguous(events: readonly StoredFact[]): void {
    for (const event of events) {
      if (accountedSeq === undefined || event.aggregateId !== definition.aggregateId || event.seq !== accountedSeq + 1) continue
      if (event.position > readPosition) {
        if (!readTypeSet || readTypeSet.has(event.type)) {
          state = reduceReadable(definition, definition.draft ? definition.draft(state) : state, event, EMPTY_CONTENT)
          position = event.position
        }
        readPosition = event.position
      }
      accountedSeq = event.seq
    }
  }

  function apply(input: StoredFact | readonly StoredFact[]): Promise<S> {
    // Pushes are commit notifications. Without proof that no other writer
    // committed before them, a push reads through its position, which also
    // fills gaps from other writers before advancing. Only a fact that this
    // definition folds can change its state, and owners await their pushes on
    // the write path, so any other fact must not cost a read.
    const events = "position" in input ? [input] : input
    return reads.run(async () => {
      if (definition.foldsPushedFacts) {
        await initialize()
        foldContiguous(events)
      }
      const upperPosition = events.reduce((upper, event) =>
        (!definition.aggregateId || event.aggregateId === definition.aggregateId)
          && (!definition.aggregateIds || definition.aggregateIds.includes(event.aggregateId))
          && (!readTypeSet || readTypeSet.has(event.type))
          ? Math.max(upper, event.position) : upper, 0)
      if (upperPosition > readPosition) await catchUpToPosition(upperPosition)
      if (definition.foldsPushedFacts) {
        // Every fact of the aggregate at or below the read position is
        // accounted for, and seq order is position order inside an aggregate.
        for (const event of events) {
          if (event.aggregateId === definition.aggregateId && event.position <= readPosition && event.seq > (accountedSeq ?? -1)) accountedSeq = event.seq
        }
      }
      return state
    })
  }

  const api: PositionedEventProjection<S> = {
    getState: () => state,
    getPosition: () => position,
    getReadPosition: () => readPosition,
    replay: reads.read,
    apply,
    foldRead: (pages, upperPosition) => reads.run(() => catchUpToPosition(upperPosition, suppliedPages(pages, upperPosition))),
  }
  heldKeyBinders.set(api, (key) => {
    if (!definition.seed && definition.aggregatePrefix === undefined) cache = foldCacheSlot(reader, key)
  })
  return api
}

function projectionName<S extends object>(definition: ProjectionDefinition<S>): string {
  return definition.name ?? [definition.aggregateId ?? "workspace", definition.factTypes?.join("|") ?? "all"].join(":")
}

export function reduceEvents<S extends object>(
  events: readonly StoredFact[],
  definition: Pick<ProjectionDefinition<S>, "initialState" | "reduce" | "reduceUnreadableFact" | "factTypes">,
  toolContent: ContentResolver = EMPTY_CONTENT,
): S {
  let state = definition.initialState()
  for (const event of events) {
    if (definition.factTypes && !definition.factTypes.includes(event.type)) continue
    state = reduceReadable(definition, state, event, toolContent)
  }
  return state
}

/** Fold one fact, and route a refusal of that fact's own body to the
 *  family's salvage rule when it declares one. Any other failure, such as a
 *  fact that names a step no earlier fact created, still fails the fold. */
function reduceReadable<S extends object>(
  definition: Pick<ProjectionDefinition<S>, "reduce" | "reduceUnreadableFact">,
  state: S,
  event: StoredFact,
  toolContent: ContentResolver,
): S {
  if (!definition.reduceUnreadableFact) return definition.reduce(state, event, toolContent)
  try {
    return definition.reduce(state, event, toolContent)
  } catch (error) {
    if (!(error instanceof InvariantViolation) || error.kind !== "schema-mismatch" || error.eventPosition !== event.position) throw error
    return definition.reduceUnreadableFact(state, event, error)
  }
}

export function parseProjectionFact<T>(fact: StoredFact, parse: FactParser<T>): T {
  try {
    return parse({ type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload })
  } catch (error) {
    throw new InvariantViolation({
      kind: "schema-mismatch",
      eventType: fact.type,
      eventVersion: fact.version,
      eventPosition: fact.position,
      aggregateId: fact.aggregateId,
      detail: `version ${fact.version} (${fact.id}): ${errorMessage(error)}`,
    }, { cause: error })
  }
}
