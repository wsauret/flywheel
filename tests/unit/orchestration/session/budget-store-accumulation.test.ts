import { describe, it, expect, afterEach } from "bun:test";

import {
  assistantEvent,
  cleanupTmpRoot,
  makeTmpDir,
  newSessionId,
  makeSessionBudgetStore,
  makeSessionStores,
  readBudgetSummary,
  resultEvent,
  resultNoCost,
  resultNoUsage,
  usageEvent,
} from "./_budget-store-fixtures";
import { createBudgetProjection } from "../../../../src/orchestration/session/budget-projection";

afterEach(() => {
  cleanupTmpRoot();
});

// ---------------------------------------------------------------------------
// Cost accumulation across multiple events
// ---------------------------------------------------------------------------

describe("SessionBudgetStore — accumulation", () => {
  const terminalUsage = (cost: number, billedCost: number, input: number, output: number, parentToolUseId?: string) => ({
    type: "model.turn.completed" as const,
    version: 1 as const,
    actor: "provider" as const,
    payload: {
      isError: false,
      totalCostUsd: cost,
      billedCostUsd: billedCost,
      usage: { input_tokens: input, output_tokens: output },
      ...(parentToolUseId ? { parentToolUseId } : {}),
    },
  });

  const committedV4 = (usageEntryId: string, parentToolUseId?: string) => ({
    type: "model.usage.measured" as const,
    version: 4 as const,
    actor: "provider" as const,
    payload: {
      usageEntryId,
      costUsdDelta: 0.04,
      billedCostUsdDelta: 0.03,
      inputTokensDelta: 100,
      outputTokensDelta: 20,
      cacheReadTokensDelta: 0,
      cacheCreateTokensDelta: 0,
      reasoningTokensDelta: 0,
      ...(parentToolUseId ? { parentToolUseId } : {}),
      budgetStreamId: "session:committed",
    },
  });

  const committedV5 = (attemptId: string, parentToolUseId?: string) => ({
    type: "model.usage.measured" as const,
    version: 5 as const,
    actor: "provider" as const,
    payload: {
      attemptId,
      occurredAt: "2025-01-15T12:00:00.000Z",
      profileId: "profile-a",
      attribution: { kind: "candidate" as const, providerId: "openai_api" },
      spendMode: "direct_api" as const,
      credentialLineage: "00000000-0000-4000-8000-000000000002",
      model: "gpt-5",
      tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
      classification: "real_spend" as const,
      price: { kind: "priced" as const, estimatedUsd: 0.04, rateCard: {}, provenance: "test" },
      currency: "USD" as const,
      ...(parentToolUseId ? { parentToolUseId } : {}),
      budgetStreamId: "session:committed",
    },
  });

  it("accumulates cost from mixed events (ignores non-cost events)", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const budgetStore = makeSessionBudgetStore(baseDir, sessionId);

    // Cumulative: 0.01, then 0.03 (delta = 0.02)
    await budgetStore.recordRuntimeEvent(resultEvent(0.01));
    await budgetStore.recordRuntimeEvent(assistantEvent("some output"));
    await budgetStore.recordRuntimeEvent(resultNoCost());
    await budgetStore.recordRuntimeEvent(resultEvent(0.03));

    expect(await budgetStore.getTotalCost()).toBeCloseTo(0.03, 10);
    budgetStore.dispose();
  });

  it("accumulates live usage readings and treats the final result event as a no-op reconciliation", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);
    await stores.record(usageEvent(0.01, 100, 50));
    await stores.record(usageEvent(0.03, 300, 150));
    await stores.record({ type: "model.turn.completed", version: 1, actor: "provider", payload: { isError: false, totalCostUsd: 0.03, billedCostUsd: 0.03, usage: { input_tokens: 300, output_tokens: 150 } } });
    const state = await createBudgetProjection(stores.projectionReader, sessionId).replay();
    expect(state.totalCost).toBeCloseTo(0.03, 10);
    expect(state.totalInputTokens + state.totalOutputTokens).toBe(450);
    stores.writer.dispose();
    stores.close();
  });

  it("folds interleaved parent and subagent streams without corrupting baselines", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);
    await stores.record(usageEvent(0.01, 100, 10));
    await stores.record(usageEvent(0.02, 200, 20, "toolu_child_a"));
    await stores.record(usageEvent(0.05, 500, 50, "toolu_child_b"));
    await stores.record(usageEvent(0.04, 400, 40, "toolu_child_a"));
    await stores.record(usageEvent(0.02, 200, 20));
    const state = await createBudgetProjection(stores.projectionReader, sessionId).replay();
    expect(state.totalCost).toBeCloseTo(0.11, 10);
    expect(state.totalInputTokens + state.totalOutputTokens).toBe(1210);
    stores.writer.dispose();
    stores.close();
  });

  it("process restart resets only the session stream baseline, not running subagent streams", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);
    await stores.record(usageEvent(0.03, 300, 30));
    await stores.record(usageEvent(0.10, 1000, 100, "toolu_child"));
    await stores.record({ type: "budget.process.started", version: 1, actor: "flywheel", payload: {} });
    await stores.record(usageEvent(0.01, 100, 10));
    await stores.record(usageEvent(0.12, 1200, 120, "toolu_child"));
    const state = await createBudgetProjection(stores.projectionReader, sessionId).replay();
    expect(state.totalCost).toBeCloseTo(0.16, 10);
    stores.writer.dispose();
    stores.close();
  });

  it("splits billed cost from subscription-covered cost", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);
    await stores.record(usageEvent(0.05, 100, 50, undefined, 0));
    await stores.record(usageEvent(0.08, 200, 100, undefined, 0.03));
    const state = await createBudgetProjection(stores.projectionReader, sessionId).replay();
    expect(state.totalCost).toBeCloseTo(0.08, 10);
    expect(state.totalBilledCost).toBeCloseTo(0.03, 10);
    stores.writer.dispose();
    stores.close();
  });

  it("preserves pre-split usage as estimated value without fabricating API spend", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);

    await stores.record({
      type: "model.usage.measured",
      version: 1,
      actor: "provider",
      payload: {
        totalCostUsd: 0.04,
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        reasoningTokens: 0,
      },
    });
    stores.writer.dispose();
    stores.close();

    const summary = await readBudgetSummary(sessionId, baseDir);
    expect(summary.totalCost).toBeCloseTo(0.04, 10);
    expect(summary.totalBilledCost).toBe(0);
  });

  it("retires completed subagent baselines", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);

    for (let index = 0; index < 50; index++) {
      const parentToolUseId = `toolu_child_${index}`;
      await stores.record({
        type: "model.usage.measured",
        version: 2,
        actor: "provider",
        payload: {
          totalCostUsd: 0.01,
          billedCostUsd: 0,
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
          reasoningTokens: 0,
          parentToolUseId,
        },
      });
      await stores.record({
        type: "budget.stream.completed",
        version: 1,
        actor: "flywheel",
        payload: { parentToolUseId },
      });
    }

    const state = await createBudgetProjection(stores.projectionReader, sessionId).replay();
    expect(state.totalCost).toBeCloseTo(0.5, 10);
    expect(state.streamBaselines).toEqual({});
    stores.writer.dispose();
    stores.close();
  });

  it("accumulates an interleaved Learning Review stream without corrupting foreground cost", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);

    for (const fact of [
      { type: "model.usage.measured", version: 3, actor: "provider", payload: { totalCostUsd: 0.02, billedCostUsd: 0.01, inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 } },
      { type: "model.usage.measured", version: 3, actor: "provider", payload: { totalCostUsd: 0.03, billedCostUsd: 0.03, inputTokens: 200, outputTokens: 30, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0, budgetStreamId: "learning-review:review-1" } },
      { type: "model.usage.measured", version: 3, actor: "provider", payload: { totalCostUsd: 0.05, billedCostUsd: 0.02, inputTokens: 250, outputTokens: 50, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0 } },
      { type: "model.usage.measured", version: 3, actor: "provider", payload: { totalCostUsd: 0.07, billedCostUsd: 0.07, inputTokens: 500, outputTokens: 70, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0, budgetStreamId: "learning-review:review-1" } },
      { type: "budget.stream.completed", version: 2, actor: "flywheel", payload: { budgetStreamId: "learning-review:review-1" } },
    ] as const) await stores.record(fact);

    const state = await createBudgetProjection(stores.projectionReader, sessionId).replay();
    expect(state.totalCost).toBeCloseTo(0.12, 10);
    expect(state.totalBilledCost).toBeCloseTo(0.09, 10);
    expect(state.streamBaselines).toEqual({ "": expect.any(Object) });
    stores.writer.dispose();
    stores.close();
  });

  it("does not reset billed cumulative state for a legacy terminal fact", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);
    await stores.record(usageEvent(0.03, 100, 40));
    await stores.record({ type: "model.turn.completed", version: 1, actor: "provider", payload: { isError: false, totalCostUsd: 0.03, usage: { input_tokens: 100, output_tokens: 40 } } });
    await stores.record(usageEvent(0.04, 120, 50));
    const state = await createBudgetProjection(stores.projectionReader, sessionId).replay();
    expect(state.totalCost).toBeCloseTo(0.04, 10);
    expect(state.totalBilledCost).toBeCloseTo(0.04, 10);
    expect(state.totalInputTokens).toBe(120);
    expect(state.totalOutputTokens).toBe(50);
    stores.writer.dispose();
    stores.close();
  });

  it("does not add a matching cumulative terminal after a committed v4 entry", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);
    await stores.record(committedV4("usage-entry-1"));
    await stores.record(terminalUsage(0.04, 0.03, 100, 20));

    const state = await createBudgetProjection(stores.projectionReader, sessionId).replay();
    expect(state.totalCost).toBeCloseTo(0.04, 10);
    expect(state.totalBilledCost).toBeCloseTo(0.03, 10);
    expect(state.totalInputTokens).toBe(100);
    expect(state.totalOutputTokens).toBe(20);
    stores.writer.dispose();
    stores.close();
  });

  it("does not add a matching cumulative terminal after a committed v5 entry", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);
    await stores.record(committedV5("00000000-0000-4000-8000-000000000020"));
    await stores.record(terminalUsage(0.04, 0.04, 100, 20));

    const state = await createBudgetProjection(stores.projectionReader, sessionId).replay();
    expect(state.totalCost).toBeCloseTo(0.04, 10);
    expect(state.totalBilledCost).toBeCloseTo(0.04, 10);
    expect(state.totalInputTokens).toBe(100);
    expect(state.totalOutputTokens).toBe(20);
    stores.writer.dispose();
    stores.close();
  });

  it("applies committed authority only to its matching terminal stream", async () => {
    const baseDir = makeTmpDir();
    const committedParentSessionId = newSessionId();
    const committedParentStores = makeSessionStores(baseDir, committedParentSessionId);
    await committedParentStores.record(committedV4("usage-entry-2"));
    await committedParentStores.record(committedV4("usage-entry-2"));
    await committedParentStores.record(terminalUsage(0.04, 0.03, 100, 20));
    await committedParentStores.record(terminalUsage(0.02, 0.02, 30, 5, "toolu_legacy"));

    const committedParentState = await createBudgetProjection(committedParentStores.projectionReader, committedParentSessionId).replay();
    expect(committedParentState.totalCost).toBeCloseTo(0.06, 10);
    expect(committedParentState.totalBilledCost).toBeCloseTo(0.05, 10);
    expect(committedParentState.totalInputTokens).toBe(130);
    expect(committedParentState.totalOutputTokens).toBe(25);
    committedParentStores.writer.dispose();
    committedParentStores.close();

    const legacyParentSessionId = newSessionId();
    const legacyParentStores = makeSessionStores(baseDir, legacyParentSessionId);
    await legacyParentStores.record(terminalUsage(0.02, 0.02, 30, 5));
    await legacyParentStores.record(committedV5("00000000-0000-4000-8000-000000000021", "toolu_committed"));
    await legacyParentStores.record(terminalUsage(0.04, 0.04, 100, 20, "toolu_committed"));

    const legacyParentState = await createBudgetProjection(legacyParentStores.projectionReader, legacyParentSessionId).replay();
    expect(legacyParentState.totalCost).toBeCloseTo(0.06, 10);
    expect(legacyParentState.totalBilledCost).toBeCloseTo(0.06, 10);
    expect(legacyParentState.totalInputTokens).toBe(130);
    expect(legacyParentState.totalOutputTokens).toBe(25);
    legacyParentStores.writer.dispose();
    legacyParentStores.close();
  });

  it("adds each committed usage entry once without cumulative baselines", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);
    const entry = (attemptId: string, price: { kind: "priced"; estimatedUsd: number; rateCard: { [key: string]: number }; provenance: string } | { kind: "unavailable"; reason: string }, classification: "real_spend" | "subscription_equivalent", input: number, output: number) => ({
      type: "model.usage.measured" as const,
      version: 5 as const,
      actor: "provider" as const,
      payload: {
        attemptId,
        occurredAt: "2025-01-15T12:00:00.000Z",
        profileId: "profile-a",
        attribution: { kind: "candidate" as const, providerId: "openai_api", ...(classification === "subscription_equivalent" ? { instanceId: "account-a" } : {}) },
        spendMode: classification === "subscription_equivalent" ? "included" as const : "direct_api" as const,
        credentialLineage: "00000000-0000-4000-8000-000000000002",
        model: "gpt-5",
        tokens: { input, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
        classification,
        price,
        currency: "USD" as const,
        budgetStreamId: "session:committed",
      },
    });

    await stores.record(entry("00000000-0000-4000-8000-000000000010", { kind: "priced", estimatedUsd: 0.05, rateCard: {}, provenance: "test" }, "subscription_equivalent", 100, 20));
    await stores.record(entry("00000000-0000-4000-8000-000000000011", { kind: "unavailable", reason: "missing-rate-card" }, "real_spend", 30, 4));
    await stores.record(entry("00000000-0000-4000-8000-000000000010", { kind: "priced", estimatedUsd: 0.05, rateCard: {}, provenance: "test" }, "subscription_equivalent", 100, 20));

    const state = await createBudgetProjection(stores.projectionReader, sessionId).replay();
    expect(state.totalCost).toBeCloseTo(0.05, 10);
    expect(state.totalBilledCost).toBe(0);
    expect(state.totalInputTokens).toBe(130);
    expect(state.totalOutputTokens).toBe(24);
    expect(state.streamBaselines).toEqual({});
    expect(state.settledUsageEntryIds).toEqual({
      "00000000-0000-4000-8000-000000000010": true,
      "00000000-0000-4000-8000-000000000011": true,
    });
    stores.writer.dispose();
    stores.close();
  });

  it("leaves a published state unchanged when a later catch-up settles more entries", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);
    const projection = createBudgetProjection(stores.projectionReader, sessionId);
    await stores.record(committedV5("00000000-0000-4000-8000-000000000030"));
    const earlier = await projection.replay();
    await stores.record(committedV5("00000000-0000-4000-8000-000000000031", "toolu_child"));
    await stores.record(committedV4("usage-entry-later"));
    const later = await projection.replay();

    expect(earlier.settledUsageEntryIds).toEqual({ "00000000-0000-4000-8000-000000000030": true });
    expect(earlier.committedUsageStreams).toEqual({ "": true });
    expect(later.settledUsageEntryIds).toEqual({
      "00000000-0000-4000-8000-000000000030": true,
      "00000000-0000-4000-8000-000000000031": true,
      "usage-entry-later": true,
    });
    expect(later.committedUsageStreams).toEqual({ "": true, toolu_child: true });
    expect(later.totalInputTokens).toBe(300);
    stores.writer.dispose();
    stores.close();
  });

  it("copies no usage id set for a catch-up that settles no usage entry", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);
    const projection = createBudgetProjection(stores.projectionReader, sessionId);
    await stores.record(committedV5("00000000-0000-4000-8000-000000000040"));
    const earlier = await projection.replay();
    await stores.record(terminalUsage(0.01, 0.01, 100, 50, "toolu_uncommitted"));
    const later = await projection.replay();

    expect(later.totalCost).not.toBe(earlier.totalCost);
    expect(later.settledUsageEntryIds).toBe(earlier.settledUsageEntryIds);
    expect(later.committedUsageStreams).toBe(earlier.committedUsageStreams);
    stores.writer.dispose();
    stores.close();
  });

});

