import { describe, expect, test } from "bun:test";

import type { UsageEntry } from "../../../../src/infra/llm/usage-entry.js";
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types.js";
import { createTurnUsageTracker } from "../../../../src/orchestration/agent-runtime/turn-usage-tracker.js";

const baseEntry: UsageEntry = {
  attemptId: "00000000-0000-4000-8000-000000000001",
  occurredAt: "2025-01-15T12:00:00.000Z",
  profileId: "profile-a",
  attribution: { kind: "candidate", providerId: "openai_api" },
  spendMode: "direct_api",
  credentialLineage: "00000000-0000-4000-8000-000000000002",
  model: "gpt-5",
  tokens: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, reasoning: 3 },
  classification: "real_spend",
  price: { kind: "priced", estimatedUsd: 0.25, rateCard: { input: 2.5 }, provenance: "models.dev" },
  currency: "USD", coverage: "complete",
};

describe("model.usage.measured emission", () => {
  test("raw cumulative provider usage updates final totals without publishing money", () => {
    const events: RuntimeEvent[] = [];
    const tracker = createTurnUsageTracker({ emit: (event) => events.push(event), budgetStreamId: "session:one" });
    tracker.beginAttempt();
    tracker.handleUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheCreateTokens: 1, reasoningTokens: 3 });
    tracker.handleUsage({ inputTokens: 20, outputTokens: 7, cacheReadTokens: 2, cacheCreateTokens: 1, reasoningTokens: 4 });

    expect(events).toEqual([]);
    expect(tracker.getTotals()).toMatchObject({ cost: 0, billedCost: 0, inputTokens: 20, outputTokens: 7 });
  });

  test("only a committed entry emits one idempotent fully attributed mirror", () => {
    const events: RuntimeEvent[] = [];
    const tracker = createTurnUsageTracker({ emit: (event) => events.push(event), budgetStreamId: "session:one", parentToolUseId: "parent-1" });

    expect(tracker.commitEntry(baseEntry)).toBe(true);
    expect(tracker.commitEntry(baseEntry)).toBe(false);
    expect(events).toEqual([{
      type: "model.usage.measured",
      data: {
        usage_entry: baseEntry,
        budget_stream_id: "session:one",
        parent_tool_use_id: "parent-1",
      },
    }]);
  });

  test("included and unknown-price entries publish correct money deltas", () => {
    const events: RuntimeEvent[] = [];
    const tracker = createTurnUsageTracker({ emit: (event) => events.push(event), budgetStreamId: "session:one" });
    tracker.commitEntry({ ...baseEntry, attemptId: "00000000-0000-4000-8000-000000000003", spendMode: "included", classification: "subscription_equivalent" });
    tracker.commitEntry({ ...baseEntry, attemptId: "00000000-0000-4000-8000-000000000004", price: { kind: "unavailable", reason: "missing-rate-card" } });

    expect(events[0]?.data).toMatchObject({ usage_entry: { spendMode: "included", price: { estimatedUsd: 0.25 } } });
    expect(events[1]?.data).toMatchObject({ usage_entry: { price: { kind: "unavailable" } } });
  });
});
