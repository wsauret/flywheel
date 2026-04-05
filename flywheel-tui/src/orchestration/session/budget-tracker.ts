/**
 * Budget Tracker
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

import { z } from "zod";
import type { NDJSONEvent } from "../worker/ndjson-parser";
import type { BudgetLimits, BudgetUsage, SessionBudgetStatus } from "../../workflows/schemas";
import { updateSession } from "./persistence";

// ---------------------------------------------------------------------------
// Zod schema for safe cost/token extraction
// ---------------------------------------------------------------------------

/**
 * Schema for Claude Code "result" events.
 *
 * Claude Code stream-json result format:
 *   {
 *     "type": "result",
 *     "subtype": "success",
 *     "total_cost_usd": 0.031,
 *     "usage": { "input_tokens": 1000, "output_tokens": 500, "cache_read_input_tokens": 15000, ... },
 *     ...
 *   }
 *
 * Note: cache_read_input_tokens and cache_creation_input_tokens are present in
 * the usage object but are NOT counted toward tokensUsed. See handleEvent for
 * the rationale.
 */
const ResultCostSchema = z
  .object({
    total_cost_usd: z.number(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
        cache_read_input_tokens: z.number().optional(),
        cache_creation_input_tokens: z.number().optional(),
      })
      .passthrough()
      .optional(),
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
  /** Optional emitter for budget events. When provided, budget:exhausted is emitted on first exhaustion. */
  emitter?: Pick<import("../../protocol/event-bus").FlywheelEmitter, "budgetExhausted" | "budgetWarning">;
  /** Workflow ID used when emitting budget events. */
  workflowId?: string;
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
  const { sessionId, baseDir, debounceMs = DEFAULT_DEBOUNCE_MS, emitter, workflowId } = deps;

  let totalCost = 0;
  let tokensUsed = 0;
  let invocationsUsed = 0;
  let pendingWrite = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let wasExhausted = false;

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
    // Handle result events (Claude Code stream-json format).
    // This is the only cost-bearing event type in Claude Code's stream-json output.
    // For step_finish event handling (internal harness engines), see:
    //   src-legacy/session/budget-tracker.ts
    if (event.type === "result") {
      const parsed = ResultCostSchema.safeParse(event.data);
      if (!parsed.success) return;

      totalCost += parsed.data.total_cost_usd;
      const inputTokens = parsed.data.usage?.input_tokens ?? 0;
      const outputTokens = parsed.data.usage?.output_tokens ?? 0;
      // Cache tokens (cache_read_input_tokens, cache_creation_input_tokens) are intentionally
      // excluded from tokensUsed. They are priced at a fraction of regular input token cost,
      // and total_cost_usd already reflects their actual price. Counting them at full weight
      // would inflate the token budget counter relative to actual spending — e.g., 50k cheap
      // cache-read tokens would exhaust a 100k token budget without a meaningful cost impact.
      tokensUsed += inputTokens + outputTokens;

      scheduleWrite();
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
  // Budget exhaustion
  // -------------------------------------------------------------------------

  function isExhausted(budgetLimits: BudgetLimits): boolean {
    let exhausted = false;
    let reason = "";

    // Check invocation limit (0 = unlimited)
    if (budgetLimits.max_invocations > 0 && invocationsUsed >= budgetLimits.max_invocations) {
      exhausted = true;
      reason = `Invocation limit reached (${invocationsUsed}/${budgetLimits.max_invocations})`;
    }

    // Check token limit (null = unlimited)
    if (!exhausted && budgetLimits.max_tokens !== null && tokensUsed >= budgetLimits.max_tokens) {
      exhausted = true;
      reason = `Token limit reached (${tokensUsed}/${budgetLimits.max_tokens})`;
    }

    // Check wall clock deadline (null = no deadline)
    if (!exhausted && budgetLimits.wall_clock_deadline !== null) {
      const deadlineMs = new Date(budgetLimits.wall_clock_deadline).getTime();
      // Guard against invalid date strings (NaN)
      if (!Number.isNaN(deadlineMs) && Date.now() >= deadlineMs) {
        exhausted = true;
        reason = "Wall clock deadline exceeded";
      }
    }

    // Emit budget:exhausted on first transition from non-exhausted to exhausted
    if (exhausted && !wasExhausted && emitter && workflowId) {
      wasExhausted = true;
      emitter.budgetExhausted(workflowId, reason);
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