// ---------------------------------------------------------------------------
// Token tracking
// ---------------------------------------------------------------------------

describe("SessionBudgetStore — token tracking", () => {
  it("tracks output tokens separately from combined token count", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const budgetStore = makeSessionBudgetStore(baseDir, sessionId);

    // Cumulative values: input=1000, output=500, then input=1800, output=800
    await budgetStore.recordRuntimeEvent(resultEvent(0.01, 1000, 500));
    await budgetStore.recordRuntimeEvent(resultEvent(0.02, 1800, 800));

    expect(await budgetStore.getOutputTokensUsed()).toBe(800); // 500 + (800-500)
    expect(await budgetStore.getTokensUsed()).toBe(2600); // (1000+500) + (800+300)
    budgetStore.dispose();
  });

  it("returns 0 tokens when usage field is absent", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const budgetStore = makeSessionBudgetStore(baseDir, sessionId);

    await budgetStore.recordRuntimeEvent(resultNoUsage(0.01));

    expect(await budgetStore.getTokensUsed()).toBe(0);
    expect(await budgetStore.getTotalCost()).toBe(0.01); // cost still tracked
    budgetStore.dispose();
  });

  it("cost-only result events (no usage) do not affect token baselines", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const budgetStore = makeSessionBudgetStore(baseDir, sessionId);

    await budgetStore.recordRuntimeEvent(resultEvent(0.01, 500, 200)); // 700 tokens
    // cost-only result within the same process (cumulative cost increased)
    await budgetStore.recordRuntimeEvent(resultNoUsage(0.015));
    expect(await budgetStore.getTokensUsed()).toBe(700); // tokens unchanged
    expect(await budgetStore.getTotalCost()).toBeCloseTo(0.015, 10); // cost updated to cumulative value
    budgetStore.dispose();
  });

  it("total_cost_usd is accurate even when cache tokens are present", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const budgetStore = makeSessionBudgetStore(baseDir, sessionId);

    // total_cost_usd already accounts for cache pricing
    await budgetStore.recordRuntimeEvent(resultEvent(0.031, 1000, 500, 15_000, 2_000));

    // Cost should be exactly what the agent reported
    expect(await budgetStore.getTotalCost()).toBeCloseTo(0.031, 10);
    // Token budget reflects only non-cache tokens
    expect(await budgetStore.getTokensUsed()).toBe(1500);
    budgetStore.dispose();
  });
});
