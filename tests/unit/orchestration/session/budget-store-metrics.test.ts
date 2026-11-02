import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types";
import { committedUsageEvent, makeSessionBudgetStore } from "./_budget-store-fixtures";

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-budget-snapshot-test-${process.pid}-${Date.now()}`,
);

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function newSessionId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function resultEvent(costUsd: number, inputTokens = 1000, outputTokens = 500): RuntimeEvent {
  return {
    type: "model.turn.completed",
    data: {
      type: "model.turn.completed",
      subtype: "success",
      session_id: "abc-123",
      total_cost_usd: costUsd,
      billed_cost_usd: costUsd,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    },
  };
}

afterEach(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

const zero = { tokens: 0, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: 0, contextPromptTokens: 0 };

describe("SessionBudgetStore metrics", () => {
  it("returns zeros before any events", async () => {
    const budgetStore = makeSessionBudgetStore(makeTmpDir(), newSessionId());

    expect(await budgetStore.metrics()).toEqual(zero);

    budgetStore.dispose();
  });

  it("returns the cost and the tokens after result events", async () => {
    const budgetStore = makeSessionBudgetStore(makeTmpDir(), newSessionId());

    await budgetStore.recordRuntimeEvent(resultEvent(0.025, 1000, 500));
    await budgetStore.recordRuntimeEvent(resultEvent(0.04, 1200, 700));

    expect(await budgetStore.metrics()).toEqual({ ...zero, cost: 0.04, billedCost: 0.04, tokens: 1900 });
    expect(await budgetStore.getTokensUsed()).toBe(1900);
    expect(await budgetStore.getOutputTokensUsed()).toBe(700);

    budgetStore.dispose();
  });

  it("preserves unavailable v5 prices while retaining known cost and tokens", async () => {
    const budgetStore = makeSessionBudgetStore(makeTmpDir(), newSessionId());
    await budgetStore.recordRuntimeEvent(committedUsageEvent({ attemptId: "00000000-0000-4000-8000-000000000010", classification: "real_spend", price: { kind: "priced", estimatedUsd: 0.4, rateCard: { inputPerMillionUsd: 1 }, provenance: "live" }, inputTokens: 20, outputTokens: 8 }));
    await budgetStore.recordRuntimeEvent(committedUsageEvent({ attemptId: "00000000-0000-4000-8000-000000000011", classification: "real_spend", price: { kind: "unavailable", reason: "missing-rate-card" }, inputTokens: 30, outputTokens: 9 }));
    await budgetStore.recordRuntimeEvent(committedUsageEvent({ attemptId: "00000000-0000-4000-8000-000000000012", classification: "subscription_equivalent", price: { kind: "unavailable", reason: "missing-rate-card" }, inputTokens: 40, outputTokens: 10 }));

    expect(await budgetStore.metrics()).toEqual({ ...zero, cost: 0.4, billedCost: 0.4, tokens: 117, priceUnavailable: true });
    budgetStore.dispose();
  });

  it("accumulates correctly across recordProcessStarted resets", async () => {
    const budgetStore = makeSessionBudgetStore(makeTmpDir(), newSessionId());

    await budgetStore.recordRuntimeEvent(resultEvent(0.02, 100, 50));
    await budgetStore.recordProcessStarted();
    await budgetStore.recordRuntimeEvent(resultEvent(0.03, 200, 75));

    expect(await budgetStore.metrics()).toEqual({ ...zero, cost: 0.05, billedCost: 0.05, tokens: 425 });

    budgetStore.dispose();
  });

  it("carries the measured context with the cost", async () => {
    const budgetStore = makeSessionBudgetStore(makeTmpDir(), newSessionId());

    await budgetStore.recordRuntimeEvent(resultEvent(0.02, 10, 5));
    await budgetStore.recordContextUtilization(90_000, 1_000_000);

    expect(await budgetStore.metrics()).toEqual({ ...zero, cost: 0.02, billedCost: 0.02, tokens: 15, contextPercent: 9, contextPromptTokens: 90_000 });

    budgetStore.dispose();
  });
});
