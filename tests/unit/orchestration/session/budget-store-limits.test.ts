import { describe, it, expect, afterEach } from "bun:test";

import {
  cleanupTmpRoot,
  makeTmpDir,
  newSessionId,
  makeSessionBudgetStore,
  resultEvent,
  committedUsageEvent,
  unlimitedLimits,
} from "./_budget-store-fixtures";
import type { EmitFn } from "../../../../src/infra/event-bus";

afterEach(() => {
  cleanupTmpRoot();
});

// ---------------------------------------------------------------------------
// isExhausted() — budget limit checking
// ---------------------------------------------------------------------------

describe("SessionBudgetStore — isExhausted", () => {
  it("returns false when all limits are unlimited", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const budgetStore = makeSessionBudgetStore(baseDir, sessionId);

    await budgetStore.recordInvocation();
    await budgetStore.recordRuntimeEvent(resultEvent(0.50, 10000, 5000));

    expect(await budgetStore.isExhausted(unlimitedLimits())).toBe(false);
    budgetStore.dispose();
  });

  it("fails safe when a cost limit exists and a committed v5 price is unavailable", async () => {
    const budgetStore = makeSessionBudgetStore(makeTmpDir(), newSessionId());
    await budgetStore.recordRuntimeEvent(committedUsageEvent({ attemptId: "00000000-0000-4000-8000-000000000020", classification: "real_spend", price: { kind: "unavailable", reason: "missing-rate-card" } }));

    expect(await budgetStore.isExhausted(unlimitedLimits({ max_cost_usd: 10 }))).toBe(true);
    expect(await budgetStore.isExhausted(unlimitedLimits())).toBe(false);
    budgetStore.dispose();
  });
});

// ---------------------------------------------------------------------------
// Budget event emission via emitter
// ---------------------------------------------------------------------------

describe("SessionBudgetStore — budget event emission", () => {
  it("emits budgetExhausted once when budget transitions to exhausted", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();

    const calls: { type: string; payload: unknown }[] = [];
    const mockEmit: EmitFn = (type, payload) => {
      calls.push({ type, payload });
    };

    const budgetStore = makeSessionBudgetStore(baseDir, sessionId, { emitter: mockEmit });

    const limits = unlimitedLimits({ max_invocations: 2 });

    // Not exhausted yet
    await budgetStore.recordInvocation();
    expect(await budgetStore.isExhausted(limits)).toBe(false);
    expect(calls).toHaveLength(0);

    // Reaches limit — should emit once
    await budgetStore.recordInvocation();
    expect(await budgetStore.isExhausted(limits)).toBe(true);
    expect(calls).toMatchObject([
      { type: "budget.exhausted", payload: { sessionId, data: { reason: expect.stringContaining("Attempt limit reached") } } },
    ]);

    budgetStore.dispose();
  });

  it("does NOT emit budgetExhausted on subsequent isExhausted calls", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();

    const calls: { type: string; payload: unknown }[] = [];
    const mockEmit: EmitFn = (type, payload) => {
      calls.push({ type, payload });
    };

    const budgetStore = makeSessionBudgetStore(baseDir, sessionId, { emitter: mockEmit });

    const limits = unlimitedLimits({ max_invocations: 1 });

    await budgetStore.recordInvocation();

    // First call — emits
    expect(await budgetStore.isExhausted(limits)).toBe(true);
    expect(calls).toHaveLength(1);

    // Subsequent calls — should NOT emit again
    expect(await budgetStore.isExhausted(limits)).toBe(true);
    expect(await budgetStore.isExhausted(limits)).toBe(true);
    expect(await budgetStore.isExhausted(limits)).toBe(true);
    expect(calls).toHaveLength(1); // still just 1

    budgetStore.dispose();
  });

  it("emits correct reason for token limit exhaustion", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();

    const calls: { type: string; payload: unknown }[] = [];
    const mockEmit: EmitFn = (type, payload) => {
      calls.push({ type, payload });
    };

    const budgetStore = makeSessionBudgetStore(baseDir, sessionId, { emitter: mockEmit });

    await budgetStore.recordRuntimeEvent(resultEvent(0.01, 5000, 3000)); // 8000 tokens

    const limits = unlimitedLimits({ max_tokens: 5000 });
    expect(await budgetStore.isExhausted(limits)).toBe(true);

    const exhaustedCalls = calls.filter(c => c.type === "budget.exhausted");
    expect(exhaustedCalls).toMatchObject([{ payload: { data: { reason: expect.stringContaining("Token limit reached") } } }]);

    budgetStore.dispose();
  });
});
