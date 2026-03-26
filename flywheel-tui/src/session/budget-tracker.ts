/**
 * Budget Tracker
 *
 * Accumulates cost_usd, token usage, and invocation counts from NDJSON
 * step_finish events. Persists structured budget usage to the session
 * file with debounced writes. Provides budget exhaustion checking and
 * status reporting.
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

import { z } from "zod";
import type { NDJSONEvent } from "../worker/ndjson-parser";
import type { BudgetLimits, BudgetUsage, SessionBudgetStatus } from "../schemas/shared";
import { updateSession } from "./persistence";

// ---------------------------------------------------------------------------
// Zod schema for safe cost/token extraction
// ---------------------------------------------------------------------------

/**
 * Narrow schema to safely extract cost_usd and optional token counts
 * from step_finish event data. Token fields are optional — if absent
 * in the NDJSON payload, tokens stay at 0 (graceful degradation).
 */
const StepFinishCostSchema = z
  .object({
    usage: z
      .object({
        cost_usd: z.number(),
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BudgetTrackerDeps {
  sessionId: string;
  baseDir: string;
  /** Debounce interval in ms. Default: 100ms */
  debounceMs?: number;
}

export interface BudgetTracker {
  /** Handle an NDJSON event. Attach this to parser.onEvent. */
  handleEvent(event: NDJSONEvent): void;
  /** Get accumulated cost so far. */
  getTotalCost(): number;
  /** Increment the step-level invocation counter. Called by the step executor after each dispatch. */
  incrementInvocations(): void;
  /** Get total invocations dispatched so far. */
  getInvocationsUsed(): number;
  /** Get total tokens consumed so far (input + output). */
  getTokensUsed(): number;
  /** Check whether any budget limit has been exceeded. */
  isExhausted(budgetLimits: BudgetLimits): boolean;
  /** Get current budget status for dispatcher reporting. */
  getBudgetStatus(budgetLimits: BudgetLimits): SessionBudgetStatus;
  /** Force-write pending budget usage to session file. */
  flush(): void;
  /** Cancel timers and flush. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 100;

export function createBudgetTracker(deps: BudgetTrackerDeps): BudgetTracker {
  const { sessionId, baseDir, debounceMs = DEFAULT_DEBOUNCE_MS } = deps;

  let totalCost = 0;
  let tokensUsed = 0;
  let invocationsUsed = 0;
  let pendingWrite = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  function writeBudgetUsage(): void {
    if (!pendingWrite) return;
    pendingWrite = false;
    timerId = null;

    const budgetUsage: BudgetUsage = {
      invocations_used: invocationsUsed,
      tokens_used: tokensUsed,
      cost_usd: totalCost,
    };

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
    if (event.type !== "step_finish") return;

    const parsed = StepFinishCostSchema.safeParse(event.data);
    if (!parsed.success) return;

    totalCost += parsed.data.usage.cost_usd;

    // Accumulate tokens — graceful: 0 if fields absent
    const inputTokens = parsed.data.usage.input_tokens ?? 0;
    const outputTokens = parsed.data.usage.output_tokens ?? 0;
    tokensUsed += inputTokens + outputTokens;

    scheduleWrite();
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
  // Budget exhaustion
  // -------------------------------------------------------------------------

  function isExhausted(budgetLimits: BudgetLimits): boolean {
    // Check invocation limit (0 = unlimited)
    if (budgetLimits.max_invocations > 0 && invocationsUsed >= budgetLimits.max_invocations) {
      return true;
    }

    // Check token limit (null = unlimited)
    if (budgetLimits.max_tokens !== null && tokensUsed >= budgetLimits.max_tokens) {
      return true;
    }

    // Check wall clock deadline (null = no deadline)
    if (budgetLimits.wall_clock_deadline !== null) {
      const deadlineMs = new Date(budgetLimits.wall_clock_deadline).getTime();
      // Guard against invalid date strings (NaN)
      if (!Number.isNaN(deadlineMs) && Date.now() >= deadlineMs) {
        return true;
      }
    }

    return false;
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
    isExhausted,
    getBudgetStatus,
    flush,
    dispose,
  };
}
