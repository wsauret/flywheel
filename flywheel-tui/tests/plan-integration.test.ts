import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Tests for src/queue/plan-integration.ts — plan output → queue insertion
// ---------------------------------------------------------------------------
//
// When a plan step completes and produces proto-steps JSON, the plan
// integration module calls formalizeProtoSteps() and inserts the resulting
// work steps into the queue at the correct position (before review/ship).
// ---------------------------------------------------------------------------

import {
  insertWorkStepsFromPlanOutput,
  findInsertionPoint,
} from "../src/queue/plan-integration";

import { createQueue } from "../src/queue/queue";
import type { Step, Queue } from "../src/queue/types";
import type { ProtoStep } from "../src/queue/proto-step";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<Step> & { id: string; type: Step["type"]; title: string }): Step {
  return {
    status: "pending",
    ...overrides,
  };
}

function makePlanStep(id: string): Step {
  return makeStep({ id, type: "plan", title: "Create plan" });
}

function makeReviewStep(id: string): Step {
  return makeStep({ id, type: "review", title: "Review changes" });
}

function makeShipStep(id: string): Step {
  return makeStep({ id, type: "ship", title: "Ship changes" });
}

function makeGateStep(id: string): Step {
  return makeStep({ id, type: "gate", title: "Approval gate" });
}

const sampleProtoSteps: ProtoStep[] = [
  {
    title: "Implement auth module",
    description: "Add authentication module with JWT support",
    acceptanceCriteria: ["JWT tokens generated", "Login endpoint works"],
  },
  {
    title: "Add user API",
    description: "Create CRUD endpoints for users",
    acceptanceCriteria: ["GET /users returns list", "POST /users creates user"],
  },
  {
    title: "Write integration tests",
    description: "E2E tests for auth + user flows",
    acceptanceCriteria: ["All tests pass", "Coverage > 80%"],
  },
];

// ---------------------------------------------------------------------------
// findInsertionPoint — determines where to insert work steps
// ---------------------------------------------------------------------------

describe("findInsertionPoint", () => {
  test("returns index after completed plan step when no review/ship exists", () => {
    const steps: Step[] = [
      { ...makePlanStep("p1"), status: "completed" },
    ];
    const idx = findInsertionPoint(steps, "p1");
    expect(idx).toBe(1); // After plan step
  });

  test("returns index before first review step (after plan)", () => {
    const steps: Step[] = [
      { ...makePlanStep("p1"), status: "completed" },
      makeReviewStep("r1"),
    ];
    const idx = findInsertionPoint(steps, "p1");
    expect(idx).toBe(1); // Between plan and review
  });

  test("returns index before first review step in full template", () => {
    const steps: Step[] = [
      { ...makePlanStep("p1"), status: "completed" },
      makeReviewStep("r1"),
      makeShipStep("s1"),
    ];
    const idx = findInsertionPoint(steps, "p1");
    expect(idx).toBe(1); // Between plan and review
  });

  test("inserts before gate step that precedes review", () => {
    const steps: Step[] = [
      { ...makePlanStep("p1"), status: "completed" },
      makeGateStep("g1"),
      makeReviewStep("r1"),
    ];
    const idx = findInsertionPoint(steps, "p1");
    // Should insert between plan and the gate that precedes review
    expect(idx).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// insertWorkStepsFromPlanOutput — full integration
// ---------------------------------------------------------------------------

describe("insertWorkStepsFromPlanOutput", () => {
  test("inserts formalized work steps into queue after plan step", () => {
    const queue = createQueue([makePlanStep("p1")]);
    // Mark plan as completed
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", sampleProtoSteps);
    expect(result.success).toBe(true);

    if (result.success) {
      // 3 work steps inserted after plan
      expect(result.queue.steps).toHaveLength(4); // 1 plan + 3 work
      expect(result.queue.steps[0].type).toBe("plan");
      expect(result.queue.steps[1].type).toBe("work");
      expect(result.queue.steps[2].type).toBe("work");
      expect(result.queue.steps[3].type).toBe("work");
    }
  });

  test("work steps have titles from proto-steps", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", sampleProtoSteps);
    expect(result.success).toBe(true);

    if (result.success) {
      expect(result.queue.steps[1].title).toBe("Implement auth module");
      expect(result.queue.steps[2].title).toBe("Add user API");
      expect(result.queue.steps[3].title).toBe("Write integration tests");
    }
  });

  test("all inserted work steps are pending", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", sampleProtoSteps);
    expect(result.success).toBe(true);

    if (result.success) {
      for (const step of result.queue.steps.slice(1)) {
        expect(step.status).toBe("pending");
      }
    }
  });

  test("inserts work steps between plan and review (plan-work-review)", () => {
    const queue = createQueue([makePlanStep("p1"), makeReviewStep("r1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", sampleProtoSteps);
    expect(result.success).toBe(true);

    if (result.success) {
      // plan, work, work, work, review
      expect(result.queue.steps).toHaveLength(5);
      expect(result.queue.steps[0].type).toBe("plan");
      expect(result.queue.steps[1].type).toBe("work");
      expect(result.queue.steps[2].type).toBe("work");
      expect(result.queue.steps[3].type).toBe("work");
      expect(result.queue.steps[4].type).toBe("review");
    }
  });

  test("inserts work steps between plan and review in full template", () => {
    const queue = createQueue([
      makePlanStep("p1"),
      makeReviewStep("r1"),
      makeShipStep("s1"),
    ]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", sampleProtoSteps);
    expect(result.success).toBe(true);

    if (result.success) {
      // plan, work, work, work, review, ship
      expect(result.queue.steps).toHaveLength(6);
      expect(result.queue.steps[0].type).toBe("plan");
      expect(result.queue.steps[1].type).toBe("work");
      expect(result.queue.steps[2].type).toBe("work");
      expect(result.queue.steps[3].type).toBe("work");
      expect(result.queue.steps[4].type).toBe("review");
      expect(result.queue.steps[5].type).toBe("ship");
    }
  });

  test("inserts before gate that precedes review", () => {
    const queue = createQueue([
      makePlanStep("p1"),
      makeGateStep("g1"),
      makeReviewStep("r1"),
    ]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", sampleProtoSteps);
    expect(result.success).toBe(true);

    if (result.success) {
      // plan, work, work, work, gate, review
      expect(result.queue.steps).toHaveLength(6);
      expect(result.queue.steps[0].type).toBe("plan");
      expect(result.queue.steps[1].type).toBe("work");
      expect(result.queue.steps[2].type).toBe("work");
      expect(result.queue.steps[3].type).toBe("work");
      expect(result.queue.steps[4].type).toBe("gate");
      expect(result.queue.steps[5].type).toBe("review");
    }
  });

  test("records mutation in log", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", sampleProtoSteps);
    expect(result.success).toBe(true);

    if (result.success) {
      const insertMutations = result.queue.mutationLog.filter(
        (m) => m.action === "insert"
      );
      expect(insertMutations.length).toBeGreaterThan(0);
      expect(insertMutations[0].actor).toBe("plan-integration");
    }
  });

  test("returns error for empty proto-steps array", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", []);
    expect(result.success).toBe(false);
  });

  test("returns error when plan step not found", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "nonexistent", sampleProtoSteps);
    expect(result.success).toBe(false);
  });

  test("work steps have unique IDs", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", sampleProtoSteps);
    expect(result.success).toBe(true);

    if (result.success) {
      const ids = result.queue.steps.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
});
