import type { NDJSONEvent } from "../../infra/subprocess-types.js";
import type { BudgetLimits, BudgetUsage } from "../../workflows/schemas.js";
import { readSession, updateSession } from "./persistence.js";
import { DEFAULT_DEBOUNCE_MS } from "./buffered-file-writer.js";
import { ResultCostSchema, computeContextPercent } from "./budget-tracker-types.js";
import type { BudgetTrackerDeps, BudgetTracker, ContextUtilization } from "./budget-tracker-types.js";

export function createBudgetTracker(deps: BudgetTrackerDeps): BudgetTracker {
  const { sessionId, baseDir, debounceMs = DEFAULT_DEBOUNCE_MS, emitter, workflowId, budgetLimits } = deps;

  // Self-seed from persisted budget usage so callers don't thread values through on resume.
  const persisted = readSession(sessionId, baseDir);
  let totalCost = persisted?.totalCost ?? persisted?.budgetUsage?.cost_usd ?? 0;
  let tokensUsed = persisted?.budgetUsage?.tokens_used ?? 0;
  let invocationsUsed = persisted?.budgetUsage?.invocations_used ?? 0;
  let pendingWrite = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let wasExhausted = false;

  // total_cost_usd is cumulative within a process — compute deltas to avoid
  // double-counting. onNewSubprocess() resets the baseline per spawn.
  // usage.input_tokens / output_tokens are PER-TURN, added directly.
  let lastSeenCost = 0;

  let ctxPromptTokens = persisted?.budgetUsage?.context_prompt_tokens ?? 0;
  let ctxWindow = persisted?.budgetUsage?.context_window ?? 0;

  function writeBudgetUsage() {
    if (!pendingWrite) return;
    pendingWrite = false;
    timerId = null;

    const budgetUsage = {
      invocations_used: invocationsUsed,
      tokens_used: tokensUsed,
      cost_usd: totalCost,
      context_prompt_tokens: ctxPromptTokens,
      context_window: ctxWindow,
    } satisfies BudgetUsage;

    try {
      updateSession(sessionId, { totalCost, budgetUsage }, baseDir);
    } catch {
      // Session may have been deleted — budget is still tracked in-memory
    }
  }

  function scheduleWrite() {
    if (disposed) return;
    pendingWrite = true;
    if (timerId !== null) clearTimeout(timerId);
    timerId = setTimeout(writeBudgetUsage, debounceMs);
  }

  function handleEvent(event: NDJSONEvent) {
    if (event.type !== "result") return;

    const parsed = ResultCostSchema.safeParse(event.data);
    if (!parsed.success) return;

    const rawCost = parsed.data.total_cost_usd;
    totalCost += rawCost - lastSeenCost;
    lastSeenCost = rawCost;

    // input_tokens/output_tokens are per-turn (not cumulative like total_cost_usd).
    // Cache tokens excluded — priced differently, already reflected in total_cost_usd.
    if (parsed.data.usage) {
      tokensUsed += (parsed.data.usage.input_tokens ?? 0) + (parsed.data.usage.output_tokens ?? 0);
    }

    scheduleWrite();
    if (emitter && workflowId) {
      emitter("budget:metrics-changed", { workflowId, tokens: tokensUsed, cost: totalCost });
      if (budgetLimits) isExhausted(budgetLimits);
    }
  }

  function incrementInvocations() {
    invocationsUsed += 1;
    scheduleWrite();
  }

  function getTotalCost() { return totalCost; }
  function getTokensUsed() { return tokensUsed; }

  function updateContextUtilization(promptTokens: number, contextWindow: number) {
    if (promptTokens > 0) ctxPromptTokens = promptTokens;
    if (contextWindow > 0) ctxWindow = contextWindow;
  }

  function getContextUtilization(): ContextUtilization {
    return { promptTokens: ctxPromptTokens, contextWindow: ctxWindow, percent: computeContextPercent(ctxPromptTokens, ctxWindow) };
  }

  function isExhausted(budgetLimits: BudgetLimits): boolean {
    const reason =
      (budgetLimits.max_invocations > 0 && invocationsUsed >= budgetLimits.max_invocations)
        ? `Invocation limit reached (${invocationsUsed}/${budgetLimits.max_invocations})`
      : (budgetLimits.max_tokens !== null && tokensUsed >= budgetLimits.max_tokens)
        ? `Token limit reached (${tokensUsed}/${budgetLimits.max_tokens})`
      : (budgetLimits.wall_clock_deadline !== null && (() => {
          const deadlineMs = new Date(budgetLimits.wall_clock_deadline!).getTime();
          return !Number.isNaN(deadlineMs) && Date.now() >= deadlineMs;
        })())
        ? "Wall clock deadline exceeded"
      : null;

    if (reason && !wasExhausted && emitter && workflowId) {
      emitter("budget:exhausted", { workflowId, reason });
    }
    if (reason) wasExhausted = true;
    return reason !== null;
  }

  function onNewSubprocess() {
    lastSeenCost = 0;
  }

  function flush() {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    writeBudgetUsage();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    flush();
  }

  return {
    handleEvent,
    getTotalCost,
    incrementInvocations,
    getTokensUsed,
    updateContextUtilization,
    getContextUtilization,
    isExhausted,
    flush,
    dispose,
    onNewSubprocess,
  };
}
