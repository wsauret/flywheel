import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";

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
  createPlanIntegrationHook,
  createCompositeHook,
} from "../src/queue/plan-integration";

import { createQueue } from "../src/queue/queue";
import type { Step, Queue } from "../src/queue/types";
import type { ProtoStep } from "../src/queue/proto-step";
import type { OnStepCompletedHook } from "../src/queue/executor";

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

// ---------------------------------------------------------------------------
// VAL-HOOK-005: Inserted work steps carry plan metadata
// ---------------------------------------------------------------------------

describe("VAL-HOOK-005: Inserted work steps carry plan metadata", () => {
  const richProtoSteps: ProtoStep[] = [
    {
      title: "Implement auth module",
      description: "Add authentication module with JWT support",
      acceptanceCriteria: ["JWT tokens generated", "Login endpoint works"],
      fileReferences: ["src/auth/index.ts", "src/auth/jwt.ts"],
      feature: "authentication",
      fulfills: ["VAL-AUTH-001", "VAL-AUTH-002"],
      milestone: "core-auth",
    },
    {
      title: "Add user API",
      description: "Create CRUD endpoints for users",
      acceptanceCriteria: ["GET /users returns list", "POST /users creates user"],
      fileReferences: ["src/api/users.ts"],
      feature: "user-management",
      milestone: "core-auth",
    },
  ];

  test("inserted work steps carry title from proto-step", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", richProtoSteps);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps[1].title).toBe("Implement auth module");
      expect(result.queue.steps[2].title).toBe("Add user API");
    }
  });

  test("inserted work steps carry description from proto-step", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", richProtoSteps);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps[1].description).toBe("Add authentication module with JWT support");
      expect(result.queue.steps[2].description).toBe("Create CRUD endpoints for users");
    }
  });

  test("inserted work steps carry acceptanceCriteria from proto-step", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", richProtoSteps);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps[1].acceptanceCriteria).toEqual([
        "JWT tokens generated",
        "Login endpoint works",
      ]);
      expect(result.queue.steps[2].acceptanceCriteria).toEqual([
        "GET /users returns list",
        "POST /users creates user",
      ]);
    }
  });

  test("inserted work steps carry fileReferences from proto-step", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", richProtoSteps);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps[1].fileReferences).toEqual([
        "src/auth/index.ts",
        "src/auth/jwt.ts",
      ]);
      expect(result.queue.steps[2].fileReferences).toEqual(["src/api/users.ts"]);
    }
  });

  test("inserted work steps carry feature from proto-step", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", richProtoSteps);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps[1].feature).toBe("authentication");
      expect(result.queue.steps[2].feature).toBe("user-management");
    }
  });

  test("inserted work steps carry fulfills from proto-step", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", richProtoSteps);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps[1].fulfills).toEqual(["VAL-AUTH-001", "VAL-AUTH-002"]);
      // Second step has no fulfills
      expect(result.queue.steps[2].fulfills).toBeUndefined();
    }
  });

  test("inserted work steps carry milestone from proto-step", () => {
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const result = insertWorkStepsFromPlanOutput(queue, "p1", richProtoSteps);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.queue.steps[1].milestone).toBe("core-auth");
      expect(result.queue.steps[2].milestone).toBe("core-auth");
    }
  });
});

// ---------------------------------------------------------------------------
// VAL-HOOK-004: Plan completion triggers work step insertion
// (createPlanIntegrationHook)
// ---------------------------------------------------------------------------

