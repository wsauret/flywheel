import { describe, expect, test } from "bun:test";
import { buildQueueFromTemplate } from "../src/workflows/queue/templates";
import { SPRINT_HINT } from "../src/workflows/queue/steps/sprint/types";

// ---------------------------------------------------------------------------
// Sprint template tests
// ---------------------------------------------------------------------------

describe("buildQueueFromTemplate — sprint", () => {
  test("creates queue with one work step", () => {
    const q = buildQueueFromTemplate("sprint");
    expect(q.steps).toHaveLength(1);
    expect(q.steps[0].type).toBe("work");
    expect(q.steps[0].status).toBe("pending");
    expect(q.cursor).toBe(0);
    expect(q.status).toBe("idle");
  });

  test("step has dispatcherHint set to SPRINT_HINT", () => {
    const q = buildQueueFromTemplate("sprint");
    expect(q.steps[0].dispatcherHint).toBe(SPRINT_HINT);
  });

  test("step has full tool scoping", () => {
    const q = buildQueueFromTemplate("sprint");
    expect(q.steps[0].toolScoping).toEqual({
      read: true,
      bash: true,
      write: true,
      edit: true,
      task: true,
    });
  });

  test("step has evaluationCriteria set", () => {
    const q = buildQueueFromTemplate("sprint");
    const criteria = q.steps[0].evaluationCriteria;
    expect(criteria).toBeDefined();
    expect(typeof criteria).toBe("string");
    expect(criteria!.length).toBeGreaterThan(0);
    // Should contain self-review aligned evaluation content
    expect(criteria).toContain("Evaluation Criteria");
  });

  test("respects maxSteps option", () => {
    const q = buildQueueFromTemplate("sprint", 5);
    expect(q.maxSteps).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Work template unchanged
// ---------------------------------------------------------------------------

describe("buildQueueFromTemplate — work (unchanged)", () => {
  test("creates queue with one work step", () => {
    const q = buildQueueFromTemplate("work");
    expect(q.steps).toHaveLength(1);
    expect(q.steps[0].type).toBe("work");
    expect(q.steps[0].status).toBe("pending");
  });

  test("work step has no dispatcherHint", () => {
    const q = buildQueueFromTemplate("work");
    expect(q.steps[0].dispatcherHint).toBeUndefined();
  });

  test("work step has no evaluationCriteria", () => {
    const q = buildQueueFromTemplate("work");
    expect(q.steps[0].evaluationCriteria).toBeUndefined();
  });

  test("work step has full tool scoping", () => {
    const q = buildQueueFromTemplate("work");
    expect(q.steps[0].toolScoping).toEqual({
      read: true,
      bash: true,
      write: true,
      edit: true,
      task: true,
    });
  });
});
