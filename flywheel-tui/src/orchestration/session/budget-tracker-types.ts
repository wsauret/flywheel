import { z } from "zod";
import type { NDJSONEvent } from "../../infra/subprocess-types.js";
import type { BudgetLimits, SessionBudgetStatus } from "../../workflows/schemas.js";

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
export const ResultCostSchema = z
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

export interface BudgetTrackerDeps {
  sessionId: string;
  baseDir: string;
  /** Debounce interval in ms. Default: 100ms */
  debounceMs?: number;
  /** Optional emitter for budget events. When provided, budget:metrics-changed and budget:exhausted are emitted. */
  emitter?: import("../../infra/event-bus").EmitFn;
  /** Workflow ID used when emitting budget events. */
  workflowId?: string;
  /** When provided, the tracker auto-checks exhaustion on each cost update and emits budget:exhausted. */
  budgetLimits?: BudgetLimits;
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

/** Compute context utilization percent from raw token counts. */
export function computeContextPercent(promptTokens: number, contextWindow: number): number {
  return contextWindow > 0
    ? Math.min(100, Math.round((promptTokens / contextWindow) * 100))
    : 0;
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
}
