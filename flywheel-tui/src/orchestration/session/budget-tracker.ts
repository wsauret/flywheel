/**
 * Budget Tracker
 *
 * Budget enforcement flows through this module: BudgetTracker accumulates
 * cost/token/invocation data from NDJSON events and emits budget:exhausted
 * events when limits are hit. The step executor does NOT do its own per-step
 * budget check — all enforcement is event-driven through this tracker.
 *
 * Accumulates cost and token usage from Claude Code's NDJSON "result" events,
 * plus invocation counts from the step executor. Persists structured budget
 * usage to the session file with debounced writes. Provides budget exhaustion
 * checking and status reporting.
 *
 * Only "result" events are handled here — they are the sole cost-bearing event
 * type in Claude Code's stream-json format. For step_finish event handling
 * (used by internal harness engines), see src-legacy/session/budget-tracker.ts.
 *
 * Single-threaded assumption: Bun's event loop serializes debounced
 * writes and lifecycle updates — no locking needed. Do NOT use Worker
 * threads for this component.
 *
 * Usage:
 *   const tracker = createBudgetTracker({ sessionId, baseDir });
 *   parser.onEvent = tracker.handleEvent;
 *   tracker.incrementInvocations(); // called by step executor per dispatch
 *   tracker.isExhausted(budgetLimits); // check before next dispatch
 *   // ... when session ends:
 *   tracker.dispose(); // flushes pending data + cancels timers
 */

