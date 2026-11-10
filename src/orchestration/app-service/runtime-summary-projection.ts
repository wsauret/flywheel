import { errorDetail, errorMessage } from "../../infra/error-message.js"
import type { StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { createStartupTimeline } from "../../infra/startup-timeline.js"
import type { SessionCatalogError, SessionRow } from "../../protocol/app-service-types.js"
import type { BudgetView } from "../../protocol/budget-protocol-types.js"
import type { RuntimeBackgroundSummaryResult } from "../../protocol/runtime-protocol-schemas.js"
import type { SessionPlacements } from "../session/session-metadata-store.js"
import { GENERATION_FACT_TYPE, sessionSummaryFactTypes } from "../session/session-summary-index.js"
import { isLaunchedDescendantKind } from "../session/session-summary-index-sql.js"
import type { RuntimeBackgroundLane } from "./runtime-background-lane.js"
import type { WorkflowPlacements } from "../module-seams.js"
import { workflowAggregateId } from "../../workflows/vm/session-facts.js"

type ReadySessionRow = Extract<SessionRow, { readonly totalsLoading: false }>

/** A session's totals as one reading states them: loading, or ready with
 *  the session's own average generation speed (ARCH-PROTOCOL-042) when a
 *  measurement exists. */
type SummaryTotals<Row> =
  | { readonly totalsLoading: true }
  | { readonly totalsLoading: false; readonly row: Row; readonly averageGenerationTokensPerSecond?: number }

export type RuntimeSummaryView = SummaryTotals<ReadySessionRow>

/** The budget that a session's totals state. Every owner that publishes or
 *  answers a budget builds it here. */
export function budgetViewFromRuntimeSummary(summary: SummaryTotals<Pick<ReadySessionRow, "totalTokens" | "totalCost" | "totalBilledCost" | "priceUnavailable" | "contextPercent" | "contextPromptTokens" | "compactionTriggerTokens">>): BudgetView {
  if (summary.totalsLoading) return { totalsLoading: true }
  return {
    totalsLoading: false,
    tokens: summary.row.totalTokens,
    cost: summary.row.totalCost,
    billedCost: summary.row.totalBilledCost,
    priceUnavailable: summary.row.priceUnavailable,
    contextPercent: summary.row.contextPercent,
    contextPromptTokens: summary.row.contextPromptTokens,
    ...(summary.row.compactionTriggerTokens === undefined ? {} : { compactionTriggerTokens: summary.row.compactionTriggerTokens }),
    ...(summary.averageGenerationTokensPerSecond === undefined ? {} : { averageGenerationTokensPerSecond: summary.averageGenerationTokensPerSecond }),
  }
}

/** The summary one background read states for a ready row. */
function readySummaryView(result: RuntimeBackgroundSummaryResult, row: ReadySessionRow): RuntimeSummaryView {
  const speed = result.generationSpeeds[row.id]
  return { totalsLoading: false, row, ...(speed === undefined ? {} : { averageGenerationTokensPerSecond: speed }) }
}

/** The budget of each requested session that one background summary read
 *  states, as a detail read states it: none for a session the read does not
 *  list, loading while the index replays, and none for a ready read that
 *  withholds a row's totals, whose summary errors say why. */
export function budgetViewsFromSummary(result: RuntimeBackgroundSummaryResult, sessionIds: readonly string[]): { readonly sessionId: string; readonly view: BudgetView | null }[] {
  const rows = new Map(result.rows.map((row) => [row.id, row] as const))
  return sessionIds.map((sessionId) => {
    const row = rows.get(sessionId)
    if (!row) return { sessionId, view: null }
    if (result.totalsLoading) return { sessionId, view: { totalsLoading: true } }
    return { sessionId, view: row.totalsLoading ? null : budgetViewFromRuntimeSummary(readySummaryView(result, row)) }
  })
}

/** The catalog error families a summary read states. Each complete summary
 *  replaces them for its session; metadata and workflow errors stay with the
 *  targeted metadata read. */
export const SUMMARY_ERROR_SCOPES: ReadonlySet<SessionCatalogError["scope"]> = new Set(["budget", "duration", "diffStats", "fork"])

export interface RuntimeSummaryProjection {
  /** Admits held summaries through the bounded source-head read. Replay, when
   * needed, continues on the owned background lane after this promise settles.
   * It never rejects, so a caller can start an admission without awaiting it.
   * A read that fails, or that the owner's shutdown interrupts, keeps the held
   * views: the reader records why, and the next admission retries. A
   * subscriber that throws is recorded here and does not stop the others. */
  admit(sessionIds: readonly string[]): Promise<void>
  /** Returns the last complete summary while refresh runs, or loading when no
   * complete summary has arrived. Does not wait for the background index. */
  view(sessionId: string): RuntimeSummaryView
  /** Subscribes to complete replacements and immediately reports summaries
   * already ready, so deferred consumers cannot miss settlement. */
  subscribe(listener: (sessionIds: readonly string[]) => void): () => void
  /** Joins only the process-local refresh task. Foreground product paths never use this. */
  settled(): Promise<void>
  dispose(): void
}

export interface RuntimeSummaryProjectionDeps {
  /** Where workflows sit in the tree: usage on a workflow aggregate counts in its parent. */
  readonly workflowPlacements?: WorkflowPlacements
  readonly context?: { readonly projectRoot: string }
  readonly background: Pick<RuntimeBackgroundLane, "sessionSummaryImmediate" | "waitForTotals">
  /** Where sessions sit in the tree: usage in a counted descendant counts in its ancestors. */
  readonly sessionPlacements: SessionPlacements
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
}

const log = Log.create({ service: "runtime-summary" })

/** Coordinates the shared summary index for foreground views. This projection
 * owns only held process-local replacements. It has no timer or durable state. */
export function createRuntimeSummaryProjection(deps: RuntimeSummaryProjectionDeps): RuntimeSummaryProjection & {
  /** The catalog owner's view of summary-owned errors: those of the last
   *  complete summary, empty while none has arrived. */
  errors(sessionId: string): readonly SessionCatalogError[]
  /** Resolves once the held summaries of these sessions state every fact that
   *  was stored before the call, and their subscribers have heard them. It
   *  joins the one refresh task and waits through a replay, so only an owner
   *  that reports settled totals uses it; a view that must answer at once
   *  reads `view`. When the last read of a session fails, it rejects with
   *  that read's error, and the held summaries stay as they were. */
  current(sessionIds: readonly string[]): Promise<void>
} {
  const relevantFactTypes: ReadonlySet<string> = new Set(sessionSummaryFactTypes())
  const held = new Map<string, RuntimeSummaryView>()
  const heldErrors = new Map<string, readonly SessionCatalogError[]>()
  const listeners = new Set<(sessionIds: readonly string[]) => void>()
  const pending = new Set<string>()
  const active = new Set<string>()
  let refresh: Promise<void> | undefined
  // The error of each session's last refresh, while that refresh failed.
  // Only `current` reports it; every other reader keeps the held summaries.
  const refreshFailures = new Map<string, unknown>()
  let disposed = false
  const timeline = createStartupTimeline({ owner: "runtime-summary-hydration", stages: ["immediateRead", "totalsWait", "publication"], context: { ...deps.context, pid: String(process.pid) } })
  let initial: { requested: Set<string>; ready: Set<string>; failures: number; requests: number; superseded: number } | undefined
  let initialFinished = false
  const complete = (outcome: "ready" | "incomplete" | "failed") => {
    if (!initial) return
    const end = timeline.begin("publication")
    end(outcome, { requested: initial.requested.size, ready: initial.ready.size, loading: initial.requested.size - initial.ready.size, requests: initial.requests, superseded: initial.superseded, failures: initial.failures })
    timeline.finish(outcome)
    initial = undefined
    initialFinished = true
  }

  const finishInitial = (): void => {
    if (!initial || initial.ready.size !== initial.requested.size) return
    complete("ready")
  }

  const publish = (sessionIds: readonly string[]): void => {
    if (disposed || sessionIds.length === 0) return
    for (const listener of listeners) {
      try {
        listener(sessionIds)
      } catch (error) {
        // A subscriber is a consumer's defect, not a failed summary: the
        // replacement is already held and the other subscribers still hear it.
        log.error("runtime summary subscriber failed", { sessions: sessionIds.length, error: errorMessage(error), errorDetail: errorDetail(error) })
      }
    }
  }

  const apply = (result: RuntimeBackgroundSummaryResult, requested: readonly string[]): void => {
    const rows = new Map(result.rows.map((row) => [row.id, row] as const))
    const changed: string[] = []
    for (const sessionId of requested) {
      // A commit received after this read started owns the next replacement.
      // Keep the held state instead of briefly publishing this older result.
      if (!held.has(sessionId) || pending.has(sessionId)) {
        if (initial?.requested.has(sessionId)) initial.superseded++
        continue
      }
      const row = rows.get(sessionId)
      if (!row || row.totalsLoading) continue
      const next = readySummaryView(result, row)
      const errors = result.errors.filter((error) => error.sessionId === sessionId && SUMMARY_ERROR_SCOPES.has(error.scope))
      if (JSON.stringify([held.get(sessionId), heldErrors.get(sessionId) ?? []]) === JSON.stringify([next, errors])) continue
      held.set(sessionId, next)
      heldErrors.set(sessionId, errors)
      changed.push(sessionId)
      if (initial?.requested.has(sessionId)) initial.ready.add(sessionId)
    }
    const endPublication = initial ? timeline.begin("publication") : undefined
    publish(changed)
    endPublication?.("ready", { published: changed.length })
    finishInitial()
  }

  const requestRefresh = (sessionIds: readonly string[], force = false, settleKnownLoading = false): Promise<void> => {
    if (disposed) return Promise.resolve()
    if (initial) initial.requests++
    for (const sessionId of sessionIds) {
      if (held.has(sessionId) && (force || !active.has(sessionId))) pending.add(sessionId)
    }
    if (refresh || pending.size === 0) return refresh ?? Promise.resolve()
    let requested: readonly string[] = []
    refresh = Promise.resolve().then(async () => {
      requested = [...pending]
      pending.clear()
      for (const sessionId of requested) active.add(sessionId)
      if (!settleKnownLoading) {
        const end = initial ? timeline.begin("immediateRead") : undefined
        let immediate: RuntimeBackgroundSummaryResult
        try {
          immediate = await deps.background.sessionSummaryImmediate(requested)
          end?.("ready", { sessions: requested.length })
        } catch (error) {
          end?.("failed", { sessions: requested.length })
          throw error
        }
        apply(immediate, requested)
        if (!immediate.totalsLoading) return
      }
      const end = initial ? timeline.begin("totalsWait") : undefined
      let result: RuntimeBackgroundSummaryResult
      try {
        result = await deps.background.waitForTotals(requested)
        end?.("ready", { sessions: requested.length })
      } catch (error) {
        end?.("failed", { sessions: requested.length })
        throw error
      }
      apply(result, requested)
    }).then(() => {
      for (const sessionId of requested) refreshFailures.delete(sessionId)
    }, (error: unknown) => {
      // Preserve the last complete totals, or initial loading. Admission retries.
      for (const sessionId of requested) refreshFailures.set(sessionId, error)
      if (initial) initial.failures++
    }).finally(() => {
      active.clear()
      refresh = undefined
      if (pending.size > 0) void requestRefresh([...pending])
    })
    return refresh
  }

  const unsubscribeStored = deps.onStored((events) => {
    deps.sessionPlacements.observe(events)
    deps.workflowPlacements?.observe(events)
    const changed = events.filter((event) => relevantFactTypes.has(event.type))
    if (changed.length === 0) return
    void (async () => {
      // A counted child's usage changes every live ancestor's totals, through
      // workflow and subagent intermediates alike. A fork is a chat, so the
      // walk stops there, as the summary index's ancestry does. An ancestor
      // already walked has its own walk, which also ends a cycle.
      const affected = new Set<string>()
      const walked = new Set<string>()
      for (const event of changed) {
        // A generation speed belongs to the agent whose own aggregate holds
        // the stream summary, so the summary changes no other session.
        if (event.type === GENERATION_FACT_TYPE) {
          if (event.aggregateId.startsWith("session:")) affected.add(event.sessionId)
          continue
        }
        const sessionId = event.aggregateId.startsWith("session:") ? event.sessionId
          : event.aggregateId === workflowAggregateId(event.sessionId) ? await deps.workflowPlacements?.parent(event.sessionId)
          : undefined
        if (sessionId === undefined || walked.has(sessionId)) continue
        affected.add(sessionId)
        walked.add(sessionId)
        let session = await deps.sessionPlacements.placement(sessionId)
        while (session && isLaunchedDescendantKind(session.kind)) {
          const parentSessionId = session.launchedFrom?.parentSessionId
          if (parentSessionId === undefined || walked.has(parentSessionId)) break
          affected.add(parentSessionId)
          walked.add(parentSessionId)
          session = await deps.sessionPlacements.placement(parentSessionId)
        }
      }
      const heldAffected = [...affected].filter((sessionId) => held.has(sessionId))
      void requestRefresh(heldAffected, true)
    })().catch(() => {
      // Preserve held totals. The next admission retries.
    })
  })

  const settled = async (): Promise<void> => {
    for (;;) {
      const current = refresh
      if (!current) return
      await current
    }
  }

  return {
    async admit(sessionIds) {
      if (!initial && !initialFinished) {
        initial = { requested: new Set(sessionIds), ready: new Set(), failures: 0, requests: 0, superseded: 0 }
      }
      for (const sessionId of sessionIds) {
        if (!held.has(sessionId)) held.set(sessionId, { totalsLoading: true })
      }
      const end = initial ? timeline.begin("immediateRead") : undefined
      let immediate: RuntimeBackgroundSummaryResult
      try {
        immediate = await deps.background.sessionSummaryImmediate(sessionIds)
        end?.("ready", { sessions: sessionIds.length })
      } catch {
        // Preserve the last complete totals, or initial loading. The reader
        // recorded the failure; the next admission retries.
        end?.("failed", { sessions: sessionIds.length })
        if (initial) initial.failures++
        return
      }
      apply(immediate, sessionIds)
      if (immediate.totalsLoading) {
        for (const sessionId of sessionIds) pending.add(sessionId)
        void requestRefresh(sessionIds, false, true)
      }
    },
    async current(sessionIds) {
      for (const sessionId of sessionIds) {
        if (!held.has(sessionId)) held.set(sessionId, { totalsLoading: true })
      }
      void requestRefresh(sessionIds, true)
      // A refresh already in flight can have read before the last stored
      // fact; the one it queues behind itself reads after this call.
      await settled()
      for (const sessionId of sessionIds) {
        if (refreshFailures.has(sessionId)) throw refreshFailures.get(sessionId)
      }
    },
    view(sessionId) {
      let current = held.get(sessionId)
      if (!current) {
        current = { totalsLoading: true }
        held.set(sessionId, current)
      }
      return current
    },
    errors(sessionId) {
      return heldErrors.get(sessionId) ?? []
    },
    subscribe(listener) {
      listeners.add(listener)
      const ready = [...held].flatMap(([sessionId, summary]) => summary.totalsLoading ? [] : [sessionId])
      if (ready.length > 0) listener(ready)
      return () => { listeners.delete(listener) }
    },
    settled,
    dispose() {
      if (initial) complete("incomplete")
      else timeline.finish(initialFinished ? "ready" : "incomplete")
      disposed = true
      unsubscribeStored()
      listeners.clear()
      pending.clear()
      active.clear()
      held.clear()
      heldErrors.clear()
      refreshFailures.clear()
    },
  }
}
