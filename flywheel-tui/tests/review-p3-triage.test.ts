import { describe, expect, test, mock, beforeEach } from "bun:test";
import { randomUUID } from "crypto";
import type { Step, Queue } from "../src/queue/types";
import { createQueue } from "../src/queue/queue";
import { createReviewP3TriageHook, REVIEW_P3_DIRECTIVE } from "../src/queue/review-p3-triage";
import { QuestionRejectedError } from "../src/controller/question-service";

function makeStep(overrides: Partial<Step> = {}): Step {
  return { id: randomUUID(), type: "work", title: "Test", status: "pending", ...overrides };
}

function makeQueue(steps: Step[]): Queue {
  return createQueue(steps);
}

describe("createReviewP3TriageHook", () => {
  test("no-op on non-review steps", async () => {
    const hook = createReviewP3TriageHook({});
    const step = makeStep({ type: "work" });
    const queue = makeQueue([step]);
    const result = await hook(step, "completed", queue, null);
    expect(result.continueExecution).toBe(false);
  });

  test("no-op on review steps without dispatch-reviewers hint", async () => {
    const hook = createReviewP3TriageHook({});
    const step = makeStep({ type: "review", dispatcherHint: "consolidate-review" });
    const queue = makeQueue([step]);
    const result = await hook(step, "completed", queue, {});
    expect(result.continueExecution).toBe(false);
  });

  test("no-op on failed steps", async () => {
    const hook = createReviewP3TriageHook({});
    const step = makeStep({ type: "review", dispatcherHint: "dispatch-reviewers" });
    const queue = makeQueue([step]);
    const result = await hook(step, "failed", queue, {});
    expect(result.continueExecution).toBe(false);
  });

  test("no-op when no handoff data", async () => {
    const hook = createReviewP3TriageHook({});
    const step = makeStep({ type: "review", dispatcherHint: "dispatch-reviewers" });
    const queue = makeQueue([step]);
    const result = await hook(step, "completed", queue, null);
    expect(result.continueExecution).toBe(false);
  });

  test("no-op when no P3 findings in handoff", async () => {
    const hook = createReviewP3TriageHook({});
    const step = makeStep({ type: "review", dispatcherHint: "dispatch-reviewers" });
    const queue = makeQueue([step]);
    const result = await hook(step, "completed", queue, { summary: "test" });
    expect(result.continueExecution).toBe(false);
  });

  test("auto-directive when QuestionService not available", async () => {
    const hook = createReviewP3TriageHook({});
    const step = makeStep({ type: "review", dispatcherHint: "dispatch-reviewers" });
    const queue = makeQueue([step]);
    const handoff = {
      p3_findings: [
        { description: "Consider caching", location: "src/api.ts:10", suggestion: "Add LRU cache" },
      ],
    };
    await hook(step, "completed", queue, handoff);
    expect((step as any)._p3Triage).toEqual({ directive: REVIEW_P3_DIRECTIVE });
  });

  test("presents triage to user via QuestionService", async () => {
    const mockQS = {
      ask: mock(() => Promise.resolve([["Consider caching"]])),
      dismiss: mock(() => {}),
    };
    const hook = createReviewP3TriageHook({ questionService: mockQS as any });
    const step = makeStep({ type: "review", dispatcherHint: "dispatch-reviewers" });
    const queue = makeQueue([step]);
    const handoff = {
      p3_findings: [
        { description: "Consider caching", location: "src/api.ts:10", suggestion: "Add LRU cache" },
        { description: "Rename variable", location: "src/utils.ts:5", suggestion: "Use camelCase" },
      ],
    };
    await hook(step, "completed", queue, handoff);
    expect(mockQS.ask).toHaveBeenCalledTimes(1);
    const triage = (step as any)._p3Triage;
    expect(triage.source).toBe("user");
    expect(triage.included.length).toBe(1);
    expect(triage.excluded.length).toBe(1);
  });

  test("auto-directive when user dismisses triage", async () => {
    const mockQS = {
      ask: mock(() => Promise.reject(new QuestionRejectedError())),
      dismiss: mock(() => {}),
    };
    const hook = createReviewP3TriageHook({ questionService: mockQS as any });
    const step = makeStep({ type: "review", dispatcherHint: "dispatch-reviewers" });
    const queue = makeQueue([step]);
    const handoff = {
      p3_findings: [
        { description: "Consider caching", location: "src/api.ts:10", suggestion: "Add LRU cache" },
      ],
    };
    await hook(step, "completed", queue, handoff);
    expect((step as any)._p3Triage).toEqual({ directive: REVIEW_P3_DIRECTIVE });
  });

  test("only triggers once per hook instance", async () => {
    const hook = createReviewP3TriageHook({});
    const step1 = makeStep({ type: "review", dispatcherHint: "dispatch-reviewers" });
    const step2 = makeStep({ type: "review", dispatcherHint: "dispatch-reviewers" });
    const queue = makeQueue([step1, step2]);
    const handoff = { p3_findings: [{ description: "test", suggestion: "fix" }] };
    await hook(step1, "completed", queue, handoff);
    expect((step1 as any)._p3Triage).toBeDefined();
    await hook(step2, "completed", queue, handoff);
    expect((step2 as any)._p3Triage).toBeUndefined();
  });
});
