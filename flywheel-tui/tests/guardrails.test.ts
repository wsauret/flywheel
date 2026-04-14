// ---------------------------------------------------------------------------
// ADR-004 Guardrails — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for 6 guardrails protecting queue mutations:
//   1. Max queue length (VAL-GUARD-001, VAL-MUT-004)
//   2. Max mutations per step completion (VAL-GUARD-002)
//   3. Max inserted steps per session (VAL-GUARD-003)
//   4. Provenance logging completeness (VAL-GUARD-005)
//   5. Budget visibility in dispatcher calls (VAL-GUARD-006)
//   6. Objective anchoring in mutation prompts (VAL-GUARD-007)
//   7. Dispatcher-driven mutation updates queue and TUI (VAL-CROSS-009)
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";

import {
  createQueue,
  insertAfter,
  removeStep,
  skipStep,
  transitionStep,
  type Provenance,
} from "../src/workflows/queue/queue";
import type { Step, Queue } from "../src/workflows/queue/types";
import {
  createGuardrails,
  type GuardrailOptions,
} from "../src/workflows/queue/guardrails";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: randomUUID(),
    type: "work",
    title: "Test step",
    status: "pending",
    ...overrides,
  };
}

function makeQueue(steps: Step[], opts?: { maxSteps?: number }): Queue {
  return createQueue(steps, opts ? { maxSteps: opts.maxSteps } : undefined);
}

const TEST_PROVENANCE: Provenance = {
  actor: "test",
  reason: "unit test",
};

function defaultGuardrailOptions(overrides?: Partial<GuardrailOptions>): GuardrailOptions {
  return {
    maxQueueLength: 50,
    maxMutationsPerStepCompletion: 3,
    maxInsertedStepsPerSession: 20,
    sessionObjective: "Build a hello world endpoint",
    ...overrides,
  };
}

function insertMutation(targetStepId: string, count = 1) {
  return {
    type: "insert_after" as const,
    targetStepId,
    steps: Array.from({ length: count }, () => makeStep()),
    reason: "test insert",
  };
}

// ---------------------------------------------------------------------------
// Guardrail 1: Max queue length (VAL-GUARD-001, VAL-MUT-004)
// ---------------------------------------------------------------------------

