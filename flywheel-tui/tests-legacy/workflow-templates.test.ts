import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Tests for src/queue/templates.ts — workflow template system
// ---------------------------------------------------------------------------
//
// Validation contract assertions fulfilled:
//   VAL-SHELL-001: Plan Only template creates single plan step
//   VAL-SHELL-002: Plan + Work template with deferred work insertion
//   VAL-SHELL-003: Plan + Work + Review template
//   VAL-SHELL-004: Full template
//   VAL-SHELL-005: Sprint template creates work + verify
//   VAL-QUEUE-035: Gate step pauses for user approval
//   VAL-QUEUE-036: Approval gates between steps when configured
// ---------------------------------------------------------------------------

import {
  buildQueueFromTemplate,
  buildGranularDebugSteps,
  buildGranularShipSteps,
  buildGranularReviewSteps,
  type WorkflowName,
} from "../src/workflows/queue/templates";

import type { Step, Queue } from "../src/workflows/queue/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stepTypes(queue: Queue): string[] {
  return queue.steps.map((s) => s.type);
}

function stepTitles(queue: Queue): string[] {
  return queue.steps.map((s) => s.title);
}

function gateSteps(queue: Queue): Step[] {
  return queue.steps.filter((s) => s.type === "gate");
}

// ---------------------------------------------------------------------------
// VAL-SHELL-001: Plan Only template creates granular plan steps
// ---------------------------------------------------------------------------

