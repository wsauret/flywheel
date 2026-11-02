import type { SessionStore } from "../session-store/types.js"
import { budgetCursor, type BudgetView } from "../../protocol/budget-protocol-types.js"
import { createSessionViewProjection } from "./session-view-projection.js"
import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import { budgetViewFromRuntimeSummary, type RuntimeSummaryProjection } from "./runtime-summary-projection.js"
import { Log } from "../../infra/log.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"

export interface BudgetProtocolProjection {
  snapshot(sessionId: string): Promise<BudgetView | null>
  dispose(): void
}

export interface BudgetProtocolProjectionDeps {
  readonly sessionStore: SessionStore
  readonly summaries: RuntimeSummaryProjection
  readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch
}

/** The budget of a session is its stored totals, which the summary index
 *  reads from durable history. A runner does not own them, so a session
 *  whose runner leaves, such as a child that a person stopped or
 *  interrupted, keeps its budget and its later summaries, and its viewer
 *  keeps the totals, the speed, and the context reading. */
const NO_ENTRY_INPUTS: readonly unknown[] = []

export function createBudgetProtocolProjection(deps: BudgetProtocolProjectionDeps): BudgetProtocolProjection {
  const log = Log.create({ service: "budget-protocol" })
  let disposed = false
  // The sessions whose runner left after this projection published their
  // budget. A later summary of one of them publishes again.
  const withoutRunner = new Set<string>()
  const view = (sessionId: string): BudgetView => budgetViewFromRuntimeSummary(deps.summaries.view(sessionId))

  const projection = createSessionViewProjection<BudgetView>({
    sessionStore: deps.sessionStore,
    publish: deps.publish,
    label: "budget-protocol",
    cursor: budgetCursor,
    payloads: {
      updated: (budget) => ({ kind: "budget.updated", budget }),
      removed: () => ({ kind: "budget.removed" }),
    },
    view(sessionId) {
      withoutRunner.delete(sessionId)
      return view(sessionId)
    },
    // A budget reads the summary index, never its entry: an entry's arrival
    // and departure derive it, and a new summary publishes it below.
    inputs: () => NO_ENTRY_INPUTS,
    departed(sessionId) {
      withoutRunner.add(sessionId)
      return view(sessionId)
    },
    same: sameBudget,
  })
  const unsubscribe = deps.summaries.subscribe((sessionIds) => {
    for (const sessionId of sessionIds) {
      void projection.run(sessionId, async () => {
        if (deps.sessionStore.get(sessionId) || withoutRunner.has(sessionId)) projection.set(sessionId, view(sessionId))
      }).catch((error: unknown) => { recordBackgroundFailure(log, "summary refresh", {}, error) })
    }
  })
  return {
    async snapshot(sessionId) {
      void deps.summaries.admit([sessionId])
      return projection.run(sessionId, async () => {
        const entry = deps.sessionStore.get(sessionId)
        if (disposed || !entry) return null
        const budget = view(sessionId)
        projection.prime(sessionId, budget)
        return budget
      })
    },
    dispose() {
      unsubscribe()
      disposed = true
      withoutRunner.clear()
      projection.dispose()
    },
  }
}

function sameBudget(a: BudgetView, b: BudgetView): boolean {
  if (a.totalsLoading || b.totalsLoading) return a.totalsLoading === b.totalsLoading
  return a.tokens === b.tokens
    && a.cost === b.cost
    && a.billedCost === b.billedCost
    && a.priceUnavailable === b.priceUnavailable
    && a.contextPercent === b.contextPercent
    && a.contextPromptTokens === b.contextPromptTokens
    && a.averageGenerationTokensPerSecond === b.averageGenerationTokensPerSecond
}
