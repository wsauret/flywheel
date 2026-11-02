import { describe, expect, test } from "bun:test";
import { asAsyncEventReadSurface } from "../../../src/infra/event-store-types.js";
import { budgetExhaustionReason, workflowBudgetRefusal, type BudgetLimits } from "../../../src/workflows/budget.js";
import { inMemoryEventReader } from "../../helpers/in-memory-event-reader.js";
import { initializedWorkflowRoot } from "../../helpers/workflow-root-fixtures.js";

describe("budgetExhaustionReason", () => {
  const unlimited: BudgetLimits = {
    max_invocations: 0,
    max_tokens: null,
    max_wall_clock_minutes: null,
  };

  test("reports invocation limits before token limits", () => {
    expect(budgetExhaustionReason({
      max_invocations: 1,
      max_tokens: 100,
      max_wall_clock_minutes: null,
    }, {
      invocationsUsed: 1,
      tokensUsed: 100,
    })).toBe("Attempt limit reached (1/1)");
  });

  test("counts reported tokens only and names the unmeasured requests", () => {
    expect(budgetExhaustionReason({ ...unlimited, max_tokens: 100 }, { invocationsUsed: 0, tokensUsed: 120, unmeasuredRequests: 2 }))
      .toBe("Token limit reached (120/100 reported tokens; 2 unmeasured requests added no tokens)");
    expect(budgetExhaustionReason({ ...unlimited, max_tokens: 100 }, { invocationsUsed: 0, tokensUsed: 90, unmeasuredRequests: 5 })).toBeNull();
  });

  test("reports a wall-clock limit at its exact boundary", () => {
    expect(budgetExhaustionReason({ ...unlimited, max_wall_clock_minutes: 2 }, {
      invocationsUsed: 0,
      tokensUsed: 0,
      elapsedMs: 2 * 60_000,
    })).toBe("Wall-clock limit reached (2/2 minutes)");
  });

  test("applies no wall-clock limit to work without a workflow launch", () => {
    expect(budgetExhaustionReason({ ...unlimited, max_wall_clock_minutes: 1 }, {
      invocationsUsed: 0,
      tokensUsed: 0,
    })).toBeNull();
  });
});

describe("workflowBudgetRefusal", () => {
  const launchedAt = Date.parse("2026-05-22T10:00:00.000Z");
  const usage = { getInvocationsUsed: async () => 0, getTokensUsed: async () => ({ reported: 0, unmeasuredRequests: 0 }) };
  const budget = { max_invocations: 0, max_tokens: 0, max_wall_clock_minutes: 1 };

  function launchedWorkflow(timestamp: number) {
    return asAsyncEventReadSurface(inMemoryEventReader([{
      ...initializedWorkflowRoot,
      aggregateId: "workflow:wf-1",
      sessionId: "wf-1",
      timestamp,
      position: 1,
      id: "event-1",
      seq: 0,
    }]));
  }

  test("pauses a workflow whose durable launch is older than the wall-clock limit", async () => {
    expect(await workflowBudgetRefusal({
      budget,
      usage,
      reader: launchedWorkflow(launchedAt),
      sessionId: "wf-1",
      nowMs: launchedAt + 3 * 60_000,
    })).toBe("Budget exhausted: Wall-clock limit reached (3/1 minutes). The workflow paused before its next attempt.");
  });

  test("reads no workflow token usage when no token limit is set", async () => {
    const reads: string[] = [];
    expect(await workflowBudgetRefusal({
      budget,
      usage: { ...usage, getTokensUsed: async () => { reads.push("tokens"); return { reported: 0, unmeasuredRequests: 0 }; } },
      reader: launchedWorkflow(launchedAt),
      sessionId: "wf-1",
      nowMs: launchedAt + 30_000,
    })).toBeNull();
    expect(reads).toEqual([]);
  });

  test("admits an attempt inside the wall-clock limit", async () => {
    expect(await workflowBudgetRefusal({
      budget,
      usage,
      reader: launchedWorkflow(launchedAt),
      sessionId: "wf-1",
      nowMs: launchedAt + 30_000,
    })).toBeNull();
  });

  test("admits the first attempt of a launch that has no committed root yet", async () => {
    expect(await workflowBudgetRefusal({
      budget,
      usage,
      reader: asAsyncEventReadSurface(inMemoryEventReader([])),
      sessionId: "wf-1",
      nowMs: launchedAt + 3 * 60_000,
    })).toBeNull();
  });
});
