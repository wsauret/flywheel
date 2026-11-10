import type { EmitFn } from "../../infra/event-bus.js";
import type { AsyncEventReadSurface, StoredFact } from "../../infra/event-store-types.js";
import type { RuntimeEvent } from "../../infra/runtime-event-types.js";
import type { BudgetLimits } from "../../workflows/budget.js";
import type { SessionRuntimeFact } from "./session-runtime-event-types.js";
import type { DurableOwner } from "../../infra/durable-owner.js";

export interface SessionBudgetStoreDeps {
  sessionId: string;
  owner?: DurableOwner;
  /** Emitter for budget events: budget.metrics.changed and budget.exhausted. */
  emitter: EmitFn;
  /** When provided, the store auto-checks exhaustion on each cost update and emits budget.exhausted. */
  budgetLimits?: BudgetLimits;
  reader: AsyncEventReadSurface;
  recorder: (fact: SessionRuntimeFact) => Promise<StoredFact | null>;
}

export interface ContextUtilization {
  promptTokens: number;
  contextWindow: number;
  percent: number;
  /** The context size of the next automatic reset as the latest measurement
   *  stated it: 0 when none can run, absent when it stated none. */
  compactionTriggerTokens?: number;
}

export function computeContextPercent(promptTokens: number, contextWindow: number): number {
  return contextWindow > 0
    ? Math.min(100, Math.round((promptTokens / contextWindow) * 100))
    : 0;
}

/** The budget values a session shows, which `budget.metrics.changed` carries. */
export interface BudgetMetrics {
  tokens: number;
  cost: number;
  /** Metered (API-key) portion of `cost`; the remainder is
   *  subscription-covered API-equivalent value. */
  billedCost: number;
  /** True when at least one committed v5 entry has no canonical price. */
  priceUnavailable: boolean;
  contextPercent: number;
  contextPromptTokens: number;
}

export interface SessionBudgetStore {
  recordRuntimeEvent(event: RuntimeEvent): Promise<void>;
  applyStoredFact(event: StoredFact): Promise<void>;
  getTotalCost(): Promise<number>;
  recordInvocation(): Promise<void>;
  getInvocationsUsed(): Promise<number>;
  getTokensUsed(): Promise<number>;
  getOutputTokensUsed(): Promise<number>;
  /** The current metrics, for an owner that shows them before the next change. */
  metrics(): Promise<BudgetMetrics>;
  recordContextUtilization(promptTokens: number, contextWindow: number): Promise<void>;
  getContextUtilization(): Promise<ContextUtilization>;
  isExhausted(budgetLimits: BudgetLimits): Promise<boolean>;
  dispose(): void;
  // Must be called before each new model run; total_cost_usd is cumulative
  // within a run; a new run resets to 0, so the baseline must follow.
  recordProcessStarted(): Promise<void>;
}
