import type { UsageEntry } from "../../infra/llm/usage-entry.js";
import { createRuntimeEvent } from "../../infra/runtime-event-factory.js";
import type { RuntimeEvent } from "../../infra/runtime-event-types.js";

interface ProviderUsageReading {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreateTokens: number;
  readonly reasoningTokens: number;
}

interface TurnUsageTotals extends ProviderUsageReading {
  readonly cost: number;
  readonly billedCost: number;
}

interface TurnUsageTrackerOptions {
  readonly emit: (event: RuntimeEvent) => void;
  readonly budgetStreamId: string;
  readonly parentToolUseId?: string;
}

export interface TurnUsageTracker {
  beginAttempt(): void;
  handleUsage(reading: ProviderUsageReading): void;
  commitEntry(entry: UsageEntry): boolean;
  commitPublishedEntry(entry: UsageEntry): boolean;
  resetTurn(): void;
  getTotals(): TurnUsageTotals;
  getTurnTokens(): Pick<ProviderUsageReading, "inputTokens" | "outputTokens">;
  getTurnCacheTokens(): Pick<ProviderUsageReading, "cacheReadTokens" | "cacheCreateTokens">;
}

/** Tracks raw provider counters separately from committed canonical usage. Raw readings support terminal token totals only. */
export function createTurnUsageTracker(options: TurnUsageTrackerOptions): TurnUsageTracker {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreateTokens = 0;
  let totalReasoningTokens = 0;
  let totalCostUsd = 0;
  let totalBilledCostUsd = 0;
  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let turnCacheReadTokens = 0;
  let turnCacheCreateTokens = 0;
  let turnReasoningTokens = 0;
  const committedEntryIds = new Set<string>();

  const resetAttemptBaseline = (): void => {
    turnInputTokens = 0;
    turnOutputTokens = 0;
    turnCacheReadTokens = 0;
    turnCacheCreateTokens = 0;
    turnReasoningTokens = 0;
  };

  const commitEntry = (entry: UsageEntry, publish: boolean): boolean => {
    if (committedEntryIds.has(entry.attemptId)) return false;
    committedEntryIds.add(entry.attemptId);
    const costUsdDelta = entry.coverage !== "unmeasured" && entry.price.kind === "priced" ? entry.price.estimatedUsd : null;
    const billedCostUsdDelta = costUsdDelta === null ? null : entry.classification === "real_spend" ? costUsdDelta : 0;
    if (costUsdDelta !== null) {
      totalCostUsd += costUsdDelta;
      totalBilledCostUsd += billedCostUsdDelta ?? 0;
    }
    if (publish) {
      options.emit(createRuntimeEvent("model.usage.measured", {
        usage_entry: entry,
        budget_stream_id: options.budgetStreamId,
        ...(options.parentToolUseId ? { parent_tool_use_id: options.parentToolUseId } : {}),
      }));
    }
    return true;
  };

  return {
    beginAttempt: resetAttemptBaseline,
    handleUsage(reading) {
      totalInputTokens += Math.max(0, reading.inputTokens - turnInputTokens);
      totalOutputTokens += Math.max(0, reading.outputTokens - turnOutputTokens);
      totalCacheReadTokens += Math.max(0, reading.cacheReadTokens - turnCacheReadTokens);
      totalCacheCreateTokens += Math.max(0, reading.cacheCreateTokens - turnCacheCreateTokens);
      totalReasoningTokens += Math.max(0, reading.reasoningTokens - turnReasoningTokens);
      turnInputTokens = reading.inputTokens;
      turnOutputTokens = reading.outputTokens;
      turnCacheReadTokens = reading.cacheReadTokens;
      turnCacheCreateTokens = reading.cacheCreateTokens;
      turnReasoningTokens = reading.reasoningTokens;
    },
    commitEntry: (entry) => commitEntry(entry, true),
    commitPublishedEntry: (entry) => commitEntry(entry, false),
    resetTurn: resetAttemptBaseline,
    getTotals: () => ({ cost: totalCostUsd, billedCost: totalBilledCostUsd, inputTokens: totalInputTokens, outputTokens: totalOutputTokens, cacheReadTokens: totalCacheReadTokens, cacheCreateTokens: totalCacheCreateTokens, reasoningTokens: totalReasoningTokens }),
    getTurnTokens: () => ({ inputTokens: turnInputTokens, outputTokens: turnOutputTokens }),
    getTurnCacheTokens: () => ({ cacheReadTokens: turnCacheReadTokens, cacheCreateTokens: turnCacheCreateTokens }),
  };
}
