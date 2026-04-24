import type { LLMClient, StreamEvent } from "./llm/types.js";

interface TurnCostTotals {
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

interface TurnCacheTokens {
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

interface TurnTokens {
  inputTokens: number;
  outputTokens: number;
}

interface TurnCostTracker {
  handleUsage(event: StreamEvent & { kind: "usage" }): void;
  resetTurn(): void;
  getTotals(): TurnCostTotals;
  getTurnTokens(): TurnTokens;
  getTurnCacheTokens(): TurnCacheTokens;
  addExternalCost(cost: number, inputTokens: number, outputTokens: number): void;
}

export function createTurnCostTracker(client: LLMClient): TurnCostTracker {
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;

  let turnInputTokens = 0;
  let turnOutputTokens = 0;
  let turnCacheReadTokens = 0;
  let turnCacheCreateTokens = 0;
  let turnReasoningTokens = 0;

  return {
    handleUsage(event) {
      const deltaInputTokens = Math.max(0, event.inputTokens - turnInputTokens);
      const deltaOutputTokens = Math.max(0, event.outputTokens - turnOutputTokens);
      const deltaCacheReadTokens = Math.max(0, event.cacheReadTokens - turnCacheReadTokens);
      const deltaCacheCreateTokens = Math.max(0, event.cacheCreateTokens - turnCacheCreateTokens);
      const deltaReasoningTokens = Math.max(0, event.reasoningTokens - turnReasoningTokens);

      turnInputTokens = event.inputTokens;
      turnOutputTokens = event.outputTokens;
      turnCacheReadTokens = event.cacheReadTokens;
      turnCacheCreateTokens = event.cacheCreateTokens;
      turnReasoningTokens = event.reasoningTokens;

      totalInputTokens += deltaInputTokens;
      totalOutputTokens += deltaOutputTokens;
      totalCostUsd += client.costFor({
        input: deltaInputTokens,
        output: deltaOutputTokens,
        cacheRead: deltaCacheReadTokens,
        cacheWrite: deltaCacheCreateTokens,
        reasoning: deltaReasoningTokens,
        promptTokens: event.inputTokens + event.cacheReadTokens,
      });
    },

    resetTurn() {
      turnInputTokens = 0;
      turnOutputTokens = 0;
      turnCacheReadTokens = 0;
      turnCacheCreateTokens = 0;
      turnReasoningTokens = 0;
    },

    getTotals() {
      return { cost: totalCostUsd, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
    },

    getTurnTokens() {
      return { inputTokens: turnInputTokens, outputTokens: turnOutputTokens };
    },

    getTurnCacheTokens() {
      return { cacheReadTokens: turnCacheReadTokens, cacheCreateTokens: turnCacheCreateTokens };
    },

    addExternalCost(cost, inputTokens, outputTokens) {
      totalCostUsd += cost;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;
    },
  };
}
