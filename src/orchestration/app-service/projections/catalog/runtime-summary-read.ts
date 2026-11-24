import type { SessionRow } from "../../../../protocol/app-service-types.js"
import type { BudgetView } from "../../../../protocol/budget-protocol-types.js"
import type { RuntimeBackgroundSummaryResult } from "../../../../protocol/runtime-protocol-schemas.js"

// The summary read contract: the background reads that state session totals,
// and the views that one read states. The summary projection consumes it and
// the background lane serves it, so neither depends on the other.

/** The background reads that state session totals. */
export interface RuntimeSummarySource {
  sessionSummaryImmediate(sessionIds: readonly string[]): Promise<RuntimeBackgroundSummaryResult>
  waitForTotals(sessionIds: readonly string[]): Promise<RuntimeBackgroundSummaryResult>
}

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
export function readySummaryView(result: RuntimeBackgroundSummaryResult, row: ReadySessionRow): RuntimeSummaryView {
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