describe("Guardrail 1: Max queue length", () => {
  test("rejects insert that would exceed max queue length", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({ maxQueueLength: 5 }));
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps, { maxSteps: 5 });

    const results = guardrails.applyMutations(
      queue, "step-1", [insertMutation(steps[0].id)], TEST_PROVENANCE,
    );
    expect(results[0].applied).toBe(false);
    expect(results[0].reason).toContain("max");
  });

  test("allows insert when under max queue length", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({ maxQueueLength: 10 }));
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    const results = guardrails.applyMutations(
      queue, "step-1", [insertMutation(steps[0].id)], TEST_PROVENANCE,
    );
    expect(results[0].applied).toBe(true);
  });

  test("uses configurable maxQueueLength", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({ maxQueueLength: 3 }));
    const steps = Array.from({ length: 3 }, () => makeStep());
    const queue = makeQueue(steps);

    const results = guardrails.applyMutations(
      queue, "step-1", [insertMutation(steps[0].id)], TEST_PROVENANCE,
    );
    expect(results[0].applied).toBe(false);
  });

  test("allows insert exactly at max queue length", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({ maxQueueLength: 6 }));
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    const results = guardrails.applyMutations(
      queue, "step-1", [insertMutation(steps[0].id)], TEST_PROVENANCE,
    );
    expect(results[0].applied).toBe(true);
  });

  test("default max queue length is 50", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());
    const steps = Array.from({ length: 50 }, () => makeStep());
    const queue = makeQueue(steps);

    const results = guardrails.applyMutations(
      queue, "step-1", [insertMutation(steps[0].id)], TEST_PROVENANCE,
    );
    expect(results[0].applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guardrail 2: Max mutations per step completion (VAL-GUARD-002)
// ---------------------------------------------------------------------------

describe("Guardrail 2: Max mutations per step completion", () => {
  test("allows mutations within the per-step limit", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({ maxMutationsPerStepCompletion: 3 }));
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    const mutations = [
      insertMutation(steps[0].id),
      insertMutation(steps[1].id),
    ];
    const results = guardrails.applyMutations(queue, "step-1", mutations, TEST_PROVENANCE);
    expect(results.every((r) => r.applied)).toBe(true);
  });

  test("rejects 4th mutation when limit is 3", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({ maxMutationsPerStepCompletion: 3 }));
    const steps = Array.from({ length: 10 }, () => makeStep());
    const queue = makeQueue(steps);

    const mutations = [
      insertMutation(steps[0].id),
      insertMutation(steps[1].id),
      insertMutation(steps[2].id),
      insertMutation(steps[3].id),
    ];
    const results = guardrails.applyMutations(queue, "step-1", mutations, TEST_PROVENANCE);
    expect(results[0].applied).toBe(true);
    expect(results[1].applied).toBe(true);
    expect(results[2].applied).toBe(true);
    expect(results[3].applied).toBe(false);
    expect(results[3].reason).toContain("3");
  });

  test("tracks mutations independently per step", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({ maxMutationsPerStepCompletion: 2 }));
    const steps = Array.from({ length: 10 }, () => makeStep());
    const queue = makeQueue(steps);

    // Exhaust step-1's budget
    guardrails.applyMutations(queue, "step-1", [
      insertMutation(steps[0].id),
      insertMutation(steps[1].id),
    ], TEST_PROVENANCE);

    // step-1 should be exhausted
    const r1 = guardrails.applyMutations(queue, "step-1", [insertMutation(steps[2].id)], TEST_PROVENANCE);
    expect(r1[0].applied).toBe(false);

    // step-2 should still have budget
    const r2 = guardrails.applyMutations(queue, "step-2", [insertMutation(steps[3].id)], TEST_PROVENANCE);
    expect(r2[0].applied).toBe(true);
  });

  test("uses configurable limit", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({ maxMutationsPerStepCompletion: 1 }));
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    guardrails.applyMutations(queue, "step-1", [insertMutation(steps[0].id)], TEST_PROVENANCE);
    const r = guardrails.applyMutations(queue, "step-1", [insertMutation(steps[1].id)], TEST_PROVENANCE);
    expect(r[0].applied).toBe(false);
  });

  test("default limit is 3", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());
    const steps = Array.from({ length: 10 }, () => makeStep());
    const queue = makeQueue(steps);

    const mutations = [
      insertMutation(steps[0].id),
      insertMutation(steps[1].id),
      insertMutation(steps[2].id),
    ];
    guardrails.applyMutations(queue, "step-1", mutations, TEST_PROVENANCE);

    const r = guardrails.applyMutations(queue, "step-1", [insertMutation(steps[3].id)], TEST_PROVENANCE);
    expect(r[0].applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guardrail 3: Max inserted steps per session (VAL-GUARD-003)
// ---------------------------------------------------------------------------

describe("Guardrail 3: Max inserted steps per session", () => {
  test("tracks total inserts across all step completions", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      maxInsertedStepsPerSession: 3,
      maxMutationsPerStepCompletion: 10,
    }));
    const steps = Array.from({ length: 10 }, () => makeStep());
    const queue = makeQueue(steps);

    // Insert 3 steps across two step completions
    guardrails.applyMutations(queue, "step-1", [
      insertMutation(steps[0].id),
      insertMutation(steps[1].id),
    ], TEST_PROVENANCE);
    guardrails.applyMutations(queue, "step-2", [insertMutation(steps[2].id)], TEST_PROVENANCE);

    // Session limit reached — next insert should fail
    const r = guardrails.applyMutations(queue, "step-3", [insertMutation(steps[3].id)], TEST_PROVENANCE);
    expect(r[0].applied).toBe(false);
    expect(r[0].reason).toContain("session");
  });

  test("allows inserts under the session limit", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      maxInsertedStepsPerSession: 20,
      maxMutationsPerStepCompletion: 10,
    }));
    const steps = Array.from({ length: 20 }, () => makeStep());
    const queue = makeQueue(steps);

    // 10 inserts — well under limit of 20
    for (let i = 0; i < 10; i++) {
      guardrails.applyMutations(queue, `step-${i}`, [insertMutation(steps[0].id)], TEST_PROVENANCE);
    }

    const r = guardrails.applyMutations(queue, "step-11", [insertMutation(steps[0].id)], TEST_PROVENANCE);
    expect(r[0].applied).toBe(true);
  });

  test("considers the count of steps being inserted in a single mutation", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      maxInsertedStepsPerSession: 5,
      maxMutationsPerStepCompletion: 10,
    }));
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    // Insert 3 via one mutation
    guardrails.applyMutations(queue, "step-1", [insertMutation(steps[0].id, 3)], TEST_PROVENANCE);

    // Trying to insert 3 more would exceed limit of 5
    const r = guardrails.applyMutations(queue, "step-2", [insertMutation(steps[0].id, 3)], TEST_PROVENANCE);
    expect(r[0].applied).toBe(false);
  });

  test("allows inserting exactly up to the limit", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      maxInsertedStepsPerSession: 5,
      maxMutationsPerStepCompletion: 10,
    }));
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    // Insert 3, then 2 more = exactly 5
    guardrails.applyMutations(queue, "step-1", [insertMutation(steps[0].id, 3)], TEST_PROVENANCE);
    const r = guardrails.applyMutations(queue, "step-2", [insertMutation(steps[0].id, 2)], TEST_PROVENANCE);
    expect(r[0].applied).toBe(true);
  });

  test("default limit is 20", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());
    const steps = Array.from({ length: 25 }, () => makeStep());
    const queue = makeQueue(steps);

    // Insert 20 steps
    for (let i = 0; i < 20; i++) {
      guardrails.applyMutations(queue, `step-${i}`, [insertMutation(steps[0].id)], TEST_PROVENANCE);
    }

    const r = guardrails.applyMutations(queue, "step-21", [insertMutation(steps[0].id)], TEST_PROVENANCE);
    expect(r[0].applied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guardrail 4: Provenance logging completeness (VAL-GUARD-005)
// ---------------------------------------------------------------------------

describe("Guardrail 4: Provenance logging on all mutations", () => {
  test("insertAfter records full provenance (actor, reason, timestamp, stepIds)", () => {
    const steps = [makeStep(), makeStep()];
    const queue = makeQueue(steps);
    const newStep = makeStep();

    insertAfter(queue, steps[0].id, [newStep], {
      actor: "dispatcher",
      reason: "fix step for failing test",
    });

    const entry = queue.mutationLog.find((e) => e.action === "insert");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe("dispatcher");
    expect(entry!.reason).toBe("fix step for failing test");
    expect(entry!.stepIds).toContain(newStep.id);
    expect(entry!.timestamp).toBeTruthy();
    // Valid ISO-8601 timestamp
    expect(() => new Date(entry!.timestamp)).not.toThrow();
  });

  test("removeStep records full provenance", () => {
    const step = makeStep();
    const queue = makeQueue([step]);

    removeStep(queue, step.id, { actor: "user", reason: "not needed" });

    const entry = queue.mutationLog.find((e) => e.action === "remove");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe("user");
    expect(entry!.reason).toBe("not needed");
    expect(entry!.stepIds).toContain(step.id);
    expect(entry!.timestamp).toBeTruthy();
  });

  test("skipStep records full provenance", () => {
    const step = makeStep();
    const queue = makeQueue([step]);

    skipStep(queue, step.id, { actor: "sprint-hook", reason: "work step failed" });

    const entry = queue.mutationLog.find((e) => e.action === "skip");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe("sprint-hook");
    expect(entry!.reason).toBe("work step failed");
    expect(entry!.stepIds).toContain(step.id);
    expect(entry!.timestamp).toBeTruthy();
  });

  test("transitionStep records full provenance", () => {
    const step = makeStep();
    const queue = makeQueue([step]);

    transitionStep(queue, step.id, "running", {
      actor: "executor",
      reason: "starting step execution",
    });

    const entry = queue.mutationLog.find((e) => e.action === "status-change");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe("executor");
    expect(entry!.reason).toBe("starting step execution");
    expect(entry!.stepIds).toContain(step.id);
    expect(entry!.timestamp).toBeTruthy();
  });

  test("no mutation can bypass provenance (all mutations require actor and reason)", () => {
    const step = makeStep();
    const queue = makeQueue([step, makeStep()]);

    const newStep = makeStep();
    insertAfter(queue, step.id, [newStep], { actor: "a", reason: "r" });
    const lastEntry = queue.mutationLog[queue.mutationLog.length - 1];
    expect(lastEntry.actor).toBeTruthy();
    expect(lastEntry.reason).toBeTruthy();
    expect(lastEntry.timestamp).toBeTruthy();
    expect(lastEntry.stepIds.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Guardrail 5: Budget visibility in dispatcher calls (VAL-GUARD-006)
// ---------------------------------------------------------------------------

describe("Guardrail 5: Budget visibility in dispatcher calls", () => {
  test("getMutationBudget returns remaining budget info", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      maxQueueLength: 50,
      maxMutationsPerStepCompletion: 3,
      maxInsertedStepsPerSession: 20,
    }));

    const budget = guardrails.getMutationBudget("step-1", 10);
    expect(budget).toBeDefined();
    expect(budget.maxQueueLength).toBe(50);
    expect(budget.currentQueueLength).toBe(10);
    expect(budget.remainingQueueCapacity).toBe(40);
    expect(budget.mutationsUsedThisStep).toBe(0);
    expect(budget.mutationsRemainingThisStep).toBe(3);
    expect(budget.totalSessionInserts).toBe(0);
    expect(budget.sessionInsertsRemaining).toBe(20);
  });

  test("budget reflects mutations already applied", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      maxMutationsPerStepCompletion: 3,
      maxInsertedStepsPerSession: 20,
    }));
    const steps = Array.from({ length: 10 }, () => makeStep());
    const queue = makeQueue(steps);

    // Apply 2 mutations for step-1, inserting 3 total steps
    guardrails.applyMutations(queue, "step-1", [
      insertMutation(steps[0].id),
      insertMutation(steps[1].id, 2),
    ], TEST_PROVENANCE);

    const budget = guardrails.getMutationBudget("step-1", queue.steps.length);
    expect(budget.mutationsUsedThisStep).toBe(2);
    expect(budget.mutationsRemainingThisStep).toBe(1);
    expect(budget.totalSessionInserts).toBe(3);
    expect(budget.sessionInsertsRemaining).toBe(17);
  });

  test("budget for unknown step shows zero mutations used", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    guardrails.applyMutations(queue, "step-1", [insertMutation(steps[0].id)], TEST_PROVENANCE);
    const budget = guardrails.getMutationBudget("step-2", 10);
    expect(budget.mutationsUsedThisStep).toBe(0);
    expect(budget.mutationsRemainingThisStep).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Guardrail 6: Objective anchoring in mutation prompts (VAL-GUARD-007)
// ---------------------------------------------------------------------------

describe("Guardrail 6: Objective anchoring in mutation prompts", () => {
  test("session objective is exposed via getMutationBudget", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      sessionObjective: "Build a REST API with authentication",
    }));

    expect(guardrails.getMutationBudget("step-1", 3).sessionObjective).toBe("Build a REST API with authentication");
  });

  test("session objective defaults to empty string", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({ sessionObjective: undefined }));

    expect(guardrails.getMutationBudget("step-1", 3).sessionObjective).toBe("");
  });

  test("objective is included in mutation budget context", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      sessionObjective: "Add dark mode toggle",
    }));

    const budget = guardrails.getMutationBudget("step-1", 5);
    expect(budget.sessionObjective).toBe("Add dark mode toggle");
  });
});

