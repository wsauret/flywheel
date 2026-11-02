import type { SessionCatalogRow } from "../app-service-types.js"
import type { BudgetView } from "../budget-protocol-types.js"

/** How every client folds a fresh reading of a session's aggregate totals
 *  over the one it holds (PI-INTERACTION-006).
 *
 *  A fresh reading is a complete replacement, with one exception: a loading
 *  reading never erases totals the client already knows. A runtime answers
 *  loading only while it has not yet read a session's totals, such as a
 *  runtime that has just started when a client reattaches to it after a
 *  planned replacement. The totals it reads next replace the kept ones, and
 *  totals never go back, so the kept ones are the last known values, not a
 *  partial value shown as final. A surface marks totals as loading only
 *  while no total was ever known for the session. The terminal, the web
 *  client, and the runtime's own catalog all fold through these two
 *  functions, so no surface disagrees about which totals are current. */

type ReadyCatalogRow = Extract<SessionCatalogRow, { readonly totalsLoading: false }>

/** The incoming catalog row: its metadata always, and its totals unless it
 *  is loading and `prior` knew them. */
export function mergeCatalogRow(prior: SessionCatalogRow | undefined, next: SessionCatalogRow): SessionCatalogRow {
  if (!next.totalsLoading || prior === undefined || prior.totalsLoading) return next
  return { ...next, ...knownCatalogTotals(prior) }
}

/** The incoming budget, unless it is loading and `prior` knew one. */
export function mergeBudgetView(prior: BudgetView | undefined, next: BudgetView): BudgetView {
  return next.totalsLoading && prior !== undefined && !prior.totalsLoading ? prior : next
}

function knownCatalogTotals(row: ReadyCatalogRow): Pick<ReadyCatalogRow, "totalsLoading" | "totalCost" | "totalBilledCost" | "priceUnavailable" | "totalTokens" | "contextPercent" | "contextPromptTokens" | "durationMs" | "diffStats"> {
  return {
    totalsLoading: false,
    totalCost: row.totalCost,
    totalBilledCost: row.totalBilledCost,
    priceUnavailable: row.priceUnavailable,
    totalTokens: row.totalTokens,
    contextPercent: row.contextPercent,
    contextPromptTokens: row.contextPromptTokens,
    durationMs: row.durationMs,
    ...(row.diffStats === undefined ? {} : { diffStats: row.diffStats }),
  }
}
