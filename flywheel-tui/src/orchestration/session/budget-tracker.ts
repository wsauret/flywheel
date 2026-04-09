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

import { z } from "zod";
import type { NDJSONEvent } from "../engines/subprocess/ndjson-parser";
import type { BudgetLimits, BudgetUsage, SessionBudgetStatus } from "../../workflows/schemas";
import { updateSession } from "./persistence";
import { DEFAULT_DEBOUNCE_MS } from "./buffered-file-writer";

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
  emitter?: import("../../infra/event-bus").EmitFn;
  /** Workflow ID used when emitting budget events. */
  workflowId?: string;
}

/** Snapshot of how full the context window is. */
export interface ContextUtilization {
  /** Prompt tokens used in the most recent main-conversation API call. */
  promptTokens: number;
  /** Model's context window size (0 = unknown). */
  contextWindow: number;
  /** Utilization as 0..100 percentage. 0 when contextWindow is unknown. */
  percent: number;
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
  /**
   * Update context utilization. Called by engine-specific adapters that know
   * how to extract prompt size and context window from their event format.
   */
  updateContextUtilization(promptTokens: number, contextWindow: number): void;
  /** Get the latest context window utilization. */
  getContextUtilization(): ContextUtilization;
  /** Check whether any budget limit has been exceeded. */
  isExhausted(budgetLimits: BudgetLimits): boolean;
  /** Get current budget status for dispatcher reporting. */
  getBudgetStatus(budgetLimits: BudgetLimits): SessionBudgetStatus;
  /** Force-write pending budget usage to session file. */
  flush(): void;
  /** Cancel timers and flush. */
  dispose(): void;
  /**
   * Reset the "last seen" cost/token baselines to zero.
   * Must be called before each new subprocess is spawned so that
   * delta accounting works correctly across process boundaries.
   * (Claude Code's total_cost_usd is cumulative within a process; a new
   * process resets to 0, so the baseline must follow.)
   */
  onNewSubprocess(): void;
  /**
   * Optional callback fired whenever tokens or cost change.
   * Enables event-driven metrics updates instead of polling.
   */
  onMetricsChange?: (tokens: number, cost: number) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBudgetTracker(deps: BudgetTrackerDeps): BudgetTracker {
  const { sessionId, baseDir, debounceMs = DEFAULT_DEBOUNCE_MS, emitter, workflowId } = deps;

  let totalCost = 0;
  let tokensUsed = 0;
  let invocationsUsed = 0;
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

  // Context utilization — updated by engine-specific adapters via updateContextUtilization().
  let ctxPromptTokens = 0;
  let ctxWindow = 0;

  // Event-driven metrics callback — set by callers to avoid polling.
  let onMetricsChange: ((tokens: number, cost: number) => void) | undefined;

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
      onMetricsChange?.(tokensUsed, totalCost);
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
    const percent = ctxWindow > 0
      ? Math.min(100, Math.round((ctxPromptTokens / ctxWindow) * 100))
      : 0;
    return { promptTokens: ctxPromptTokens, contextWindow: ctxWindow, percent };
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
    get onMetricsChange() { return onMetricsChange; },
    set onMetricsChange(cb: ((tokens: number, cost: number) => void) | undefined) { onMetricsChange = cb; },
  };
}