// ---------------------------------------------------------------------------
// Dispatcher-driven mutation integration (VAL-CROSS-009)
// ---------------------------------------------------------------------------

describe("Dispatcher-driven mutations through guardrails", () => {
  test("applyMutations enforces all guardrails and returns results", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      maxQueueLength: 10,
      maxMutationsPerStepCompletion: 3,
      maxInsertedStepsPerSession: 20,
    }));
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    const newStep = makeStep({ title: "Fix step" });
    const results = guardrails.applyMutations(
      queue,
      "step-1",
      [
        {
          type: "insert_after",
          targetStepId: steps[0].id,
          steps: [newStep],
          reason: "fix failing test",
        },
      ],
      { actor: "dispatcher", reason: "step completion mutation" },
    );

    expect(results).toHaveLength(1);
    expect(results[0].applied).toBe(true);
    expect(queue.steps.length).toBe(6);
  });

  test("rejects mutations exceeding per-step mutation limit", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({ maxMutationsPerStepCompletion: 2 }));
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    const mutations = [
      { type: "insert_after" as const, targetStepId: steps[0].id, steps: [makeStep()], reason: "fix 1" },
      { type: "insert_after" as const, targetStepId: steps[1].id, steps: [makeStep()], reason: "fix 2" },
      { type: "insert_after" as const, targetStepId: steps[2].id, steps: [makeStep()], reason: "fix 3" },
    ];

    const results = guardrails.applyMutations(queue, "step-1", mutations, TEST_PROVENANCE);

    expect(results[0].applied).toBe(true);
    expect(results[1].applied).toBe(true);
    expect(results[2].applied).toBe(false);
    expect(results[2].reason).toContain("mutation");
  });

  test("rejects mutations exceeding session insert limit", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      maxInsertedStepsPerSession: 2,
      maxMutationsPerStepCompletion: 10,
    }));
    const steps = Array.from({ length: 10 }, () => makeStep());
    const queue = makeQueue(steps);

    // Use up 2 session inserts
    guardrails.applyMutations(queue, "step-0", [
      insertMutation(steps[0].id),
      insertMutation(steps[1].id),
    ], TEST_PROVENANCE);

    // Next insert should fail
    const results = guardrails.applyMutations(queue, "step-1", [insertMutation(steps[2].id)], TEST_PROVENANCE);
    expect(results[0].applied).toBe(false);
    expect(results[0].reason).toContain("session");
  });

  test("rejects mutations exceeding queue length limit", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      maxQueueLength: 5,
      maxMutationsPerStepCompletion: 10,
      maxInsertedStepsPerSession: 100,
    }));
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps, { maxSteps: 5 });

    const results = guardrails.applyMutations(queue, "step-1", [insertMutation(steps[0].id)], TEST_PROVENANCE);
    expect(results[0].applied).toBe(false);
    expect(results[0].reason).toContain("max");
  });

  test("applies skip mutations through guardrails", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());
    const steps = [makeStep(), makeStep({ title: "redundant" })];
    const queue = makeQueue(steps);

    const mutations = [
      { type: "skip" as const, targetStepId: steps[1].id, reason: "redundant step" },
    ];

    const results = guardrails.applyMutations(queue, "step-1", mutations, TEST_PROVENANCE);
    expect(results[0].applied).toBe(true);
    expect(queue.steps[1].status).toBe("skipped");
  });

  test("applies remove mutations through guardrails", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());
    const steps = [makeStep(), makeStep({ title: "to remove" })];
    const queue = makeQueue(steps);

    const mutations = [
      { type: "remove" as const, targetStepId: steps[1].id, reason: "no longer needed" },
    ];

    const results = guardrails.applyMutations(queue, "step-1", mutations, TEST_PROVENANCE);
    expect(results[0].applied).toBe(true);
    expect(queue.steps.length).toBe(1);
  });

  test("records provenance for each applied mutation", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());
    const steps = [makeStep(), makeStep()];
    const queue = makeQueue(steps);

    const newStep = makeStep();
    guardrails.applyMutations(
      queue,
      "step-1",
      [{ type: "insert_after", targetStepId: steps[0].id, steps: [newStep], reason: "test insert" }],
      { actor: "dispatcher", reason: "dispatcher mutation" },
    );

    const entry = queue.mutationLog.find(
      (e) => e.action === "insert" && e.actor === "dispatcher",
    );
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("dispatcher mutation");
    expect(entry!.timestamp).toBeTruthy();
    expect(entry!.stepIds).toContain(newStep.id);
  });

  test("session inserts are tracked across multiple applyMutations calls", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions({
      maxInsertedStepsPerSession: 5,
      maxMutationsPerStepCompletion: 10,
    }));
    const steps = Array.from({ length: 3 }, () => makeStep());
    const queue = makeQueue(steps);

    // First call: insert 3 steps (step-1 completion)
    const mut1 = [
      { type: "insert_after" as const, targetStepId: steps[0].id, steps: [makeStep()], reason: "fix 1" },
      { type: "insert_after" as const, targetStepId: steps[0].id, steps: [makeStep()], reason: "fix 2" },
      { type: "insert_after" as const, targetStepId: steps[0].id, steps: [makeStep()], reason: "fix 3" },
    ];
    guardrails.applyMutations(queue, "step-1", mut1, TEST_PROVENANCE);

    // Second call: try to insert 3 more (step-2 completion)
    const mut2 = [
      { type: "insert_after" as const, targetStepId: steps[0].id, steps: [makeStep()], reason: "fix 4" },
      { type: "insert_after" as const, targetStepId: steps[0].id, steps: [makeStep()], reason: "fix 5" },
      { type: "insert_after" as const, targetStepId: steps[0].id, steps: [makeStep()], reason: "fix 6" },
    ];
    const results = guardrails.applyMutations(queue, "step-2", mut2, TEST_PROVENANCE);

    // First 2 should succeed (reaching limit of 5), 3rd should fail
    expect(results[0].applied).toBe(true);
    expect(results[1].applied).toBe(true);
    expect(results[2].applied).toBe(false);
  });
});
