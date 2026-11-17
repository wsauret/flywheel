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
import type { BudgetLimits } from "../../../../src/workflows/budget";

afterEach(() => {
  cleanupTmpRoot();
});

/** A budget store with `budgetLimits`, and the events it emits. */
function limitedStore(budgetLimits: BudgetLimits) {
  const sessionId = newSessionId();
  const calls: { type: string; payload: unknown }[] = [];
  const budgetStore = makeSessionBudgetStore(makeTmpDir(), sessionId, {
    budgetLimits,
    emitter: (type, payload) => { calls.push({ type, payload }); },
  });
  const exhausted = () => calls.filter((call) => call.type === "budget.exhausted");
  return { sessionId, budgetStore, exhausted };
}

// ---------------------------------------------------------------------------
// budget.exhausted on the push path: each metrics change checks the limits
// ---------------------------------------------------------------------------

describe("SessionBudgetStore: budget.exhausted", () => {
  it("emits nothing when all limits are unlimited", async () => {
    const { budgetStore, exhausted } = limitedStore(unlimitedLimits());

    await budgetStore.recordInvocation();
    await budgetStore.recordRuntimeEvent(resultEvent(0.50, 10000, 5000));

    expect(exhausted()).toEqual([]);
    budgetStore.dispose();
  });

  it("fails safe when a cost limit exists and a committed v5 price is unavailable", async () => {
    const { budgetStore, exhausted } = limitedStore(unlimitedLimits({ max_cost_usd: 10 }));

    await budgetStore.recordRuntimeEvent(committedUsageEvent({ attemptId: "00000000-0000-4000-8000-000000000020", classification: "real_spend", price: { kind: "unavailable", reason: "missing-rate-card" } }));

    expect(exhausted()).toMatchObject([{ payload: { data: { reason: expect.stringContaining("Cost limit cannot be enforced") } } }]);
    budgetStore.dispose();
  });

  it("emits once with the token limit reason, however many later changes stay over the limit", async () => {
    const { sessionId, budgetStore, exhausted } = limitedStore(unlimitedLimits({ max_tokens: 5000 }));

    await budgetStore.recordRuntimeEvent(resultEvent(0.01, 2000, 1000)); // 3000 tokens
    expect(exhausted()).toEqual([]);

    await budgetStore.recordRuntimeEvent(resultEvent(0.02, 5000, 3000)); // 8000 tokens
    await budgetStore.recordRuntimeEvent(resultEvent(0.03, 6000, 4000)); // 10000 tokens

    expect(exhausted()).toMatchObject([
      { type: "budget.exhausted", payload: { sessionId, data: { reason: expect.stringContaining("Token limit reached") } } },
    ]);
    budgetStore.dispose();
  });
});
