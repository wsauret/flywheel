import { z } from "zod";
import type { NDJSONEvent } from "../../infra/ndjson-event-types.js";
import type { EmitFn } from "../../infra/event-bus.js";
import type { BudgetLimits } from "../../workflows/schemas.js";

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
  emitter?: EmitFn;
  /** Workflow ID used when emitting budget events. */
  workflowId?: string;
  /** When provided, the tracker auto-checks exhaustion on each cost update and emits budget:exhausted. */
  budgetLimits?: BudgetLimits;
}

export interface ContextUtilization {
  promptTokens: number;
  contextWindow: number;
  percent: number;
}

export function computeContextPercent(promptTokens: number, contextWindow: number): number {
  return contextWindow > 0
    ? Math.min(100, Math.round((promptTokens / contextWindow) * 100))
    : 0;
}

export interface BudgetTracker {
  handleEvent(event: NDJSONEvent): void;
  getTotalCost(): number;
  incrementInvocations(): void;
  getInvocationsUsed(): number;
  getTokensUsed(): number;
  updateContextUtilization(promptTokens: number, contextWindow: number): void;
  getContextUtilization(): ContextUtilization;
  isExhausted(budgetLimits: BudgetLimits): boolean;
  flush(): void;
  dispose(): void;
  // Must be called before each new engine process — total_cost_usd is cumulative
  // within a process; a new process resets to 0, so the baseline must follow.
  onNewProcess(): void;
}
