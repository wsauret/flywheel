import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { budgetCursor, isBudgetPayload, type BudgetView } from "../../protocol/budget-protocol-types.js"
import { mergeBudgetView } from "../../protocol/client/known-totals.js"
import { createPerSessionCache, type PerSessionCache } from "./create-per-session-cache.js"

export type BudgetCache = PerSessionCache<BudgetView>

export function createBudgetCache(deps: { appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> }): BudgetCache {
  return createPerSessionCache({
    domain: "budget",
    cursor: budgetCursor,
    client: deps.appService,
    query: (sessionIds) => deps.appService.query({ type: "budgetSnapshot", sessionIds }),
    isPayload: isBudgetPayload,
    payloadView: (payload) => (payload.kind === "budget.updated" ? payload.budget : null),
    settle: mergeBudgetView,
  })
}
