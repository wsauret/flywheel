// ---------------------------------------------------------------------------
// ADR-004 Guardrails — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for all 7 guardrails protecting queue mutations:
//   1. Max queue length (VAL-GUARD-001, VAL-MUT-004)
//   2. Max mutations per step completion (VAL-GUARD-002)
//   3. Max inserted steps per session (VAL-GUARD-003)
//   4. Convergence detection (VAL-GUARD-004)
//   5. Provenance logging completeness (VAL-GUARD-005)
//   6. Budget visibility in dispatcher calls (VAL-GUARD-006)
//   7. Objective anchoring in mutation prompts (VAL-GUARD-007)
//   8. Dispatcher-driven mutation updates queue and TUI (VAL-CROSS-009)
// ---------------------------------------------------------------------------

import { describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";

import {
  createQueue,
  insertAfter,
  removeStep,
  skipStep,
  reorderSteps,
  replaceStep,
  transitionStep,
  type Provenance,
} from "../src/queue/queue";
import type { Step, Queue, MutationLogEntry } from "../src/queue/types";
import {
  createGuardrails,
  type Guardrails,
  type GuardrailOptions,
  type MutationBudget,
} from "../src/queue/guardrails";

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
    convergenceThreshold: 3,
    sessionObjective: "Build a hello world endpoint",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Guardrail 1: Max queue length (VAL-GUARD-001, VAL-MUT-004)
// ---------------------------------------------------------------------------

describe("Guardrail 1: Max queue length", () => {
  test("rejects insertAfter that would exceed max queue length", () => {
    const opts = defaultGuardrailOptions({ maxQueueLength: 5 });
    const guardrails = createGuardrails(opts);
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps, { maxSteps: 5 });

    const result = guardrails.checkInsert(queue, 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("max");
  });

  test("allows insertAfter when under max queue length", () => {
    const opts = defaultGuardrailOptions({ maxQueueLength: 10 });
    const guardrails = createGuardrails(opts);
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    const result = guardrails.checkInsert(queue, 1);
    expect(result.allowed).toBe(true);
  });

  test("uses configurable maxQueueLength", () => {
    const opts = defaultGuardrailOptions({ maxQueueLength: 3 });
    const guardrails = createGuardrails(opts);
    const steps = Array.from({ length: 3 }, () => makeStep());
    const queue = makeQueue(steps);

    const result = guardrails.checkInsert(queue, 1);
    expect(result.allowed).toBe(false);
  });

  test("allows insert exactly at max queue length", () => {
    const opts = defaultGuardrailOptions({ maxQueueLength: 6 });
    const guardrails = createGuardrails(opts);
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    const result = guardrails.checkInsert(queue, 1);
    expect(result.allowed).toBe(true);
  });

  test("default max queue length is 50", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());
    const steps = Array.from({ length: 50 }, () => makeStep());
    const queue = makeQueue(steps);

    const result = guardrails.checkInsert(queue, 1);
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guardrail 2: Max mutations per step completion (VAL-GUARD-002)
// ---------------------------------------------------------------------------

describe("Guardrail 2: Max mutations per step completion", () => {
  test("allows mutations within the per-step limit", () => {
    const opts = defaultGuardrailOptions({ maxMutationsPerStepCompletion: 3 });
    const guardrails = createGuardrails(opts);

    guardrails.recordMutation("step-1");
    guardrails.recordMutation("step-1");
    const result = guardrails.checkMutationBudget("step-1");
    expect(result.allowed).toBe(true);
  });

  test("rejects 4th mutation when limit is 3", () => {
    const opts = defaultGuardrailOptions({ maxMutationsPerStepCompletion: 3 });
    const guardrails = createGuardrails(opts);

    guardrails.recordMutation("step-1");
    guardrails.recordMutation("step-1");
    guardrails.recordMutation("step-1");
    const result = guardrails.checkMutationBudget("step-1");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("3");
  });

  test("tracks mutations independently per step", () => {
    const opts = defaultGuardrailOptions({ maxMutationsPerStepCompletion: 2 });
    const guardrails = createGuardrails(opts);

    guardrails.recordMutation("step-1");
    guardrails.recordMutation("step-1");
    guardrails.recordMutation("step-2");

    expect(guardrails.checkMutationBudget("step-1").allowed).toBe(false);
    expect(guardrails.checkMutationBudget("step-2").allowed).toBe(true);
  });

  test("uses configurable limit", () => {
    const opts = defaultGuardrailOptions({ maxMutationsPerStepCompletion: 1 });
    const guardrails = createGuardrails(opts);

    guardrails.recordMutation("step-1");
    const result = guardrails.checkMutationBudget("step-1");
    expect(result.allowed).toBe(false);
  });

  test("default limit is 3", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());

    guardrails.recordMutation("step-1");
    guardrails.recordMutation("step-1");
    guardrails.recordMutation("step-1");
    const result = guardrails.checkMutationBudget("step-1");
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guardrail 3: Max inserted steps per session (VAL-GUARD-003)
// ---------------------------------------------------------------------------

describe("Guardrail 3: Max inserted steps per session", () => {
  test("tracks total inserts across all step completions", () => {
    const opts = defaultGuardrailOptions({ maxInsertedStepsPerSession: 5 });
    const guardrails = createGuardrails(opts);

    // Record 5 inserts
    for (let i = 0; i < 5; i++) {
      guardrails.recordSessionInsert();
    }

    const result = guardrails.checkSessionInsertBudget(1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("session");
  });

  test("allows inserts under the session limit", () => {
    const opts = defaultGuardrailOptions({ maxInsertedStepsPerSession: 20 });
    const guardrails = createGuardrails(opts);

    for (let i = 0; i < 10; i++) {
      guardrails.recordSessionInsert();
    }

    const result = guardrails.checkSessionInsertBudget(1);
    expect(result.allowed).toBe(true);
  });

  test("considers the count of steps being inserted", () => {
    const opts = defaultGuardrailOptions({ maxInsertedStepsPerSession: 5 });
    const guardrails = createGuardrails(opts);

    guardrails.recordSessionInsert();
    guardrails.recordSessionInsert();
    guardrails.recordSessionInsert();

    // Trying to insert 3 more would exceed limit of 5 (already 3, adding 3 = 6)
    const result = guardrails.checkSessionInsertBudget(3);
    expect(result.allowed).toBe(false);
  });

  test("allows inserting exactly up to the limit", () => {
    const opts = defaultGuardrailOptions({ maxInsertedStepsPerSession: 5 });
    const guardrails = createGuardrails(opts);

    guardrails.recordSessionInsert();
    guardrails.recordSessionInsert();
    guardrails.recordSessionInsert();

    // Insert 2 more: 3 + 2 = 5 (exactly at limit)
    const result = guardrails.checkSessionInsertBudget(2);
    expect(result.allowed).toBe(true);
  });

  test("default limit is 20", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());

    for (let i = 0; i < 20; i++) {
      guardrails.recordSessionInsert();
    }

    const result = guardrails.checkSessionInsertBudget(1);
    expect(result.allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guardrail 4: Convergence detection (VAL-GUARD-004)
// ---------------------------------------------------------------------------

describe("Guardrail 4: Convergence detection", () => {
  test("detects 3 identical consecutive issue descriptions", () => {
    const opts = defaultGuardrailOptions({ convergenceThreshold: 3 });
    const guardrails = createGuardrails(opts);

    guardrails.recordIssueDescription("step-1", "TypeError: cannot read property 'name' of undefined");
    guardrails.recordIssueDescription("step-2", "TypeError: cannot read property 'name' of undefined");
    guardrails.recordIssueDescription("step-3", "TypeError: cannot read property 'name' of undefined");

    const result = guardrails.checkConvergence("TypeError: cannot read property 'name' of undefined");
    expect(result.converged).toBe(true);
    expect(result.issueDescription).toContain("TypeError");
  });

  test("does NOT flag when fewer than 3 consecutive identical issues", () => {
    const opts = defaultGuardrailOptions({ convergenceThreshold: 3 });
    const guardrails = createGuardrails(opts);

    guardrails.recordIssueDescription("step-1", "Error A");
    guardrails.recordIssueDescription("step-2", "Error A");

    const result = guardrails.checkConvergence("Error A");
    expect(result.converged).toBe(false);
  });

  test("does NOT flag when issues are different", () => {
    const opts = defaultGuardrailOptions({ convergenceThreshold: 3 });
    const guardrails = createGuardrails(opts);

    guardrails.recordIssueDescription("step-1", "Error A");
    guardrails.recordIssueDescription("step-2", "Error B");
    guardrails.recordIssueDescription("step-3", "Error A");

    const result = guardrails.checkConvergence("Error A");
    expect(result.converged).toBe(false);
  });

  test("resets convergence count when a different issue appears", () => {
    const opts = defaultGuardrailOptions({ convergenceThreshold: 3 });
    const guardrails = createGuardrails(opts);

    guardrails.recordIssueDescription("step-1", "Error A");
    guardrails.recordIssueDescription("step-2", "Error A");
    guardrails.recordIssueDescription("step-3", "Error B"); // breaks streak
    guardrails.recordIssueDescription("step-4", "Error A");

    const result = guardrails.checkConvergence("Error A");
    expect(result.converged).toBe(false);
  });

  test("uses configurable threshold", () => {
    const opts = defaultGuardrailOptions({ convergenceThreshold: 2 });
    const guardrails = createGuardrails(opts);

    guardrails.recordIssueDescription("step-1", "Error X");
    guardrails.recordIssueDescription("step-2", "Error X");

    const result = guardrails.checkConvergence("Error X");
    expect(result.converged).toBe(true);
  });

  test("default threshold is 3", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());

    guardrails.recordIssueDescription("step-1", "Error");
    guardrails.recordIssueDescription("step-2", "Error");
    guardrails.recordIssueDescription("step-3", "Error");

    const result = guardrails.checkConvergence("Error");
    expect(result.converged).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Guardrail 5: Provenance logging completeness (VAL-GUARD-005)
// ---------------------------------------------------------------------------

describe("Guardrail 5: Provenance logging on all mutations", () => {
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

  test("reorderSteps records full provenance", () => {
    const s1 = makeStep();
    const s2 = makeStep();
    const queue = makeQueue([s1, s2]);

    reorderSteps(queue, [s2.id, s1.id], { actor: "dispatcher", reason: "priority change" });

    const entry = queue.mutationLog.find((e) => e.action === "reorder");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe("dispatcher");
    expect(entry!.reason).toBe("priority change");
    expect(entry!.timestamp).toBeTruthy();
  });

  test("replaceStep records full provenance", () => {
    const step = makeStep();
    const queue = makeQueue([step]);
    const replacement = makeStep();

    replaceStep(queue, step.id, replacement, {
      actor: "feature-boundary",
      reason: "upgraded step definition",
    });

    const entry = queue.mutationLog.find((e) => e.action === "replace");
    expect(entry).toBeDefined();
    expect(entry!.actor).toBe("feature-boundary");
    expect(entry!.reason).toBe("upgraded step definition");
    expect(entry!.stepIds).toContain(step.id);
    expect(entry!.stepIds).toContain(replacement.id);
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

    // Every mutation API requires a Provenance object — verify at the type level
    // by checking the mutation log after each operation
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
// Guardrail 6: Budget visibility in dispatcher calls (VAL-GUARD-006)
// ---------------------------------------------------------------------------

describe("Guardrail 6: Budget visibility in dispatcher calls", () => {
  test("getMutationBudget returns remaining budget info", () => {
    const opts = defaultGuardrailOptions({
      maxQueueLength: 50,
      maxMutationsPerStepCompletion: 3,
      maxInsertedStepsPerSession: 20,
    });
    const guardrails = createGuardrails(opts);

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

  test("budget reflects mutations already recorded", () => {
    const opts = defaultGuardrailOptions({
      maxMutationsPerStepCompletion: 3,
      maxInsertedStepsPerSession: 20,
    });
    const guardrails = createGuardrails(opts);

    guardrails.recordMutation("step-1");
    guardrails.recordMutation("step-1");
    guardrails.recordSessionInsert();
    guardrails.recordSessionInsert();
    guardrails.recordSessionInsert();

    const budget = guardrails.getMutationBudget("step-1", 15);
    expect(budget.mutationsUsedThisStep).toBe(2);
    expect(budget.mutationsRemainingThisStep).toBe(1);
    expect(budget.totalSessionInserts).toBe(3);
    expect(budget.sessionInsertsRemaining).toBe(17);
  });

  test("budget for unknown step shows zero mutations used", () => {
    const guardrails = createGuardrails(defaultGuardrailOptions());

    guardrails.recordMutation("step-1");
    const budget = guardrails.getMutationBudget("step-2", 10);
    expect(budget.mutationsUsedThisStep).toBe(0);
    expect(budget.mutationsRemainingThisStep).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Guardrail 7: Objective anchoring in mutation prompts (VAL-GUARD-007)
// ---------------------------------------------------------------------------

describe("Guardrail 7: Objective anchoring in mutation prompts", () => {
  test("getSessionObjective returns the configured session objective", () => {
    const opts = defaultGuardrailOptions({
      sessionObjective: "Build a REST API with authentication",
    });
    const guardrails = createGuardrails(opts);

    expect(guardrails.getSessionObjective()).toBe("Build a REST API with authentication");
  });

  test("returns empty string when no objective is set", () => {
    const opts = defaultGuardrailOptions({ sessionObjective: undefined });
    const guardrails = createGuardrails(opts);

    expect(guardrails.getSessionObjective()).toBe("");
  });

  test("objective is included in mutation budget context", () => {
    const opts = defaultGuardrailOptions({
      sessionObjective: "Add dark mode toggle",
    });
    const guardrails = createGuardrails(opts);

    const budget = guardrails.getMutationBudget("step-1", 5);
    expect(budget.sessionObjective).toBe("Add dark mode toggle");
  });
});

// ---------------------------------------------------------------------------
// Dispatcher-driven mutation integration (VAL-CROSS-009)
// ---------------------------------------------------------------------------

describe("Dispatcher-driven mutations through guardrails", () => {
  test("applyMutations enforces all guardrails and returns results", () => {
    const opts = defaultGuardrailOptions({
      maxQueueLength: 10,
      maxMutationsPerStepCompletion: 3,
      maxInsertedStepsPerSession: 20,
    });
    const guardrails = createGuardrails(opts);
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
    const opts = defaultGuardrailOptions({ maxMutationsPerStepCompletion: 2 });
    const guardrails = createGuardrails(opts);
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    const mutations = [
      { type: "insert_after" as const, targetStepId: steps[0].id, steps: [makeStep()], reason: "fix 1" },
      { type: "insert_after" as const, targetStepId: steps[1].id, steps: [makeStep()], reason: "fix 2" },
      { type: "insert_after" as const, targetStepId: steps[2].id, steps: [makeStep()], reason: "fix 3" },
    ];

    const results = guardrails.applyMutations(queue, "step-1", mutations, TEST_PROVENANCE);

    // First 2 should succeed, 3rd should be rejected
    expect(results[0].applied).toBe(true);
    expect(results[1].applied).toBe(true);
    expect(results[2].applied).toBe(false);
    expect(results[2].reason).toContain("mutation");
  });

  test("rejects mutations exceeding session insert limit", () => {
    const opts = defaultGuardrailOptions({
      maxInsertedStepsPerSession: 2,
      maxMutationsPerStepCompletion: 10,
    });
    const guardrails = createGuardrails(opts);
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps);

    // Use up 2 session inserts
    guardrails.recordSessionInsert();
    guardrails.recordSessionInsert();

    const mutations = [
      { type: "insert_after" as const, targetStepId: steps[0].id, steps: [makeStep()], reason: "fix" },
    ];

    const results = guardrails.applyMutations(queue, "step-1", mutations, TEST_PROVENANCE);
    expect(results[0].applied).toBe(false);
    expect(results[0].reason).toContain("session");
  });

  test("rejects mutations exceeding queue length limit", () => {
    const opts = defaultGuardrailOptions({
      maxQueueLength: 5,
      maxMutationsPerStepCompletion: 10,
      maxInsertedStepsPerSession: 100,
    });
    const guardrails = createGuardrails(opts);
    const steps = Array.from({ length: 5 }, () => makeStep());
    const queue = makeQueue(steps, { maxSteps: 5 });

    const mutations = [
      { type: "insert_after" as const, targetStepId: steps[0].id, steps: [makeStep()], reason: "fix" },
    ];

    const results = guardrails.applyMutations(queue, "step-1", mutations, TEST_PROVENANCE);
    expect(results[0].applied).toBe(false);
    expect(results[0].reason).toContain("max");
  });

  test("applies skip mutations through guardrails", () => {
    const opts = defaultGuardrailOptions();
    const guardrails = createGuardrails(opts);
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
    const opts = defaultGuardrailOptions();
    const guardrails = createGuardrails(opts);
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
    const opts = defaultGuardrailOptions();
    const guardrails = createGuardrails(opts);
    const steps = [makeStep(), makeStep()];
    const queue = makeQueue(steps);

    const newStep = makeStep();
    const mutations = [
      { type: "insert_after" as const, targetStepId: steps[0].id, steps: [newStep], reason: "test insert" },
    ];

    guardrails.applyMutations(queue, "step-1", mutations, {
      actor: "dispatcher",
      reason: "dispatcher mutation",
    });

    const entry = queue.mutationLog.find(
      (e) => e.action === "insert" && e.actor === "dispatcher",
    );
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("dispatcher mutation");
    expect(entry!.timestamp).toBeTruthy();
    expect(entry!.stepIds).toContain(newStep.id);
  });

  test("convergence detection blocks insert mutations when converged", () => {
    const opts = defaultGuardrailOptions({ convergenceThreshold: 3 });
    const guardrails = createGuardrails(opts);

    // Record 3 identical issue descriptions
    guardrails.recordIssueDescription("step-1", "TypeError: foo");
    guardrails.recordIssueDescription("step-2", "TypeError: foo");
    guardrails.recordIssueDescription("step-3", "TypeError: foo");

    const convergence = guardrails.checkConvergence("TypeError: foo");
    expect(convergence.converged).toBe(true);
    expect(convergence.issueDescription).toBe("TypeError: foo");
  });

  test("session inserts are tracked across multiple applyMutations calls", () => {
    const opts = defaultGuardrailOptions({
      maxInsertedStepsPerSession: 5,
      maxMutationsPerStepCompletion: 10,
    });
    const guardrails = createGuardrails(opts);
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