import type { NDJSONEvent } from "../../infra/subprocess-types.js";
import type { BudgetLimits, BudgetUsage, SessionBudgetStatus } from "../../workflows/schemas.js";
import { readSession, updateSession } from "./persistence.js";
import { DEFAULT_DEBOUNCE_MS } from "./buffered-file-writer.js";
import { ResultCostSchema, computeContextPercent } from "./budget-tracker-types.js";
import type { BudgetTrackerDeps, BudgetTracker, ContextUtilization } from "./budget-tracker-types.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBudgetTracker(deps: BudgetTrackerDeps): BudgetTracker {
  const { sessionId, baseDir, debounceMs = DEFAULT_DEBOUNCE_MS, emitter, workflowId, budgetLimits } = deps;

  // Self-seed from persisted budget usage (resume scenario).
  // Symmetric with writes: we already persist via updateSession, so reading
  // on init closes the loop without callers threading values through.
  const persisted = readSession(sessionId, baseDir);
  let totalCost = persisted?.totalCost ?? persisted?.budgetUsage?.cost_usd ?? 0;
  let tokensUsed = persisted?.budgetUsage?.tokens_used ?? 0;
  let invocationsUsed = persisted?.budgetUsage?.invocations_used ?? 0;
  let pendingWrite = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let wasExhausted = false;

  // Baseline for delta accounting on cost.
  // Claude Code's total_cost_usd IS cumulative within a single process, so we
  // compute deltas to avoid double-counting. onNewSubprocess() resets the
  // baseline when a new process is spawned.
  //
  // Note: usage.input_tokens / output_tokens are PER-TURN (not cumulative),
  // so they are added directly without delta logic.
  let lastSeenCost = 0;

  // Context utilization — self-seeds from persisted budgetUsage on resume.
  let ctxPromptTokens = persisted?.budgetUsage?.context_prompt_tokens ?? 0;
  let ctxWindow = persisted?.budgetUsage?.context_window ?? 0;

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  function writeBudgetUsage(): void {
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
      // Session may have been deleted or become corrupt.
      // Swallow — budget is still tracked in-memory.
    }
  }

  function scheduleWrite(): void {
    if (disposed) return;
    pendingWrite = true;

    // Reset the debounce timer
    if (timerId !== null) {
      clearTimeout(timerId);
    }
    timerId = setTimeout(writeBudgetUsage, debounceMs);
  }

  // -------------------------------------------------------------------------
  // Event handling
  // -------------------------------------------------------------------------

  function handleEvent(event: NDJSONEvent): void {
    // Handle result events (Claude Code stream-json format).
    // This is the only cost-bearing event type in Claude Code's stream-json output.
    // For step_finish event handling (internal harness engines), see:
    //   src-legacy/session/budget-tracker.ts
    if (event.type === "result") {
      const parsed = ResultCostSchema.safeParse(event.data);
      if (!parsed.success) return;

      // Compute deltas against last-seen values. total_cost_usd and token counts
      // are cumulative within a process, so we only add what's new since the last
      // result event. onNewSubprocess() resets baselines to 0 before each new spawn.
      const rawCost = parsed.data.total_cost_usd;

      totalCost += rawCost - lastSeenCost;
      lastSeenCost = rawCost;

      // Only update tokens when usage is present. A cost-only result
      // (no usage field) should not zero out or subtract from the token count.
      //
      // Note: usage.input_tokens / output_tokens are PER-TURN values (they do
      // NOT accumulate across turns within the same process), unlike total_cost_usd
      // which IS cumulative. We add them directly — no delta logic needed.
      //
      // Cache tokens (cache_read_input_tokens, cache_creation_input_tokens) are
      // intentionally excluded. They are priced at a fraction of regular input
      // token cost, and total_cost_usd already reflects their actual price.
      if (parsed.data.usage) {
        const inputTokens = parsed.data.usage.input_tokens ?? 0;
        const outputTokens = parsed.data.usage.output_tokens ?? 0;
        tokensUsed += inputTokens + outputTokens;
      }

      scheduleWrite();
      if (emitter && workflowId) {
        emitter("budget:metrics-changed", { workflowId, tokens: tokensUsed, cost: totalCost });
        if (budgetLimits) isExhausted(budgetLimits);
      }
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Invocation tracking
  // -------------------------------------------------------------------------

  function incrementInvocations(): void {
    invocationsUsed += 1;
    scheduleWrite();
  }

  function getInvocationsUsed(): number {
    return invocationsUsed;
  }

  // -------------------------------------------------------------------------
  // Accessors
  // -------------------------------------------------------------------------

  function getTotalCost(): number {
    return totalCost;
  }

  function getTokensUsed(): number {
    return tokensUsed;
  }

  // -------------------------------------------------------------------------
  // Context utilization
  // -------------------------------------------------------------------------

  function updateContextUtilization(promptTokens: number, contextWindow: number): void {
    if (promptTokens > 0) ctxPromptTokens = promptTokens;
    if (contextWindow > 0) ctxWindow = contextWindow;
  }

  function getContextUtilization(): ContextUtilization {
    return { promptTokens: ctxPromptTokens, contextWindow: ctxWindow, percent: computeContextPercent(ctxPromptTokens, ctxWindow) };
  }

  // -------------------------------------------------------------------------
  // Budget exhaustion
  // -------------------------------------------------------------------------

  function isExhausted(budgetLimits: BudgetLimits): boolean {
    let exhausted = false;
    let reason = "";

    if (budgetLimits.max_invocations > 0 && invocationsUsed >= budgetLimits.max_invocations) {
      exhausted = true;
      reason = `Invocation limit reached (${invocationsUsed}/${budgetLimits.max_invocations})`;
    }

    if (!exhausted && budgetLimits.max_tokens !== null && tokensUsed >= budgetLimits.max_tokens) {
      exhausted = true;
      reason = `Token limit reached (${tokensUsed}/${budgetLimits.max_tokens})`;
    }

    if (!exhausted && budgetLimits.wall_clock_deadline !== null) {
      const deadlineMs = new Date(budgetLimits.wall_clock_deadline).getTime();
      if (!Number.isNaN(deadlineMs) && Date.now() >= deadlineMs) {
        exhausted = true;
        reason = "Wall clock deadline exceeded";
      }
    }

    // Emit budget:exhausted on first transition
    if (exhausted && !wasExhausted && emitter && workflowId) {
      wasExhausted = true;
      emitter("budget:exhausted", { workflowId, reason });
    } else if (exhausted) {
      wasExhausted = true;
    }

    return exhausted;
  }

  // -------------------------------------------------------------------------
  // Budget status reporting
  // -------------------------------------------------------------------------

  function getBudgetStatus(budgetLimits: BudgetLimits): SessionBudgetStatus {
    // invocations_remaining: null when unlimited (0 means unlimited)
    const invocationsRemaining = budgetLimits.max_invocations > 0
      ? Math.max(0, budgetLimits.max_invocations - invocationsUsed)
      : null;

    // token_budget_remaining: null when unlimited (null means unlimited)
    const tokenBudgetRemaining = budgetLimits.max_tokens !== null
      ? Math.max(0, budgetLimits.max_tokens - tokensUsed)
      : null;

    return {
      invocations_remaining: invocationsRemaining,
      token_budget_remaining: tokenBudgetRemaining,
      wall_clock_deadline: budgetLimits.wall_clock_deadline,
    };
  }

  // -------------------------------------------------------------------------
  // Subprocess process boundary
  // -------------------------------------------------------------------------

  function onNewSubprocess(): void {
    lastSeenCost = 0;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function flush(): void {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    writeBudgetUsage();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    // Force-flush any pending data before teardown
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    // Write if there's a pending update
    if (pendingWrite) {
      writeBudgetUsage();
    }
  }

  return {
    handleEvent,
    getTotalCost,
    incrementInvocations,
    getInvocationsUsed,
    getTokensUsed,
    updateContextUtilization,
    getContextUtilization,
    isExhausted,
    getBudgetStatus,
    flush,
    dispose,
    onNewSubprocess,
  };
}
