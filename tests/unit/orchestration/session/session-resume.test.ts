/** Session metadata lifecycle and budget continuity tests. */

import { describe, it, expect, afterEach } from "bun:test";

import { createSessionManager } from "../../../../src/orchestration/session/manager";
import { makeSessionBudgetStore, readBudgetSummary } from "./_budget-store-fixtures";
import {
  cleanupStores,
  makeDeps,
  makeTmpDir,
} from "./_session-resume-fixtures";
import { publishTestWorkflow } from "./_session-manager-fixtures";

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(cleanupStores);

describe("budget continuity across session resume", () => {
  it("persists budget usage and reads it back from SQLite projections", async () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));
    const sessionId = await publishTestWorkflow(manager, { workflowDefinitionId: "plan", name: "Budget Test" });

    const budgetStore1 = makeSessionBudgetStore(baseDir, sessionId);

    // Simulate cumulative provider turn-completion usage.
    // usage.input_tokens / output_tokens and total_cost_usd are cumulative within a process.
    await budgetStore1.recordRuntimeEvent({
      type: "model.turn.completed",
      data: {
        total_cost_usd: 0.05,
        usage: { input_tokens: 1000, output_tokens: 500 },
      },
    });
    await budgetStore1.recordRuntimeEvent({
      type: "model.turn.completed",
      data: {
        total_cost_usd: 0.08,
        usage: { input_tokens: 1800, output_tokens: 800 },
      },
    });
    await budgetStore1.recordInvocation();
    await budgetStore1.recordInvocation();

    // Close the first store before reopening the projection.
    await budgetStore1.dispose();

    let budget = await readBudgetSummary(sessionId, baseDir);
    expect(budget.totalCost).toBeCloseTo(0.08, 4);
    expect(budget.totalTokens).toBe(2600); // (1000+500) + (800+300) from cumulative deltas

    // Create a new budget store with the same sessionId
    // (simulates what happens on resume — store reads from SQLite facts)
    const budgetStore2 = makeSessionBudgetStore(baseDir, sessionId);

    // Add more usage in the resumed session
    await budgetStore2.recordRuntimeEvent({
      type: "model.turn.completed",
      data: {
        total_cost_usd: 0.02,
        usage: { input_tokens: 400, output_tokens: 200 },
      },
    });
    await budgetStore2.recordInvocation();
    await budgetStore2.dispose();

    budget = await readBudgetSummary(sessionId, baseDir);
    expect(budget.totalCost).toBeCloseTo(0.10, 4); // 0.08 + 0.02
    expect(budget.totalTokens).toBe(3200); // 2600 + 600
  });
});