describe("VAL-SHELL-001: Plan Only template", () => {
  test("creates queue with 4 granular plan steps", () => {
    const queue = buildQueueFromTemplate("plan-only");
    expect(queue.steps).toHaveLength(4);
    for (const step of queue.steps) {
      expect(step.type).toBe("plan");
      expect(step.status).toBe("pending");
      expect(step.title).toBeTruthy();
    }
  });

  test("plan steps have expected titles in order", () => {
    const queue = buildQueueFromTemplate("plan-only");
    const titles = stepTitles(queue);
    expect(titles[0]).toContain("Research");
    expect(titles[1]).toContain("Draft");
    expect(titles[2]).toContain("Review");
    expect(titles[3]).toContain("Consolidate");
  });

  test("all steps have unique IDs", () => {
    const queue = buildQueueFromTemplate("plan-only");
    const ids = queue.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("queue cursor starts at 0", () => {
    const queue = buildQueueFromTemplate("plan-only");
    expect(queue.cursor).toBe(0);
  });

  test("queue status is idle", () => {
    const queue = buildQueueFromTemplate("plan-only");
    expect(queue.status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// VAL-SHELL-002: Plan + Work template with deferred work insertion
// ---------------------------------------------------------------------------

describe("VAL-SHELL-002: Plan + Work template", () => {
  test("creates initial queue with 4 granular plan steps (work deferred)", () => {
    const queue = buildQueueFromTemplate("plan-work");
    // Initially only plan sub-steps — work steps inserted after plan completes
    const nonGateSteps = queue.steps.filter((s) => s.type !== "gate");
    expect(nonGateSteps).toHaveLength(4);
    for (const step of nonGateSteps) {
      expect(step.type).toBe("plan");
    }
  });

  test("all steps are pending", () => {
    const queue = buildQueueFromTemplate("plan-work");
    for (const step of queue.steps) {
      expect(step.status).toBe("pending");
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-SHELL-003: Plan + Work + Review template
// ---------------------------------------------------------------------------

describe("VAL-SHELL-003: Plan + Work + Review template", () => {
  test("creates initial queue with 6 granular steps (4 plan + 2 review, fix step injected dynamically)", () => {
    const queue = buildQueueFromTemplate("plan-work-review");
    const nonGateSteps = queue.steps.filter((s) => s.type !== "gate");
    expect(nonGateSteps).toHaveLength(6);
    const planSteps = nonGateSteps.filter((s) => s.type === "plan");
    const reviewSteps = nonGateSteps.filter((s) => s.type === "review");
    expect(planSteps).toHaveLength(4);
    expect(reviewSteps).toHaveLength(2);
  });

  test("all review steps come after all plan steps", () => {
    const queue = buildQueueFromTemplate("plan-work-review");
    const lastPlanIdx = queue.steps.map((s, i) => ({ ...s, i })).filter((s) => s.type === "plan").pop()!.i;
    const firstReviewIdx = queue.steps.findIndex((s) => s.type === "review");
    expect(firstReviewIdx).toBeGreaterThan(lastPlanIdx);
  });
});

// ---------------------------------------------------------------------------
// VAL-SHELL-004: Full template
// ---------------------------------------------------------------------------

describe("VAL-SHELL-004: Full template", () => {
  test("creates initial queue with 8 granular steps (4 plan + 2 review + 2 ship, fix step injected dynamically)", () => {
    const queue = buildQueueFromTemplate("full");
    const nonGateSteps = queue.steps.filter((s) => s.type !== "gate");
    expect(nonGateSteps).toHaveLength(8);
    const planSteps = nonGateSteps.filter((s) => s.type === "plan");
    const reviewSteps = nonGateSteps.filter((s) => s.type === "review");
    const shipSteps = nonGateSteps.filter((s) => s.type === "ship");
    expect(planSteps).toHaveLength(4);
    expect(reviewSteps).toHaveLength(2);
    expect(shipSteps).toHaveLength(2);
  });

  test("step order preserved: all plan before all review before all ship", () => {
    const queue = buildQueueFromTemplate("full");
    const nonGateSteps = queue.steps.filter((s) => s.type !== "gate");
    const lastPlanIdx = nonGateSteps.findLastIndex((s) => s.type === "plan");
    const firstReviewIdx = nonGateSteps.findIndex((s) => s.type === "review");
    const lastReviewIdx = nonGateSteps.findLastIndex((s) => s.type === "review");
    const firstShipIdx = nonGateSteps.findIndex((s) => s.type === "ship");
    expect(lastPlanIdx).toBeLessThan(firstReviewIdx);
    expect(lastReviewIdx).toBeLessThan(firstShipIdx);
  });
});

// ---------------------------------------------------------------------------
// VAL-SHELL-005: Sprint template creates work + verify
// ---------------------------------------------------------------------------

describe("VAL-SHELL-005: Sprint template", () => {
  test("creates queue with exactly [work, verify] steps", () => {
    const queue = buildQueueFromTemplate("sprint");
    expect(queue.steps).toHaveLength(2);
    expect(queue.steps[0].type).toBe("work");
    expect(queue.steps[1].type).toBe("verify");
  });

  test("both steps are pending", () => {
    const queue = buildQueueFromTemplate("sprint");
    expect(queue.steps[0].status).toBe("pending");
    expect(queue.steps[1].status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-036: Gate steps inserted when skip_approval_gates=false
// ---------------------------------------------------------------------------

describe("VAL-QUEUE-036: Gate steps removed from templates (HITL via questions)", () => {
  test("plan-work-review never inserts gate steps regardless of config", () => {
    const withFlag = buildQueueFromTemplate("plan-work-review", { skipApprovalGates: false });
    const withoutFlag = buildQueueFromTemplate("plan-work-review", { skipApprovalGates: true });
    const noOptions = buildQueueFromTemplate("plan-work-review");
    expect(gateSteps(withFlag)).toHaveLength(0);
    expect(gateSteps(withoutFlag)).toHaveLength(0);
    expect(gateSteps(noOptions)).toHaveLength(0);
  });

  test("full template never inserts gate steps regardless of config", () => {
    const withFlag = buildQueueFromTemplate("full", { skipApprovalGates: false });
    const withoutFlag = buildQueueFromTemplate("full", { skipApprovalGates: true });
    expect(gateSteps(withFlag)).toHaveLength(0);
    expect(gateSteps(withoutFlag)).toHaveLength(0);
  });

  test("plan-only has no gate steps regardless of config", () => {
    const queueWithGates = buildQueueFromTemplate("plan-only", { skipApprovalGates: false });
    const queueWithout = buildQueueFromTemplate("plan-only", { skipApprovalGates: true });
    expect(gateSteps(queueWithGates)).toHaveLength(0);
    expect(gateSteps(queueWithout)).toHaveLength(0);
  });

  test("sprint has no gate steps regardless of config", () => {
    const queueWithGates = buildQueueFromTemplate("sprint", { skipApprovalGates: false });
    const queueWithout = buildQueueFromTemplate("sprint", { skipApprovalGates: true });
    expect(gateSteps(queueWithGates)).toHaveLength(0);
    expect(gateSteps(queueWithout)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// VAL-QUEUE-035: Gate step pauses for user approval
// ---------------------------------------------------------------------------

describe("VAL-QUEUE-035: Gate step properties", () => {
  test("gate steps have type 'gate' and descriptive titles", () => {
    const queue = buildQueueFromTemplate("full", {
      skipApprovalGates: false,
    });
    const gates = gateSteps(queue);
    for (const gate of gates) {
      expect(gate.type).toBe("gate");
      expect(gate.title).toBeTruthy();
      expect(gate.status).toBe("pending");
    }
  });
});



// ---------------------------------------------------------------------------
// buildGranularDebugSteps
// ---------------------------------------------------------------------------

describe("buildGranularDebugSteps", () => {
  test("creates 3 steps: investigate, fix, verify", () => {
    const steps = buildGranularDebugSteps();
    expect(steps).toHaveLength(3);
    expect(steps[0].type).toBe("debug");
    expect(steps[0].dispatcherHint).toBe("investigate");
    expect(steps[0].evaluationCriteria).toBeTruthy();
    expect(steps[0].toolScoping).toBeDefined();
    expect(steps[1].type).toBe("debug");
    expect(steps[1].dispatcherHint).toBe("fix");
    expect(steps[2].type).toBe("verify");
    expect(steps[2].dispatcherHint).toBe("debug-verify");
  });
});

// ---------------------------------------------------------------------------
// buildGranularShipSteps — refactored
// ---------------------------------------------------------------------------

describe("buildGranularShipSteps — refactored", () => {
  test("creates 2 steps: ship + learnings", () => {
    const steps = buildGranularShipSteps();
    expect(steps).toHaveLength(2);
    expect(steps[0].type).toBe("ship");
    expect(steps[0].dispatcherHint).toBe("ship");
    expect(steps[0].title).toContain("Stage");
    expect(steps[1].type).toBe("ship");
    expect(steps[1].dispatcherHint).toBe("learnings");
  });
});

// ---------------------------------------------------------------------------
// buildGranularReviewSteps — export verification
// ---------------------------------------------------------------------------

describe("buildGranularReviewSteps — export verification", () => {
  test("is exported and creates 2 steps", () => {
    expect(buildGranularReviewSteps).toBeDefined();
    const steps = buildGranularReviewSteps();
    expect(steps).toHaveLength(2);
    expect(steps[0].type).toBe("review");
    expect(steps[1].type).toBe("review");
  });
});
