import type { StoredFact } from "../../infra/event-store-types.js"
import { budgetExhaustionReason, type BudgetLimits } from "../../workflows/budget.js"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../infra/runtime-fact-mapper.js"
import {
  budgetMetricsFromProjection,
  contextUtilizationFromProjection,
  createBudgetProjection,
  type BudgetProjectionState,
} from "./budget-projection.js"
import type { BudgetMetrics, SessionBudgetStore, SessionBudgetStoreDeps, ContextUtilization } from "./budget-store-types.js"
import type { SessionRuntimeFact } from "./session-runtime-event-types.js"

export function createSessionBudgetStore(deps: SessionBudgetStoreDeps): SessionBudgetStore {
  const { sessionId, emitter, budgetLimits, reader, recorder } = deps
  const projection = createBudgetProjection(reader, deps.owner ?? sessionId)
  // Pull reads can replay committed usage before its push callback arrives.
  // Notification deduplication compares with what subscribers last received.
  let lastPublished = projection.getState()
  let disposed = false
  // Emit-once latch for budget.exhausted, not a projection shadow: once we have
  // signaled exhaustion this store-lifetime, repeated isExhausted() calls stay quiet.
  let wasExhausted = false

  // Pull-path state: the held projection outlives this store (the registry
  // caches it per reader), so after an in-process reactivation the frozen
  // getState() would miss usage another process committed while the session
  // sat inactive. replay() folds only what is new; with this store's own
  // apply() calls the common case is a no-op position check.
  async function fresh(): Promise<BudgetProjectionState> {
    return await projection.replay()
  }

  // The event carries every value a subscriber shows, so a subscriber never
  // reads the store again after each change.
  function emitMetrics(state: BudgetProjectionState): void {
    emitter("budget.metrics.changed", { sessionId, data: budgetMetricsFromProjection(state) })
  }

  async function recordFact(fact: SessionRuntimeFact): Promise<StoredFact | null> {
    if (disposed) return null
    const event = await recorder(fact)
    if (!event) return null
    await applyStoredFact(event)
    return event
  }

  async function recordRuntimeEvent(event: Parameters<SessionBudgetStore["recordRuntimeEvent"]>[0]): Promise<void> {
    for (const fact of mapRuntimeEventToSessionRuntimeFacts(event)) {
      await recordFact(fact)
    }
  }

  // The writer pushes every fact it records. The projection reads only for a
  // budget fact, so the other facts of the session cost no read.
  async function applyStoredFact(event: StoredFact): Promise<void> {
    const after = await projection.apply(event)
    if (metricsChanged(lastPublished, after)) {
      lastPublished = after
      emitMetrics(after)
      if (budgetLimits) checkExhausted(budgetLimits, after)
    }
  }

  async function recordInvocation(): Promise<void> {
    await recordFact({
      type: "budget.invocation.recorded",
      version: 1,
      actor: "flywheel",
      payload: { count: 1 },
    })
  }

  async function getTotalCost(): Promise<number> {
    return (await fresh()).totalCost
  }

  async function getInvocationsUsed(): Promise<number> {
    return (await fresh()).invocationsUsed
  }

  async function getTokensUsed(): Promise<number> {
    const state = await fresh()
    return state.totalInputTokens + state.totalOutputTokens
  }

  async function getOutputTokensUsed(): Promise<number> {
    return (await fresh()).totalOutputTokens
  }

  async function metrics(): Promise<BudgetMetrics> {
    return budgetMetricsFromProjection(await fresh())
  }

  async function recordContextUtilization(promptTokens: number, contextWindow: number): Promise<void> {
    await recordFact({
      type: "model.context.measured",
      version: 1,
      actor: "provider",
      payload: { promptTokens, contextWindow },
    })
  }

  async function getContextUtilization(): Promise<ContextUtilization> {
    return contextUtilizationFromProjection(await fresh())
  }

  async function isExhausted(limits: BudgetLimits): Promise<boolean> {
    return checkExhausted(limits, await fresh())
  }

  function checkExhausted(limits: BudgetLimits, state: BudgetProjectionState): boolean {
    const reason = limits.max_cost_usd != null && state.priceUnavailable
      ? "Cost limit cannot be enforced because committed usage has unavailable pricing"
      : budgetExhaustionReason(limits, {
          invocationsUsed: state.invocationsUsed,
          tokensUsed: state.totalInputTokens + state.totalOutputTokens,
          unmeasuredRequests: state.unmeasuredRequests,
          costUsed: state.totalCost,
        })

    if (reason && !wasExhausted) {
      emitter("budget.exhausted", { sessionId, data: { reason } })
    }
    if (reason) wasExhausted = true
    return reason !== null
  }

  async function recordProcessStarted(): Promise<void> {
    await recordFact({
      type: "budget.process.started",
      version: 1,
      actor: "flywheel",
      payload: {},
    })
  }

  function dispose(): void {
    disposed = true
  }

  return {
    recordRuntimeEvent,
    applyStoredFact,
    getTotalCost,
    recordInvocation,
    getInvocationsUsed,
    getTokensUsed,
    getOutputTokensUsed,
    metrics,
    recordContextUtilization,
    getContextUtilization,
    isExhausted,
    dispose,
    recordProcessStarted,
  }
}

function metricsChanged(before: BudgetProjectionState, after: BudgetProjectionState): boolean {
  return before.totalCost !== after.totalCost
    || before.totalBilledCost !== after.totalBilledCost
    || before.priceUnavailable !== after.priceUnavailable
    || before.totalInputTokens !== after.totalInputTokens
    || before.totalOutputTokens !== after.totalOutputTokens
    || before.contextPromptTokens !== after.contextPromptTokens
    || before.contextWindow !== after.contextWindow
}
