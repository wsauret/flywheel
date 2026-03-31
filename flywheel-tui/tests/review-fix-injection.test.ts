import { describe, test, expect } from "bun:test";
import { createReviewFixInjectionHook, REVIEW_FIX_EVALUATION_CRITERIA } from "../src/queue/steps/review-consolidate/hooks";
import { createQueue } from "../src/queue/queue";
import { randomUUID } from "crypto";
import type { Step, Queue } from "../src/queue/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(
  type: Step["type"],
  title: string,
  extra?: Partial<Step>,
): Step {
  return {
    id: randomUUID(),
    type,
    title,
    status: "pending",
    ...extra,
  };
}

function makeConsolidationStep(extra?: Partial<Step>): Step {
  return makeStep("review", "Consolidate review findings", {
    dispatcherHint: "consolidate-review",
    evaluationCriteria: "Produces a prioritized list of findings with severity levels",
    ...extra,
  });
}

function makeQueueWithReviewSteps(): Queue {
  const steps: Step[] = [
    makeStep("review", "Multi-agent code review", {
      dispatcherHint: "dispatch-reviewers",
      status: "completed",
    }),
    makeConsolidationStep(),
    makeStep("ship", "Stage changes"),
  ];
  return createQueue(steps);
}

function handoffWithFindings(
  p1: number,
  p2: number,
  p3: number,
  reviewFilePath?: string,
): Record<string, unknown> {
  return {
    summary: "Review consolidation complete with findings prioritized by severity.",
    finding_counts: {
      p1_critical: p1,
      p2_important: p2,
      p3_suggestion: p3,
    },
    ...(reviewFilePath ? { review_file_path: reviewFilePath } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tests — dynamic injection behavior
// ---------------------------------------------------------------------------

describe("review-fix-injection hook", () => {
  test("injects work/fix step when P1 + P2 > 0", async () => {
    const queue = makeQueueWithReviewSteps();
    const consolidationStep = queue.steps[1];
    consolidationStep.status = "completed";

    const hook = createReviewFixInjectionHook();
    const result = await hook(
      consolidationStep,
      "completed",
      queue,
      handoffWithFindings(2, 3, 1, "docs/reviews/test.md"),
    );

    expect(result.continueExecution).toBe(false);

    // A work step should have been inserted after consolidation (index 2)
    expect(queue.steps).toHaveLength(4);
    const injectedStep = queue.steps[2];
    expect(injectedStep.type).toBe("work");
    expect(injectedStep.title).toBe("Implement review fixes");
    expect(injectedStep.status).toBe("pending");
    expect(injectedStep.dispatcherHint).toBe("implement-fixes");
    expect(injectedStep.evaluationCriteria).toBe(REVIEW_FIX_EVALUATION_CRITERIA);
    expect(injectedStep.description).toContain("2 P1 (critical)");
    expect(injectedStep.description).toContain("3 P2 (important)");
    expect(injectedStep.description).toContain("docs/reviews/test.md");

    // Ship step should now be at index 3
    expect(queue.steps[3].type).toBe("ship");
  });

  test("does NOT inject when P1 + P2 === 0", async () => {
    const queue = makeQueueWithReviewSteps();
    const consolidationStep = queue.steps[1];
    consolidationStep.status = "completed";

    const hook = createReviewFixInjectionHook();
    const result = await hook(
      consolidationStep,
      "completed",
      queue,
      handoffWithFindings(0, 0, 5),
    );

    expect(result.continueExecution).toBe(false);
    // No step injected — still 3 steps
    expect(queue.steps).toHaveLength(3);
  });

  test("does NOT inject when handoff data is null", async () => {
    const queue = makeQueueWithReviewSteps();
    const consolidationStep = queue.steps[1];
    consolidationStep.status = "completed";

    const hook = createReviewFixInjectionHook();
    const result = await hook(consolidationStep, "completed", queue, null);

    expect(result.continueExecution).toBe(false);
    expect(queue.steps).toHaveLength(3);
  });

  test("does NOT inject when finding_counts is missing from handoff", async () => {
    const queue = makeQueueWithReviewSteps();
    const consolidationStep = queue.steps[1];
    consolidationStep.status = "completed";

    const hook = createReviewFixInjectionHook();
    const result = await hook(
      consolidationStep,
      "completed",
      queue,
      { summary: "No findings data" },
    );

    expect(result.continueExecution).toBe(false);
    expect(queue.steps).toHaveLength(3);
  });

  test("does NOT inject for non-review steps", async () => {
    const queue = makeQueueWithReviewSteps();
    const workStep = makeStep("work", "Some work", { status: "completed" });

    const hook = createReviewFixInjectionHook();
    const result = await hook(
      workStep,
      "completed",
      queue,
      handoffWithFindings(5, 3, 1),
    );

    expect(result.continueExecution).toBe(false);
    expect(queue.steps).toHaveLength(3);
  });

  test("does NOT inject for review steps without consolidate-review hint", async () => {
    const queue = makeQueueWithReviewSteps();
    const dispatchStep = queue.steps[0];

    const hook = createReviewFixInjectionHook();
    const result = await hook(
      dispatchStep,
      "completed",
      queue,
      handoffWithFindings(5, 3, 1),
    );

    expect(result.continueExecution).toBe(false);
    expect(queue.steps).toHaveLength(3);
  });

  test("does NOT inject for failed steps", async () => {
    const queue = makeQueueWithReviewSteps();
    const consolidationStep = queue.steps[1];

    const hook = createReviewFixInjectionHook();
    const result = await hook(
      consolidationStep,
      "failed",
      queue,
      handoffWithFindings(5, 3, 1),
    );

    expect(result.continueExecution).toBe(false);
    expect(queue.steps).toHaveLength(3);
  });

  test("is idempotent — only injects once", async () => {
    const queue = makeQueueWithReviewSteps();
    const consolidationStep = queue.steps[1];
    consolidationStep.status = "completed";

    const hook = createReviewFixInjectionHook();

    // First call: inject
    await hook(
      consolidationStep,
      "completed",
      queue,
      handoffWithFindings(1, 2, 0),
    );
    expect(queue.steps).toHaveLength(4);

    // Second call: no-op
    await hook(
      consolidationStep,
      "completed",
      queue,
      handoffWithFindings(1, 2, 0),
    );
    expect(queue.steps).toHaveLength(4);
  });

  test("injected step has work type (not review)", async () => {
    const queue = makeQueueWithReviewSteps();
    const consolidationStep = queue.steps[1];
    consolidationStep.status = "completed";

    const hook = createReviewFixInjectionHook();
    await hook(
      consolidationStep,
      "completed",
      queue,
      handoffWithFindings(1, 0, 0),
    );

    const injectedStep = queue.steps[2];
    expect(injectedStep.type).toBe("work");
  });

  test("mutation log records the injection", async () => {
    const queue = makeQueueWithReviewSteps();
    const consolidationStep = queue.steps[1];
    consolidationStep.status = "completed";

    const hook = createReviewFixInjectionHook();
    await hook(
      consolidationStep,
      "completed",
      queue,
      handoffWithFindings(1, 1, 0),
    );

    const insertEntry = queue.mutationLog.find(
      (e) => e.action === "insert" && e.actor === "review-fix-injection",
    );
    expect(insertEntry).toBeDefined();
    expect(insertEntry!.stepIds).toHaveLength(1);
  });
});
