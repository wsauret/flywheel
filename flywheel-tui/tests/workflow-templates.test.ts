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
  WORKFLOW_TEMPLATES,
  getWorkflowTemplate,
  buildQueueFromTemplate,
  type WorkflowName,
} from "../src/queue/templates";

import type { Step, Queue } from "../src/queue/types";

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
// VAL-SHELL-001: Plan Only template creates single plan step
// ---------------------------------------------------------------------------

describe("VAL-SHELL-001: Plan Only template", () => {
  test("creates queue with exactly one step of type 'plan'", () => {
    const queue = buildQueueFromTemplate("plan-only");
    expect(queue.steps).toHaveLength(1);
    expect(queue.steps[0].type).toBe("plan");
    expect(queue.steps[0].status).toBe("pending");
    expect(queue.steps[0].title).toBeTruthy();
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
  test("creates initial queue with only a plan step (work deferred)", () => {
    const queue = buildQueueFromTemplate("plan-work");
    // Initially only plan step — work steps inserted after plan completes
    const nonGateSteps = queue.steps.filter((s) => s.type !== "gate");
    expect(nonGateSteps).toHaveLength(1);
    expect(nonGateSteps[0].type).toBe("plan");
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
  test("creates initial queue with [plan, review] (work inserted between after plan)", () => {
    const queue = buildQueueFromTemplate("plan-work-review");
    const nonGateSteps = queue.steps.filter((s) => s.type !== "gate");
    expect(nonGateSteps).toHaveLength(2);
    expect(nonGateSteps[0].type).toBe("plan");
    expect(nonGateSteps[1].type).toBe("review");
  });

  test("review step is after plan step", () => {
    const queue = buildQueueFromTemplate("plan-work-review");
    const planIdx = queue.steps.findIndex((s) => s.type === "plan");
    const reviewIdx = queue.steps.findIndex((s) => s.type === "review");
    expect(reviewIdx).toBeGreaterThan(planIdx);
  });
});

// ---------------------------------------------------------------------------
// VAL-SHELL-004: Full template
// ---------------------------------------------------------------------------

describe("VAL-SHELL-004: Full template", () => {
  test("creates initial queue with [plan, review, ship] (work inserted after plan)", () => {
    const queue = buildQueueFromTemplate("full");
    const nonGateSteps = queue.steps.filter((s) => s.type !== "gate");
    expect(nonGateSteps).toHaveLength(3);
    expect(nonGateSteps[0].type).toBe("plan");
    expect(nonGateSteps[1].type).toBe("review");
    expect(nonGateSteps[2].type).toBe("ship");
  });

  test("step order preserved: plan before review before ship", () => {
    const queue = buildQueueFromTemplate("full");
    const planIdx = queue.steps.findIndex((s) => s.type === "plan");
    const reviewIdx = queue.steps.findIndex((s) => s.type === "review");
    const shipIdx = queue.steps.findIndex((s) => s.type === "ship");
    expect(planIdx).toBeLessThan(reviewIdx);
    expect(reviewIdx).toBeLessThan(shipIdx);
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

describe("VAL-QUEUE-036: Gate steps with skip_approval_gates", () => {
  test("plan-work-review inserts gate steps when skip_approval_gates=false", () => {
    const queue = buildQueueFromTemplate("plan-work-review", {
      skipApprovalGates: false,
    });
    const gates = gateSteps(queue);
    expect(gates.length).toBeGreaterThan(0);
  });

  test("plan-work-review has no gate steps when skip_approval_gates=true", () => {
    const queue = buildQueueFromTemplate("plan-work-review", {
      skipApprovalGates: true,
    });
    const gates = gateSteps(queue);
    expect(gates).toHaveLength(0);
  });

  test("full template inserts gate steps when skip_approval_gates=false", () => {
    const queue = buildQueueFromTemplate("full", {
      skipApprovalGates: false,
    });
    const gates = gateSteps(queue);
    expect(gates.length).toBeGreaterThan(0);
  });

  test("full template has no gate steps when skip_approval_gates=true", () => {
    const queue = buildQueueFromTemplate("full", {
      skipApprovalGates: true,
    });
    const gates = gateSteps(queue);
    expect(gates).toHaveLength(0);
  });

  test("plan-only has no gate steps regardless of config", () => {
    const queueWithGates = buildQueueFromTemplate("plan-only", {
      skipApprovalGates: false,
    });
    const queueWithout = buildQueueFromTemplate("plan-only", {
      skipApprovalGates: true,
    });
    expect(gateSteps(queueWithGates)).toHaveLength(0);
    expect(gateSteps(queueWithout)).toHaveLength(0);
  });

  test("sprint has no gate steps regardless of config", () => {
    const queueWithGates = buildQueueFromTemplate("sprint", {
      skipApprovalGates: false,
    });
    const queueWithout = buildQueueFromTemplate("sprint", {
      skipApprovalGates: true,
    });
    expect(gateSteps(queueWithGates)).toHaveLength(0);
    expect(gateSteps(queueWithout)).toHaveLength(0);
  });

  test("gate steps are positioned between major transitions", () => {
    const queue = buildQueueFromTemplate("full", {
      skipApprovalGates: false,
    });
    const types = stepTypes(queue);
    // Gate should appear between plan and review, and between review and ship
    // (work steps are deferred, so initially: plan, gate, review, gate, ship)
    const planIdx = types.indexOf("plan");
    const reviewIdx = types.indexOf("review");
    const shipIdx = types.indexOf("ship");

    // There should be a gate between plan and review
    const gatesBetweenPlanReview = types.slice(planIdx + 1, reviewIdx).filter((t) => t === "gate");
    expect(gatesBetweenPlanReview.length).toBeGreaterThanOrEqual(1);

    // There should be a gate between review and ship
    const gatesBetweenReviewShip = types.slice(reviewIdx + 1, shipIdx).filter((t) => t === "gate");
    expect(gatesBetweenReviewShip.length).toBeGreaterThanOrEqual(1);
  });

  test("gate steps default to skip_approval_gates=true (no gates)", () => {
    // Default behavior when no options provided: gates are NOT inserted
    // (skip_approval_gates defaults to true per feature description)
    const queue = buildQueueFromTemplate("plan-work-review");
    const gates = gateSteps(queue);
    expect(gates).toHaveLength(0);
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
// Workflow template registry
// ---------------------------------------------------------------------------

describe("Workflow template registry", () => {
  test("5 workflow templates are defined", () => {
    expect(WORKFLOW_TEMPLATES).toHaveLength(5);
  });

  test("all templates have required fields", () => {
    for (const template of WORKFLOW_TEMPLATES) {
      expect(template.name).toBeTruthy();
      expect(template.label).toBeTruthy();
      expect(template.description).toBeTruthy();
    }
  });

  test("getWorkflowTemplate returns correct template by name", () => {
    const planOnly = getWorkflowTemplate("plan-only");
    expect(planOnly).toBeDefined();
    expect(planOnly!.name).toBe("plan-only");
  });

  test("getWorkflowTemplate returns undefined for unknown name", () => {
    const unknown = getWorkflowTemplate("nonexistent" as WorkflowName);
    expect(unknown).toBeUndefined();
  });

  test("template names match expected values", () => {
    const names = WORKFLOW_TEMPLATES.map((t) => t.name);
    expect(names).toContain("plan-only");
    expect(names).toContain("plan-work");
    expect(names).toContain("plan-work-review");
    expect(names).toContain("full");
    expect(names).toContain("sprint");
  });
});
