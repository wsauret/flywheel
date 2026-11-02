import type { AsyncEventStateReadSurface } from "../infra/event-store-types.js";
import { readWorkflowLaunchedAt } from "./session-fact-source.js";

/** Workflow budget limits. Flywheel checks them before each attempt starts
 *  and never stops an attempt that is already running (PI-AGENT-041).
 *  `max_invocations` counts attempts, not model requests. */
export interface BudgetLimits {
  max_invocations: number;
  max_tokens: number | null;
  max_wall_clock_minutes: number | null;
  max_cost_usd?: number | null;
}

interface BudgetUsageSnapshot {
  invocationsUsed: number;
  /** Tokens the providers reported. A request served without a usage report adds none. */
  tokensUsed: number;
  /** Requests served without a usage report, which the token reason names. */
  unmeasuredRequests?: number;
  costUsed?: number;
  /** Wall-clock milliseconds since the durable workflow launch. Work without a
   * committed workflow launch has no elapsed time, so no wall-clock limit applies. */
  elapsedMs?: number;
}

export const DEFAULT_BUDGET = {
  max_invocations: 0,
  max_tokens: 0,
  max_wall_clock_minutes: 0,
} as const;

type BudgetConfig = {
  max_invocations: number;
  max_tokens: number;
  max_wall_clock_minutes: number;
};

export function toBudgetLimits(budget: BudgetConfig): BudgetLimits {
  return {
    max_invocations: budget.max_invocations,
    max_tokens: budget.max_tokens > 0 ? budget.max_tokens : null,
    max_wall_clock_minutes: budget.max_wall_clock_minutes > 0 ? budget.max_wall_clock_minutes : null,
  };
}

export function budgetExhaustionReason(limits: BudgetLimits, usage: BudgetUsageSnapshot): string | null {
  if (limits.max_invocations > 0 && usage.invocationsUsed >= limits.max_invocations) {
    return `Attempt limit reached (${usage.invocationsUsed}/${limits.max_invocations})`;
  }
  if (limits.max_tokens !== null && usage.tokensUsed >= limits.max_tokens) {
    const unmeasured = usage.unmeasuredRequests ?? 0;
    const unreported = unmeasured === 0 ? "" : `; ${unmeasured} unmeasured ${unmeasured === 1 ? "request" : "requests"} added no tokens`;
    return `Token limit reached (${usage.tokensUsed}/${limits.max_tokens} reported tokens${unreported})`;
  }
  if (limits.max_cost_usd != null && (usage.costUsed ?? 0) >= limits.max_cost_usd) {
    return `Cost limit reached ($${(usage.costUsed ?? 0).toFixed(2)}/$${limits.max_cost_usd.toFixed(2)})`;
  }
  if (limits.max_wall_clock_minutes !== null && usage.elapsedMs !== undefined
    && usage.elapsedMs >= limits.max_wall_clock_minutes * 60_000) {
    return `Wall-clock limit reached (${Math.floor(usage.elapsedMs / 60_000)}/${limits.max_wall_clock_minutes} minutes)`;
  }
  return null;
}

/** Usage counters the workflow budget gate reads before each attempt. */
interface WorkflowBudgetUsage {
  getInvocationsUsed(): Promise<number>;
  /** The tokens providers reported, and the requests served without a report. */
  getTokensUsed(): Promise<{ readonly reported: number; readonly unmeasuredRequests: number }>;
}

/** The pause reason when the workflow has spent its configured budget, or null.
 * Elapsed wall-clock time counts from the committed launch, so the limit holds
 * across pauses, resumes, and process restarts. */
export async function workflowBudgetRefusal(input: {
  readonly budget: BudgetConfig;
  readonly usage: WorkflowBudgetUsage;
  readonly reader: AsyncEventStateReadSurface;
  readonly sessionId: string;
  readonly nowMs?: number;
}): Promise<string | null> {
  const limits = toBudgetLimits(input.budget);
  const launchedAt = limits.max_wall_clock_minutes === null ? null : await readWorkflowLaunchedAt(input.reader, input.sessionId);
  // Workflow token usage sums every member, so the gate reads it only when a limit can use it.
  const tokens = limits.max_tokens === null ? undefined : await input.usage.getTokensUsed();
  const reason = budgetExhaustionReason(limits, {
    invocationsUsed: await input.usage.getInvocationsUsed(),
    tokensUsed: tokens?.reported ?? 0,
    ...(tokens === undefined ? {} : { unmeasuredRequests: tokens.unmeasuredRequests }),
    ...(launchedAt === null ? {} : { elapsedMs: (input.nowMs ?? Date.now()) - launchedAt }),
  });
  return reason ? `Budget exhausted: ${reason}. The workflow paused before its next attempt.` : null;
}