describe("VAL-HOOK-004: createPlanIntegrationHook", () => {
  test("plan step completion with steps[] in handoff inserts work steps", async () => {
    const hook = createPlanIntegrationHook();
    const queue = createQueue([
      makePlanStep("p1"),
      makeReviewStep("r1"),
    ]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const handoffData = {
      steps: [
        {
          title: "Implement feature A",
          description: "Build the main feature",
          acceptanceCriteria: ["Feature works", "Tests pass"],
        },
        {
          title: "Implement feature B",
          description: "Build the secondary feature",
          acceptanceCriteria: ["Feature works"],
        },
      ],
    };

    const result = await hook(queue.steps[0], "completed", queue, handoffData);
    expect(result.continueExecution).toBe(false);

    // Work steps inserted between plan and review
    expect(queue.steps).toHaveLength(4); // plan + 2 work + review
    expect(queue.steps[1].type).toBe("work");
    expect(queue.steps[1].title).toBe("Implement feature A");
    expect(queue.steps[2].type).toBe("work");
    expect(queue.steps[2].title).toBe("Implement feature B");
    expect(queue.steps[3].type).toBe("review");
  });

  test("hook ignores failed plan steps", async () => {
    const hook = createPlanIntegrationHook();
    const queue = createQueue([makePlanStep("p1")]);

    const handoffData = {
      steps: [
        { title: "Step 1", description: "Desc", acceptanceCriteria: ["OK"] },
      ],
    };

    await hook(queue.steps[0], "failed", queue, handoffData);

    // No work steps inserted (status was "failed")
    expect(queue.steps).toHaveLength(1);
  });

  test("hook ignores non-plan steps", async () => {
    const hook = createPlanIntegrationHook();
    const workStep: Step = {
      id: randomUUID(),
      type: "work",
      title: "Work step",
      status: "completed",
    };
    const queue = createQueue([workStep]);
    queue.steps[0].status = "completed";

    const handoffData = {
      steps: [
        { title: "Step 1", description: "Desc", acceptanceCriteria: ["OK"] },
      ],
    };

    await hook(queue.steps[0], "completed", queue, handoffData);

    // No work steps inserted (not a plan step)
    expect(queue.steps).toHaveLength(1);
  });

  test("hook ignores handoff without steps array", async () => {
    const hook = createPlanIntegrationHook();
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";

    const handoffData = { summary: "Plan completed", decisions: [] };

    await hook(queue.steps[0], "completed", queue, handoffData);

    // No work steps inserted
    expect(queue.steps).toHaveLength(1);
  });

  test("hook ignores null handoff", async () => {
    const hook = createPlanIntegrationHook();
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";

    await hook(queue.steps[0], "completed", queue, null);

    // No work steps inserted
    expect(queue.steps).toHaveLength(1);
  });

  test("hook ignores empty steps array in handoff", async () => {
    const hook = createPlanIntegrationHook();
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";

    await hook(queue.steps[0], "completed", queue, { steps: [] });

    // No work steps inserted
    expect(queue.steps).toHaveLength(1);
  });

  test("hook ignores invalid proto-steps (missing required fields)", async () => {
    const hook = createPlanIntegrationHook();
    const queue = createQueue([makePlanStep("p1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    // Invalid: missing description and acceptanceCriteria
    const handoffData = {
      steps: [{ title: "Incomplete step" }],
    };

    await hook(queue.steps[0], "completed", queue, handoffData);

    // No work steps inserted (validation failed)
    expect(queue.steps).toHaveLength(1);
  });

  test("hook preserves all metadata from proto-steps", async () => {
    const hook = createPlanIntegrationHook();
    const queue = createQueue([
      makePlanStep("p1"),
      makeReviewStep("r1"),
    ]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const handoffData = {
      steps: [
        {
          title: "Auth module",
          description: "Implement JWT auth",
          acceptanceCriteria: ["JWT works"],
          fileReferences: ["src/auth.ts"],
          feature: "auth",
          fulfills: ["VAL-AUTH-001"],
          milestone: "core",
        },
      ],
    };

    await hook(queue.steps[0], "completed", queue, handoffData);

    expect(queue.steps).toHaveLength(3);
    const workStep = queue.steps[1];
    expect(workStep.title).toBe("Auth module");
    expect(workStep.description).toBe("Implement JWT auth");
    expect(workStep.acceptanceCriteria).toEqual(["JWT works"]);
    expect(workStep.fileReferences).toEqual(["src/auth.ts"]);
    expect(workStep.feature).toBe("auth");
    expect(workStep.fulfills).toEqual(["VAL-AUTH-001"]);
    expect(workStep.milestone).toBe("core");
  });
});

// ---------------------------------------------------------------------------
// createCompositeHook
// ---------------------------------------------------------------------------

describe("createCompositeHook", () => {
  test("calls all hooks in order", async () => {
    const callOrder: string[] = [];

    const hook1: OnStepCompletedHook = async () => {
      callOrder.push("hook1");
      return { continueExecution: false };
    };
    const hook2: OnStepCompletedHook = async () => {
      callOrder.push("hook2");
      return { continueExecution: false };
    };

    const composite = createCompositeHook([hook1, hook2]);
    const step: Step = {
      id: randomUUID(),
      type: "work",
      title: "Test",
      status: "completed",
    };
    const queue = createQueue([step]);

    await composite(step, "completed", queue, null);

    expect(callOrder).toEqual(["hook1", "hook2"]);
  });

  test("returns continueExecution=true if any hook says true", async () => {
    const hook1: OnStepCompletedHook = async () => ({ continueExecution: false });
    const hook2: OnStepCompletedHook = async () => ({ continueExecution: true });
    const hook3: OnStepCompletedHook = async () => ({ continueExecution: false });

    const composite = createCompositeHook([hook1, hook2, hook3]);
    const step: Step = { id: randomUUID(), type: "work", title: "T", status: "completed" };
    const queue = createQueue([step]);

    const result = await composite(step, "completed", queue, null);
    expect(result.continueExecution).toBe(true);
  });

  test("returns continueExecution=false if all hooks say false", async () => {
    const hook1: OnStepCompletedHook = async () => ({ continueExecution: false });
    const hook2: OnStepCompletedHook = async () => ({ continueExecution: false });

    const composite = createCompositeHook([hook1, hook2]);
    const step: Step = { id: randomUUID(), type: "work", title: "T", status: "completed" };
    const queue = createQueue([step]);

    const result = await composite(step, "completed", queue, null);
    expect(result.continueExecution).toBe(false);
  });

  test("skips null and undefined hooks", async () => {
    const callOrder: string[] = [];
    const hook: OnStepCompletedHook = async () => {
      callOrder.push("active");
      return { continueExecution: false };
    };

    const composite = createCompositeHook([null, hook, undefined, hook]);
    const step: Step = { id: randomUUID(), type: "work", title: "T", status: "completed" };
    const queue = createQueue([step]);

    await composite(step, "completed", queue, null);
    expect(callOrder).toEqual(["active", "active"]);
  });

  test("empty hooks array returns continueExecution=false", async () => {
    const composite = createCompositeHook([]);
    const step: Step = { id: randomUUID(), type: "work", title: "T", status: "completed" };
    const queue = createQueue([step]);

    const result = await composite(step, "completed", queue, null);
    expect(result.continueExecution).toBe(false);
  });

  test("composite of plan-integration and sprint-like hook works", async () => {
    const planHook = createPlanIntegrationHook();
    const sprintCalls: string[] = [];
    const sprintHook: OnStepCompletedHook = async (step, status) => {
      sprintCalls.push(`${step.type}:${status}`);
      return { continueExecution: false };
    };

    const composite = createCompositeHook([planHook, sprintHook]);

    // Plan step completion with steps[] in handoff
    const queue = createQueue([makePlanStep("p1"), makeReviewStep("r1")]);
    queue.steps[0].status = "completed";
    queue.cursor = 1;

    const handoffData = {
      steps: [
        { title: "Work A", description: "Do A", acceptanceCriteria: ["A done"] },
      ],
    };

    await composite(queue.steps[0], "completed", queue, handoffData);

    // Plan hook should have inserted work step
    expect(queue.steps).toHaveLength(3); // plan + work + review
    // Sprint hook should have been called too
    expect(sprintCalls).toEqual(["plan:completed"]);
  });
});
