import type { AsyncEventReadSurface } from "../../infra/event-store-types.js"
import { contextUtilizationFromProjection, createBudgetProjection, type BudgetProjectionState } from "./budget-projection.js"

export interface BudgetSummary {
  totalCost: number
  totalBilledCost: number
  priceUnavailable: boolean
  totalTokens: number
  outputTokens: number
  contextPromptTokens: number
  contextPercent: number
  compactionTriggerTokens?: number
}

export interface UsageTotals {
  readonly totalCost: number
  readonly totalBilledCost: number
  readonly priceUnavailable: boolean
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
}

export async function readBudgetSummaryFromReader(reader: AsyncEventReadSurface, sessionId: string): Promise<BudgetSummary> {
  return budgetSummaryFromState(await createBudgetProjection(reader, sessionId).replay())
}

export function budgetSummaryFromState(state: BudgetProjectionState, descendants?: UsageTotals): BudgetSummary {
  const context = contextUtilizationFromProjection(state)
  const usage = descendants ?? {
    totalCost: 0,
    totalBilledCost: 0,
    priceUnavailable: false,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  }
  return {
    totalCost: state.totalCost + usage.totalCost,
    totalBilledCost: state.totalBilledCost + usage.totalBilledCost,
    priceUnavailable: state.priceUnavailable || usage.priceUnavailable,
    totalTokens: state.totalInputTokens + state.totalOutputTokens + usage.totalInputTokens + usage.totalOutputTokens,
    outputTokens: state.totalOutputTokens + usage.totalOutputTokens,
    contextPromptTokens: state.contextPromptTokens,
    contextPercent: context.percent,
    ...(context.compactionTriggerTokens === undefined ? {} : { compactionTriggerTokens: context.compactionTriggerTokens }),
  }
}
