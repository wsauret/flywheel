import type { RuntimeSessionCursorIdentity, RuntimeSessionViewsResult, RuntimeUiPatchPayload } from "./runtime-ui-protocol-types.js"

export type BudgetView =
  | {
    readonly totalsLoading: true
    readonly tokens?: never
    readonly cost?: never
    readonly billedCost?: never
    readonly priceUnavailable?: never
    readonly contextPercent?: never
    readonly contextPromptTokens?: never
    readonly compactionTriggerTokens?: never
    readonly averageGenerationTokensPerSecond?: never
  }
  | {
    readonly totalsLoading: false
    readonly tokens: number
    readonly cost: number
    /** Metered (API-key) portion of `cost`; the remainder is
     *  subscription-covered API-equivalent value. */
    readonly billedCost: number
    readonly priceUnavailable: boolean
    readonly contextPercent: number
    readonly contextPromptTokens: number
    /** The context size at which the runtime runs the session's next
     *  automatic compaction: 0 when none can run. Absent when the session's
     *  history states none, or from a runtime older than this field; a client
     *  then reads the configured count. */
    readonly compactionTriggerTokens?: number
    /** Own-agent pooled output speed in common local comparison tokens. */
    readonly averageGenerationTokensPerSecond?: number
  }

export type RuntimeBudgetSnapshotResult = RuntimeSessionViewsResult<BudgetView>

export type BudgetPatchPayload =
  | { readonly kind: "budget.updated"; readonly budget: BudgetView }
  | { readonly kind: "budget.removed" }

export function budgetCursor(sessionId: string): RuntimeSessionCursorIdentity & { readonly domain: "budget" } {
  return { scope: "session", domain: "budget", sessionId }
}

export function isBudgetPayload(payload: RuntimeUiPatchPayload): payload is BudgetPatchPayload {
  return payload.kind === "budget.updated" || payload.kind === "budget.removed"
}
