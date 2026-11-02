import { Database } from "bun:sqlite"
import { workflowRunOwner } from "../module-catalog.js"
import { mkdirSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import { DebugLog } from "../../infra/debug-log.js"
import { errorMessage } from "../../infra/error-message.js"
import { CorruptEventRowError, type AsyncEventReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { createReadQueue, type ReadQueue } from "../../infra/read-queue.js"
import { admitPrivateDatabaseFiles, ensurePrivateDirectoryUnder, ensurePrivateFile } from "../../infra/private-path.js"
import { applySqliteBusyTimeout, applySqliteDurabilityPragmas, isSqliteBusyError } from "../../infra/sqlite-durability.js"
import { createStartupTimeline } from "../../infra/startup-timeline.js"
import { observeReleaseMemoryPhase, startReleaseMemorySampler } from "../../infra/startup-trace.js"
import { yieldToNextTask as defaultYieldToNextTask } from "../../infra/task-scheduling.js"
import { budgetSummaryFromState, type BudgetSummary, type UsageTotals } from "./budget-summary.js"
import { BUDGET_FACT_TYPES, initialBudgetProjectionState, reduceBudgetEvent, reduceBudgetFact, type BudgetProjectionState } from "./budget-projection.js"
import { DIFF_STAT_FACT_TYPES, foldDiffStatEvent, type DiffStatSummary } from "./diff-stat-summary.js"
import { decodeSessionMetadataFactForReplay, parseSessionMetadataFact } from "./session-metadata-facts.js"
import { SESSION_DURATION_FACT_TYPES, reduceSessionDurationEvent, type SessionDurationProjectionState } from "./session-duration-projection.js"
import { readStreamSummaryGeneration, tokensPerSecond } from "./session-generation-statistics.js"
import { parseSessionRuntimeFact } from "./session-runtime-event-types.js"
import {
  addDirectUsage,
  hasSummaryError,
  initializeSessionSummarySchema,
  insertSemanticUsage,
  propagateDescendantError,
  propagateEligibleChild,
  propagateUsageToAncestors,
  putSessionSummaryEdge,
  putSessionSummaryKind,
  putSummaryError,
  readDescendantUsage,
  readStoredSessionSummary,
  readSummaryErrors,
  readSummaryWatermark,
  rebuildSessionSummarySchema,
  type SessionSummaryScope,
  type StoredSessionSummary,
  updateSummaryWatermark,
} from "./session-summary-index-sql.js"
import { createReplayLocalSummaries, type ReplayLocalSummaries } from "./session-summary-replay-cache.js"

const WRITE_BUSY_TIMEOUT_MS = 5_000
/** The pause before a replay page tries the index's write lock again. A
 *  page commit takes a few milliseconds, so the lock is usually free by then. */
const PAGE_LOCK_RETRY_MS = 5

/** Commits one replay page and measures only the attempt that committed.
 *
 *  The account-history Worker and the executor-background Worker each replay
 *  this index through their own handle (ARCH-RUNTIME-011), so one Worker's page can
 *  meet the other's write lock. SQLite's busy handler would sleep this
 *  Worker's thread for that wait, in steps of the platform timer tick, and
 *  stop every read the Worker serves. The page therefore asks for the lock
 *  without a busy wait and waits for it asynchronously, within the same
 *  bound as a blocking wait; past that bound the busy error ends the replay. */
async function commitPage(db: Database, write: () => number): Promise<{ position: number; transactionMs: number; lockWaits: number }> {
  const deadline = performance.now() + WRITE_BUSY_TIMEOUT_MS
  for (let lockWaits = 0; ; lockWaits++) {
    const started = performance.now()
    applySqliteBusyTimeout(db, 0)
    try {
      const position = db.transaction(write).immediate()
      return { position, transactionMs: performance.now() - started, lockWaits }
    } catch (error) {
      if (!isSqliteBusyError(error) || performance.now() >= deadline) throw error
    } finally {
      applySqliteBusyTimeout(db, WRITE_BUSY_TIMEOUT_MS)
    }
    await Bun.sleep(PAGE_LOCK_RETRY_MS)
  }
}

/** The fact whose generation measurement the index folds into its own
 *  session's speed, and into no other session's summary. */
export const GENERATION_FACT_TYPE = "model.stream.summary.recorded"

const SESSION_SUMMARY_FACT_TYPES = [
  ...BUDGET_FACT_TYPES,
  ...SESSION_DURATION_FACT_TYPES,
  ...DIFF_STAT_FACT_TYPES,
  GENERATION_FACT_TYPE,
  "session.created",
  "session.child.linked",
  "session.representation.retired",
] as const

export function sessionSummaryFactTypes(): readonly string[] {
  return [...SESSION_SUMMARY_FACT_TYPES, ...workflowRunOwner().accounting.factTypes]
}

const SESSION_DURATION_TYPE_NAMES: readonly string[] = SESSION_DURATION_FACT_TYPES
const DIFF_STAT_TYPE_NAMES: readonly string[] = DIFF_STAT_FACT_TYPES

interface SessionSummaryErrors {
  readonly budget?: string
  readonly duration?: string
  readonly diffStats?: string
  readonly descendants?: string
  readonly generation?: string
}

interface SessionSummary {
  readonly budget?: BudgetSummary
  readonly duration?: SessionDurationProjectionState
  readonly diffStats?: DiffStatSummary | null
  /** The session's own average generation speed (ARCH-PROTOCOL-042),
   *  absent while no recorded measurement has a duration. */
  readonly averageGenerationTokensPerSecond?: number
  readonly errors: SessionSummaryErrors
}

export interface SessionSummaryRead {
  readonly status: "loading" | "ready"
  readonly throughPosition: number
  readonly summaries: ReadonlyMap<string, SessionSummary>
}

export interface SessionSummaryIndex {
  /** Runs one bounded head probe for each summary fact type plus a source-position capture, reads committed derived state, and starts stale replay without waiting for it. */
  readImmediate(sessionIds: readonly string[]): Promise<SessionSummaryRead>
  /** Joins one bounded replay, then checks the source again. */
  read(sessionIds: readonly string[]): Promise<SessionSummaryRead>
  /** Continues joining owned replays until the index is current or this consumer is cancelled. */
  waitForTotals(sessionIds: readonly string[]): Promise<SessionSummaryRead>
  /** Replays through a primary-log position captured after this call. Calls
   *  made while a replay runs share the one replay that starts after it. */
  replay(): Promise<void>
  /** Stops this consumer. A replay stops after any accepted page commits and
   *  before the next page starts, once every consumer of its index stopped. */
  cancel(): void
  /** Stops this consumer, then releases it after every queued replay settles. */
  dispose(): Promise<void>
}

interface IndexOwner {
  readonly index: ReturnType<typeof createSessionSummaryIndex>
  readonly replays: ReadQueue<void>
  holds: number
  /** The consumers that hold this index and have not stopped. */
  active: number
}

const owners = new Map<string, IndexOwner>()

export function acquireSessionSummaryIndex(
  dbFile: string,
  source: AsyncEventReadSurface,
  options: { readonly shared?: boolean; readonly yieldToNextTask?: () => Promise<void> } = {},
): SessionSummaryIndex {
  const key = resolve(dbFile)
  const yieldToNextTask = options.yieldToNextTask ?? defaultYieldToNextTask
  let owner = options.shared === false ? undefined : owners.get(key)
  if (!owner) {
    const index = createSessionSummaryIndex(key, source, yieldToNextTask)
    const created: IndexOwner = { index, replays: createReadQueue(() => index.replay(() => created.active === 0)), holds: 0, active: 0 }
    owner = created
    if (options.shared !== false) owners.set(key, owner)
  }
  owner.holds++
  owner.active++
  const held = owner
  let cancelled = false
  let disposal: Promise<void> | undefined

  const replay = (): Promise<void> => cancelled ? Promise.resolve() : held.replays.read()
  const cancel = (): void => {
    if (cancelled) return
    cancelled = true
    held.active--
  }

  const read = async (sessionIds: readonly string[]): Promise<SessionSummaryRead> => {
    await replay()
    const freshness = await held.index.freshness()
    if (freshness.stale) {
      void replay().catch(() => {})
      return { status: "loading", throughPosition: freshness.watermark, summaries: new Map() }
    }
    const ready = held.index.readReady(sessionIds)
    if (ready) return ready
    void replay().catch(() => {})
    return { status: "loading", throughPosition: 0, summaries: new Map() }
  }

  return {
    async readImmediate(sessionIds) {
      const freshness = await held.index.freshness()
      if (freshness.stale) {
        void replay().catch(() => {})
        return { status: "loading", throughPosition: freshness.watermark, summaries: new Map() }
      }
      const ready = held.index.readReady(sessionIds)
      if (ready) return ready
      void replay().catch(() => {})
      return { status: "loading", throughPosition: 0, summaries: new Map() }
    },
    read,
    async waitForTotals(sessionIds) {
      let result = await read(sessionIds)
      while (result.status === "loading") {
        if (cancelled) break
        await yieldToNextTask()
        if (cancelled) break
        result = await read(sessionIds)
      }
      return result
    },
    replay,
    cancel,
    dispose() {
      disposal ??= (async () => {
        cancel()
        // Waits for every queued replay. This wait never rejects, because a
        // failed replay already reached the caller that asked for it.
        await held.replays.settled()
        held.holds--
        if (held.holds === 0) {
          if (owners.get(key) === held) owners.delete(key)
          held.index.dispose()
        }
      })()
      return disposal
    },
  }
}

function createSessionSummaryIndex(dbFile: string, source: AsyncEventReadSurface, yieldToNextTask: () => Promise<void>) {
  let writer: Database | undefined
  let reader: Database | undefined
  const timeline = createStartupTimeline({ owner: "session-summary-index", stages: ["open", "sourceHeads", "validatedWatermark", "readPage", "transaction", "yield", "readyRead"], context: { dbFile, pid: String(process.pid) } })
  let initial = true
  const measurement = startReleaseMemorySampler({ role: "session-summary" })
  let measuringRebuild = false
  const finishInitial = (outcome: "ready" | "failed" | "incomplete") => {
    if (!initial) return
    initial = false
    if (measuringRebuild) observeReleaseMemoryPhase("summary.end")
    measurement?.dispose()
    timeline.finish(outcome)
  }

  function open(): Database {
    if (writer) return writer
    const end = initial ? timeline.begin("open") : undefined
    let db: Database | undefined
    try {
      const parent = dirname(dbFile)
      mkdirSync(dirname(parent), { recursive: true })
      ensurePrivateDirectoryUnder(dirname(parent), basename(parent))
      admitPrivateDatabaseFiles(dbFile)
      ensurePrivateFile(dbFile)
      const opened = new Database(dbFile)
      db = opened
      applySqliteDurabilityPragmas(opened, WRITE_BUSY_TIMEOUT_MS)
      opened.transaction(() => initializeSessionSummarySchema(opened)).immediate()
      reader = new Database(dbFile, { readonly: true })
      writer = db
      end?.("ready")
      return db
    } catch (error) {
      end?.("failed")
      db?.close()
      throw error
    }
  }

  async function sourceHeads(): Promise<{ source: number; relevant: number }> {
    const end = initial ? timeline.begin("sourceHeads") : undefined
    try {
      const latestPosition = source.latestPosition
      if (!latestPosition) throw new Error("Session summary source must support descending LIMIT 1 head probes")
      const [sourcePosition, ...heads] = await Promise.all([
        source.capturePosition(),
        ...sessionSummaryFactTypes().map((type) => latestPosition.call(source, type)),
      ])
      end?.("ready", { heads: heads.length + 1 })
      return { source: sourcePosition, relevant: Math.max(0, ...heads) }
    } catch (error) {
      end?.("failed")
      throw error
    }
  }

  async function validatedWatermark(sourcePosition: number): Promise<number> {
    const end = initial ? timeline.begin("validatedWatermark") : undefined
    try {
      const db = open()
      const watermark = readSummaryWatermark(db)
      if (watermark !== undefined && watermark <= sourcePosition) { end?.("ready"); return watermark }
      const reprobed = await source.capturePosition()
      if (watermark !== undefined && watermark <= reprobed) { end?.("ready"); return watermark }
      const result = db.transaction(() => {
        const observed = readSummaryWatermark(db)
        if (observed !== watermark && observed !== undefined) return observed
        rebuildSessionSummarySchema(db)
        return 0
      }).immediate()
      end?.("ready", { rebuilds: 1 })
      return result
    } catch (error) {
      end?.("failed")
      throw error
    }
  }

  async function freshness(): Promise<{ watermark: number; stale: boolean }> {
    const heads = await sourceHeads()
    const watermark = await validatedWatermark(heads.source)
    return { watermark, stale: heads.relevant > watermark }
  }

  async function replay(cancelled: () => boolean): Promise<void> {
    const db = open()
    const heads = await sourceHeads()
    const upper = heads.source
    let position = await validatedWatermark(upper)
    const dispositions = await retiredRepresentations(source, upper)
    const residuals = new Map<string, string>()
    for (const event of dispositions) {
      const fact = parseSessionMetadataFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
      if (fact.type === "session.representation.retired") residuals.set(event.sessionId, fact.payload.aggregateId)
    }
    if (dispositions.some(event => event.position > position)) {
      await commitPage(db, () => { rebuildSessionSummarySchema(db); return 0 })
      position = 0
    }
    if (heads.relevant <= position) return
    if (initial && !measuringRebuild) {
      measuringRebuild = true
      observeReleaseMemoryPhase("summary.begin")
    }
    const local = createReplayLocalSummaries(db)
    while (position < upper && !cancelled()) {
      // Wall time includes the intervals that the OS runs other work on this
      // core. Thread CPU time is the page's own work, which the page bounds.
      const taskStarted = performance.now()
      const taskCpuStarted = process.threadCpuUsage()
      const endRead = initial ? timeline.begin("readPage") : undefined
      let page: Awaited<ReturnType<AsyncEventReadSurface["readPage"]>>
      try {
        page = await source.readPage({ types: sessionSummaryFactTypes() }, upper, position, true)
        endRead?.("ready", { pages: 1, facts: page.facts.length })
      } catch (error) {
        endRead?.("failed")
        throw error
      }
      const next = page.continuationPosition ?? upper
      const expected = position
      const endTransaction = initial ? timeline.begin("transaction") : undefined
      let committed: Awaited<ReturnType<typeof commitPage>>
      try {
        let folded = false
        committed = await commitPage(db, () => {
          local.beginPage()
          const current = readSummaryWatermark(db)
          if (current !== expected) return current ?? 0
          for (const event of page.facts) foldSummaryEvent(db, local, event, residuals)
          if (!updateSummaryWatermark(db, expected, next)) return readSummaryWatermark(db) ?? 0
          folded = true
          return next
        })
        if (folded) local.keepPage()
        else local.forget()
        endTransaction?.("ready", { pages: 1, facts: page.facts.length })
      } catch (error) {
        endTransaction?.("failed")
        throw error
      }
      position = committed.position
      if (initial) observeReleaseMemoryPhase("summary.page")
      const taskCpu = process.threadCpuUsage(taskCpuStarted)
      DebugLog.record({
        type: "session.summary.page",
        payload: {
          facts: page.facts.length,
          fromPosition: expected,
          throughPosition: position,
          transactionMs: committed.transactionMs,
          lockWaits: committed.lockWaits,
          taskOccupancyMs: performance.now() - taskStarted,
          taskCpuMs: (taskCpu.user + taskCpu.system) / 1000,
        },
      })
      if (cancelled() || position >= upper) break
      const endYield = initial ? timeline.begin("yield") : undefined
      try {
        await yieldToNextTask()
        endYield?.("ready", { yields: 1 })
      } catch (error) {
        endYield?.("failed")
        throw error
      }
    }
    if (cancelled() && position < upper) finishInitial("incomplete")
  }

  function readReady(sessionIds: readonly string[]): SessionSummaryRead | undefined {
    open()
    if (!reader) throw new Error("Session summary reader did not open")
    const readDb = reader
    const end = initial ? timeline.begin("readyRead") : undefined
    try {
      const result = readDb.transaction(() => {
        const throughPosition = readSummaryWatermark(readDb)
        if (throughPosition === undefined) throw new DerivedCacheCorruption("invalid summary watermark")
        const summaries = new Map<string, SessionSummary>()
        for (const sessionId of sessionIds) {
          const local = readStoredSessionSummary(readDb, sessionId) ?? emptyStoredSummary()
          const errors = readSummaryErrors(readDb, sessionId)
          const speed = errors.generation === undefined ? tokensPerSecond(local.generation.outputTokens, local.generation.durationMs) : null
          summaries.set(sessionId, {
            ...(errors.budget === undefined && errors.descendants === undefined
              ? { budget: budgetSummaryFromState(local.budget, readDescendantUsage(readDb, sessionId)) }
              : {}),
            ...(errors.duration === undefined ? { duration: local.duration } : {}),
            ...(errors.diffStats === undefined ? { diffStats: local.diffStats } : {}),
            ...(speed === null ? {} : { averageGenerationTokensPerSecond: speed }),
            errors,
          })
        }
        return { status: "ready" as const, throughPosition, summaries }
      })()
      end?.("ready", { sessions: sessionIds.length })
      finishInitial("ready")
      return result
    } catch (error) {
      end?.("failed")
      if (!isDerivedCacheCorruption(error)) throw error
      const db = open()
      db.transaction(() => rebuildSessionSummarySchema(db)).immediate()
      return undefined
    }
  }

  return {
    replay,
    freshness,
    readReady,
    dispose() {
      finishInitial("incomplete")
      reader?.close()
      writer?.close()
    },
  }
}

async function retiredRepresentations(source: AsyncEventReadSurface, upper: number): Promise<StoredFact[]> {
  const facts: StoredFact[] = []
  let position = 0
  while (position < upper) {
    const page = await source.readPage({ types: ["session.representation.retired"] }, upper, position, true, "deferred")
    for (const fact of page.facts) {
      if (fact instanceof CorruptEventRowError) {
        // oxlint-disable-next-line eslint/no-throw-literal -- boundary: preserve the narrowed durable-row error and its evidence.
        if (fact.row.type === "session.representation.retired") throw fact
      } else if (fact.type === "session.representation.retired") facts.push(fact)
    }
    if (page.continuationPosition === null) break
    position = page.continuationPosition
  }
  return facts
}

/** A retired workflow representation keeps its historical accounting
 *  ancestry under its residual aggregate: its launch edge, its links, and
 *  the launch edges of children that no member conversation adopted all name
 *  the aggregate, so the launching chat counts that whole subtree once. */
function foldSummaryEvent(db: Database, local: ReplayLocalSummaries, storedEvent: StoredFact | CorruptEventRowError, residuals: ReadonlyMap<string, string>): void {
  if ((storedEvent instanceof CorruptEventRowError ? storedEvent.row.type : storedEvent.type) === GENERATION_FACT_TYPE) {
    foldGeneration(db, local, storedEvent)
    return
  }
  let event = storedEvent
  const residual = residuals.get(event.sessionId)
  if (residual) {
    const type = event instanceof CorruptEventRowError ? event.row.type : event.type
    if (type.startsWith("session.") && type !== "session.created" && type !== "session.child.linked") return
    event = event instanceof CorruptEventRowError
      ? new CorruptEventRowError({ ...event.row, sessionId: residual }, event.message)
      : { ...event, sessionId: residual }
  }
  if (event instanceof CorruptEventRowError) {
    const scope = scopeOf(event.row.type)
    if (scope === "descendants") {
      markDescendantsUnknown(db, event.sessionId, event.message)
      return
    }
    putSummaryError(db, event.sessionId, scope, event.message)
    if (scope === "budget") propagateDescendantError(db, event.sessionId, event.message)
    return
  }
  const ancestry = workflowRunOwner().accounting.ancestry(event)
  if (ancestry) {
    // A converted run's aggregate can already hold its historical launch edge.
    if (putSessionSummaryKind(db, ancestry.owner, "aggregate").becameEligible) propagateEligibleChild(db, ancestry.owner)
    if (putSessionSummaryEdge(db, ancestry.parent, ancestry.owner)) propagateEligibleChild(db, ancestry.owner, ancestry.parent)
    return
  }
  if (!residual && !event.aggregateId.startsWith("session:")) event = { ...event, sessionId: event.aggregateId }
  const owner = (sessionId: string) => residuals.get(sessionId) ?? sessionId
  if (event.type === "session.created") {
    foldCreated(db, event, owner, residual !== undefined)
    return
  }
  if (event.type === "session.representation.retired") return
  if (event.type === "session.child.linked") {
    foldChildLink(db, event, owner)
    return
  }
  if (event.type === "model.usage.measured" && (event.version === 4 || event.version === 5 || event.version === 6)) {
    foldSemanticUsage(db, local, event)
    return
  }

  const scope = scopeOf(event.type)
  if (hasSummaryError(db, event.sessionId, scope)) return
  const current = local.read(event.sessionId) ?? emptyStoredSummary()
  try {
    if (scope === "budget") {
      const budget = reduceBudgetEvent(current.budget, event)
      local.write(event.sessionId, { ...current, budget })
      // A cumulative reading or a terminal reconciliation adds to the local
      // total; the same delta is this session's direct usage, so its
      // ancestors count exactly what its own summary shows.
      const usage = usageAdded(current.budget, budget)
      if (usage) {
        addDirectUsage(db, event.sessionId, usage)
        propagateUsageToAncestors(db, event.sessionId, usage)
      }
    } else if (scope === "duration") {
      local.write(event.sessionId, { ...current, duration: reduceSessionDurationEvent(current.duration, event) })
    } else if (scope === "diffStats") {
      local.write(event.sessionId, { ...current, diffStats: foldDiffStatEvent(current.diffStats, event) })
    }
  } catch (error) {
    const reason = errorMessage(error)
    putSummaryError(db, event.sessionId, scope, reason)
    if (scope === "budget") propagateDescendantError(db, event.sessionId, reason)
  }
}

/** Adds one recorded generation measurement to the speed of the session
 *  whose own aggregate holds it. A speed is an own-agent value, so it never
 *  follows the residual or aggregate remaps that place usage in ancestry. */
function foldGeneration(db: Database, local: ReplayLocalSummaries, event: StoredFact | CorruptEventRowError): void {
  const aggregateId = event instanceof CorruptEventRowError ? event.row.aggregateId : event.aggregateId
  if (!aggregateId.startsWith("session:")) return
  const sessionId = aggregateId.slice("session:".length)
  if (event instanceof CorruptEventRowError) {
    putSummaryError(db, sessionId, "generation", event.message)
    return
  }
  if (hasSummaryError(db, sessionId, "generation")) return
  try {
    const { generation } = readStreamSummaryGeneration(event)
    if (generation.kind !== "recorded") return
    const current = local.read(sessionId) ?? emptyStoredSummary()
    local.write(sessionId, { ...current, generation: {
      outputTokens: current.generation.outputTokens + generation.outputTokens,
      durationMs: current.generation.durationMs + generation.durationMs,
    } })
  } catch (error) {
    putSummaryError(db, sessionId, "generation", errorMessage(error))
  }
}

function foldSemanticUsage(db: Database, local: ReplayLocalSummaries, event: StoredFact): void {
  try {
    const fact = parseSessionRuntimeFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
    if (fact.type !== "model.usage.measured" || (fact.version !== 4 && fact.version !== 5 && fact.version !== 6)) return
    const semanticId = fact.version === 4 ? fact.payload.usageEntryId : fact.payload.attemptId
    if (!insertSemanticUsage(db, event.sessionId, semanticId)) return
    const empty = initialBudgetProjectionState()
    const leaf = usageAdded(empty, reduceBudgetFact(empty, fact))
    if (!hasSummaryError(db, event.sessionId, "budget")) {
      const current = local.read(event.sessionId) ?? emptyStoredSummary()
      local.write(event.sessionId, { ...current, budget: reduceBudgetFact(current.budget, fact) })
    }
    // A descendants error makes this session's subtree unknown, and every
    // ancestor already carries it. This session's own requests stay known, so
    // they still count: a later ancestry recompute sums these direct rows.
    if (leaf) {
      addDirectUsage(db, event.sessionId, leaf)
      propagateUsageToAncestors(db, event.sessionId, leaf)
    }
  } catch (error) {
    const reason = errorMessage(error)
    putSummaryError(db, event.sessionId, "budget", reason)
    markDescendantsUnknown(db, event.sessionId, reason)
  }
}

/** The usage that one budget fold step added, or undefined when it added none. */
function usageAdded(before: BudgetProjectionState, after: BudgetProjectionState): UsageTotals | undefined {
  const usage: UsageTotals = {
    totalCost: after.totalCost - before.totalCost,
    totalBilledCost: after.totalBilledCost - before.totalBilledCost,
    priceUnavailable: after.priceUnavailable && !before.priceUnavailable,
    totalInputTokens: after.totalInputTokens - before.totalInputTokens,
    totalOutputTokens: after.totalOutputTokens - before.totalOutputTokens,
  }
  const added = usage.priceUnavailable || usage.totalCost !== 0 || usage.totalBilledCost !== 0 || usage.totalInputTokens !== 0 || usage.totalOutputTokens !== 0
  return added ? usage : undefined
}

/** The creation of a retired representation contributes only its launch
 *  edge. Its aggregate's kind comes from the run registration. */
function foldCreated(db: Database, event: StoredFact, owner: (sessionId: string) => string, retired: boolean): void {
  try {
    const fact = decodeSessionMetadataFactForReplay(
      { type: event.type, version: event.version, actor: event.actor, payload: event.payload },
      event.timestamp,
    )
    if (!fact || fact.type !== "session.created") throw new Error(`unreadable session creation fact ${event.id}`)
    if (!retired && putSessionSummaryKind(db, event.sessionId, fact.payload.kind).becameEligible) propagateEligibleChild(db, event.sessionId)
    const launchParent = fact.payload.launchedFrom?.parentSessionId
    const parentId = launchParent && owner(launchParent)
    if (parentId && putSessionSummaryEdge(db, parentId, event.sessionId)) propagateEligibleChild(db, event.sessionId, parentId)
  } catch (error) {
    markDescendantsUnknown(db, event.sessionId, errorMessage(error))
  }
}

/** Folds one parent-to-child edge. Ownership adoption needs no fold of its
 *  own: every producer appends the adopter's link in the same batch. */
function foldChildLink(db: Database, event: StoredFact, owner: (sessionId: string) => string): void {
  try {
    const fact = parseSessionMetadataFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
    if (fact.type !== "session.child.linked") return
    const childId = owner(fact.payload.childSessionId)
    if (putSessionSummaryEdge(db, event.sessionId, childId)) propagateEligibleChild(db, childId, event.sessionId)
  } catch (error) {
    markDescendantsUnknown(db, event.sessionId, errorMessage(error))
  }
}

/** Records that a session's descendant set is unknown. Every ancestor that
 *  counts this session then carries the error too, so no ancestor presents a
 *  partial total as complete. */
function markDescendantsUnknown(db: Database, sessionId: string, reason: string): void {
  putSummaryError(db, sessionId, "descendants", reason)
  propagateDescendantError(db, sessionId, reason)
}

class DerivedCacheCorruption extends Error {}

function isDerivedCacheCorruption(error: unknown): boolean {
  if (error instanceof DerivedCacheCorruption || error instanceof SyntaxError) return true
  if (!(error instanceof Error)) return false
  if (error.name === "ParseError") return true
  return /database disk image is malformed|database corruption|malformed database schema/i.test(error.message)
}

function emptyStoredSummary(): StoredSessionSummary {
  return {
    budget: initialBudgetProjectionState(),
    duration: { accumulatedActiveMs: 0 },
    diffStats: null,
    generation: { outputTokens: 0, durationMs: 0 },
  }
}

function scopeOf(type: string): SessionSummaryScope {
  if (SESSION_DURATION_TYPE_NAMES.includes(type)) return "duration"
  if (DIFF_STAT_TYPE_NAMES.includes(type)) return "diffStats"
  if (type === "session.created" || type === "session.child.linked") return "descendants"
  return "budget"
}
