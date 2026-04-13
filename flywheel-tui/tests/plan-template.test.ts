import { describe, expect, test } from "bun:test";
import { buildQueueFromTemplate } from "../src/workflows/queue/templates";

// ---------------------------------------------------------------------------
// Plan template tests
// ---------------------------------------------------------------------------

describe("buildQueueFromTemplate — plan", () => {
  test("creates queue with one plan step", () => {
    const q = buildQueueFromTemplate("plan");
    expect(q.steps).toHaveLength(1);
    expect(q.steps[0].type).toBe("plan");
    expect(q.steps[0].status).toBe("pending");
    expect(q.cursor).toBe(0);
    expect(q.status).toBe("idle");
  });

  test("step title is 'Create implementation plan'", () => {
    const q = buildQueueFromTemplate("plan");
    expect(q.steps[0].title).toBe("Create implementation plan");
  });

  test("step has no dispatcherHint", () => {
    const q = buildQueueFromTemplate("plan");
    expect(q.steps[0].dispatcherHint).toBeUndefined();
  });

  test("step has no evaluationCriteria", () => {
    const q = buildQueueFromTemplate("plan");
    expect(q.steps[0].evaluationCriteria).toBeUndefined();
  });

  test("step has full tool scoping", () => {
    const q = buildQueueFromTemplate("plan");
    expect(q.steps[0].toolScoping).toEqual({
      read: true,
      bash: true,
      write: true,
      edit: true,
      task: true,
    });
  });

  test("respects maxSteps option", () => {
    const q = buildQueueFromTemplate("plan", 10);
    expect(q.maxSteps).toBe(10);
  });
});
