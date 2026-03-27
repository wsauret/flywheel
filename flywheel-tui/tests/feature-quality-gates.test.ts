// ---------------------------------------------------------------------------
// Feature Quality Gates — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for feature boundary detection, quality check step insertion,
// sealed feature mutation rejection, and multi-feature independence.
// Covers VAL-HOOK-009, VAL-HOOK-010, VAL-HOOK-011, VAL-CROSS-005.
// ---------------------------------------------------------------------------

import { describe, expect, test, beforeEach } from "bun:test";
import { randomUUID } from "crypto";

import { createQueue, insertAfter, removeStep, skipStep, replaceStep, reorderSteps, type Provenance } from "../src/queue/queue";
import type { Step, Queue } from "../src/queue/types";
import {
  createFeatureQualityGateHook,
  isFeatureBoundary,
  buildQualityCheckStep,
  type FeatureQualityGateState,
} from "../src/queue/feature-quality-gates";

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

const TEST_PROVENANCE: Provenance = {
  actor: "test",
  reason: "unit test",
};

// ---------------------------------------------------------------------------
// isFeatureBoundary — pure detection logic
// ---------------------------------------------------------------------------

describe("isFeatureBoundary", () => {
  test("returns true when all steps with same feature are terminal (completed)", () => {
    const steps: Step[] = [
      makeStep({ feature: "auth", status: "completed" }),
      makeStep({ feature: "auth", status: "completed" }),
      makeStep({ feature: "api", status: "pending" }),
    ];
    expect(isFeatureBoundary(steps, "auth")).toBe(true);
  });

  test("returns true when all feature steps are in mixed terminal states (completed/failed/skipped)", () => {
    const steps: Step[] = [
      makeStep({ feature: "auth", status: "completed" }),
      makeStep({ feature: "auth", status: "failed" }),
      makeStep({ feature: "auth", status: "skipped" }),
    ];
    expect(isFeatureBoundary(steps, "auth")).toBe(true);
  });

  test("returns false when some feature steps are still pending", () => {
    const steps: Step[] = [
      makeStep({ feature: "auth", status: "completed" }),
      makeStep({ feature: "auth", status: "pending" }),
    ];
    expect(isFeatureBoundary(steps, "auth")).toBe(false);
  });

  test("returns false when some feature steps are running", () => {
    const steps: Step[] = [
      makeStep({ feature: "auth", status: "completed" }),
      makeStep({ feature: "auth", status: "running" }),
    ];
    expect(isFeatureBoundary(steps, "auth")).toBe(false);
  });

  test("returns false when no steps have the given feature", () => {
    const steps: Step[] = [
      makeStep({ feature: "api", status: "completed" }),
    ];
    expect(isFeatureBoundary(steps, "auth")).toBe(false);
  });

  test("ignores steps without a feature field", () => {
    const steps: Step[] = [
      makeStep({ feature: "auth", status: "completed" }),
      makeStep({ status: "pending" }), // no feature — ungrouped
    ];
    expect(isFeatureBoundary(steps, "auth")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildQualityCheckStep — step construction
// ---------------------------------------------------------------------------

describe("buildQualityCheckStep", () => {
  test("creates a verify-type step with correct title", () => {
    const featureSteps: Step[] = [
      makeStep({ feature: "auth", title: "implement user model", fulfills: ["VAL-AUTH-001"] }),
      makeStep({ feature: "auth", title: "add auth middleware" }),
    ];

    const step = buildQualityCheckStep("auth", featureSteps);

    expect(step.type).toBe("verify");
    expect(step.title).toBe("[auth] feature quality check");
    expect(step.status).toBe("pending");
    expect(step.feature).toBe("auth");
  });

  test("includes sub-agent dispatch prompt in description", () => {
    const featureSteps: Step[] = [
      makeStep({ feature: "auth", title: "implement user model" }),
    ];

    const step = buildQualityCheckStep("auth", featureSteps);

    expect(step.description).toBeDefined();
    expect(step.description).toContain("Scrutiny");
    expect(step.description).toContain("Behavioral testing");
    expect(step.description).toContain("sub-agent");
  });

  test("includes fulfills from all feature steps", () => {
    const featureSteps: Step[] = [
      makeStep({ feature: "auth", fulfills: ["VAL-AUTH-001", "VAL-AUTH-002"] }),
      makeStep({ feature: "auth", fulfills: ["VAL-AUTH-003"] }),
      makeStep({ feature: "auth" }), // no fulfills
    ];

    const step = buildQualityCheckStep("auth", featureSteps);

    expect(step.fulfills).toEqual(["VAL-AUTH-001", "VAL-AUTH-002", "VAL-AUTH-003"]);
  });

  test("is a single step (not multiple)", () => {
    const featureSteps: Step[] = [
      makeStep({ feature: "auth" }),
    ];

    const step = buildQualityCheckStep("auth", featureSteps);

    // It returns a single Step, not an array
    expect(step.id).toBeDefined();
    expect(typeof step.id).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// createFeatureQualityGateHook — hook behavior
// ---------------------------------------------------------------------------

describe("createFeatureQualityGateHook", () => {
  test("inserts quality check when all feature steps reach terminal status", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed", title: "auth step 1" });
    const s2 = makeStep({ feature: "auth", status: "pending", title: "auth step 2" });
    const queue = createQueue([s1, s2]);
    // Manually set statuses (createQueue resets to pending)
    queue.steps[0].status = "completed";
    queue.steps[1].status = "completed"; // simulate both completed

    const hook = createFeatureQualityGateHook();
    const result = await hook.onStepCompleted(s2, "completed", queue, null);

    // Should have inserted a quality check step
    expect(queue.steps.length).toBe(3);
    expect(queue.steps[2].type).toBe("verify");
    expect(queue.steps[2].title).toBe("[auth] feature quality check");
    expect(result.continueExecution).toBe(false);
  });

  test("does NOT insert quality check when feature is partially complete", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed", title: "auth step 1" });
    const s2 = makeStep({ feature: "auth", status: "pending", title: "auth step 2" });
    const queue = createQueue([s1, s2]);
    queue.steps[0].status = "completed";
    // s2 is still pending

    const hook = createFeatureQualityGateHook();
    const result = await hook.onStepCompleted(s1, "completed", queue, null);

    // No quality check inserted
    expect(queue.steps.length).toBe(2);
    expect(result.continueExecution).toBe(false);
  });

  test("does NOT trigger for steps without a feature field", async () => {
    const s1 = makeStep({ status: "completed", title: "ungrouped step" });
    const queue = createQueue([s1]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();
    const result = await hook.onStepCompleted(s1, "completed", queue, null);

    expect(queue.steps.length).toBe(1);
    expect(result.continueExecution).toBe(false);
  });

  test("does NOT trigger for steps with empty feature string", async () => {
    const s1 = makeStep({ feature: "", status: "completed", title: "empty feature" });
    const queue = createQueue([s1]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();
    const result = await hook.onStepCompleted(s1, "completed", queue, null);

    expect(queue.steps.length).toBe(1);
    expect(result.continueExecution).toBe(false);
  });

  test("tracks multiple features independently", async () => {
    const authStep = makeStep({ feature: "auth", status: "completed", title: "auth impl" });
    const apiStep = makeStep({ feature: "api", status: "pending", title: "api impl" });
    const queue = createQueue([authStep, apiStep]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();

    // Complete auth — should trigger quality check for auth
    const r1 = await hook.onStepCompleted(authStep, "completed", queue, null);
    expect(queue.steps.length).toBe(3); // auth, [auth] quality check, api
    // Quality check inserted after auth step (the last step in feature "auth")
    const authQc = queue.steps.find(s => s.title === "[auth] feature quality check");
    expect(authQc).toBeDefined();

    // api is still pending — no quality check for api
    expect(queue.steps.filter(s => s.title.includes("[api]")).length).toBe(0);

    // Complete api — need to find the actual apiStep in the queue since indices shifted
    const apiInQueue = queue.steps.find(s => s.title === "api impl")!;
    apiInQueue.status = "completed";
    const r2 = await hook.onStepCompleted(apiInQueue, "completed", queue, null);
    expect(queue.steps.length).toBe(4);
    const apiQc = queue.steps.find(s => s.title === "[api] feature quality check");
    expect(apiQc).toBeDefined();
  });

  test("does NOT insert duplicate quality check for same feature", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed", title: "auth step 1" });
    const s2 = makeStep({ feature: "auth", status: "completed", title: "auth step 2" });
    const queue = createQueue([s1, s2]);
    queue.steps[0].status = "completed";
    queue.steps[1].status = "completed";

    const hook = createFeatureQualityGateHook();

    // First call: insert quality check
    await hook.onStepCompleted(s1, "completed", queue, null);
    expect(queue.steps.length).toBe(3);

    // Second call: should NOT duplicate
    await hook.onStepCompleted(s2, "completed", queue, null);
    expect(queue.steps.length).toBe(3);
  });

  test("inserts quality check after the last step of the feature", async () => {
    const authStep1 = makeStep({ feature: "auth", title: "auth step 1" });
    const apiStep = makeStep({ feature: "api", title: "api step" });
    const authStep2 = makeStep({ feature: "auth", title: "auth step 2" });
    const queue = createQueue([authStep1, apiStep, authStep2]);
    queue.steps[0].status = "completed";
    queue.steps[2].status = "completed";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(queue.steps[2], "completed", queue, null);

    // Quality check should be after authStep2 (index 2), so at index 3
    expect(queue.steps[3].title).toBe("[auth] feature quality check");
    expect(queue.steps[3].type).toBe("verify");
  });

  test("logs quality check insertion with feature-boundary provenance", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed" });
    const queue = createQueue([s1]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(s1, "completed", queue, null);

    // Check mutation log for provenance
    const insertEntry = queue.mutationLog.find(e => e.action === "insert");
    expect(insertEntry).toBeDefined();
    expect(insertEntry!.actor).toBe("feature-boundary");
    expect(insertEntry!.reason).toContain("auth");
  });

  test("handles failed steps in feature boundary detection", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed" });
    const s2 = makeStep({ feature: "auth", status: "failed" });
    const queue = createQueue([s1, s2]);
    queue.steps[0].status = "completed";
    queue.steps[1].status = "failed";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(s2, "failed", queue, null);

    // Feature boundary reached (all terminal: completed + failed)
    expect(queue.steps.length).toBe(3);
    expect(queue.steps[2].title).toBe("[auth] feature quality check");
  });

  test("handles skipped steps in feature boundary detection", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed" });
    const s2 = makeStep({ feature: "auth", status: "skipped" });
    const queue = createQueue([s1, s2]);
    queue.steps[0].status = "completed";
    queue.steps[1].status = "skipped";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(s1, "completed", queue, null);

    expect(queue.steps.length).toBe(3);
    expect(queue.steps[2].title).toBe("[auth] feature quality check");
  });
});

// ---------------------------------------------------------------------------
// Sealed features — mutation rejection
// ---------------------------------------------------------------------------

describe("sealed features — mutation rejection", () => {
  test("seals feature after quality check step completes", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed", title: "auth impl" });
    const queue = createQueue([s1]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();

    // Trigger quality check insertion
    await hook.onStepCompleted(s1, "completed", queue, null);
    expect(queue.steps.length).toBe(2);
    const qcStep = queue.steps[1];
    expect(qcStep.title).toBe("[auth] feature quality check");

    // Simulate quality check completing successfully
    qcStep.status = "completed";
    await hook.onStepCompleted(qcStep, "completed", queue, null);

    // Feature should now be sealed
    const state = hook.getState();
    expect(state.sealedFeatures).toContain("auth");
  });

  test("rejects insertAfter targeting sealed feature steps", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed", title: "auth impl" });
    const queue = createQueue([s1]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();

    // Insert + seal
    await hook.onStepCompleted(s1, "completed", queue, null);
    const qcStep = queue.steps[1];
    qcStep.status = "completed";
    await hook.onStepCompleted(qcStep, "completed", queue, null);

    // Try to insert after a sealed feature step
    const newStep = makeStep({ title: "new step" });
    const result = hook.guardMutation("insertAfter", s1.id, queue);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("sealed");
    expect(result.reason).toContain("auth");
  });

  test("rejects replaceStep targeting sealed feature steps", async () => {
    // Setup sealed feature with a pending step that becomes sealed after QC
    const s1 = makeStep({ feature: "auth", status: "completed", title: "auth impl" });
    const queue = createQueue([s1]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(s1, "completed", queue, null);
    const qcStep = queue.steps[1];
    qcStep.status = "completed";
    await hook.onStepCompleted(qcStep, "completed", queue, null);

    const result = hook.guardMutation("replace", s1.id, queue);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("sealed");
  });

  test("rejects removeStep targeting sealed feature steps", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed", title: "auth impl" });
    const queue = createQueue([s1]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(s1, "completed", queue, null);
    const qcStep = queue.steps[1];
    qcStep.status = "completed";
    await hook.onStepCompleted(qcStep, "completed", queue, null);

    const result = hook.guardMutation("remove", s1.id, queue);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("sealed");
  });

  test("allows mutations on non-sealed feature steps", async () => {
    const authStep = makeStep({ feature: "auth", status: "completed" });
    const apiStep = makeStep({ feature: "api", status: "pending" });
    const queue = createQueue([authStep, apiStep]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(authStep, "completed", queue, null);
    const qcStep = queue.steps.find(s => s.title === "[auth] feature quality check")!;
    qcStep.status = "completed";
    await hook.onStepCompleted(qcStep, "completed", queue, null);

    // api is NOT sealed
    const result = hook.guardMutation("remove", apiStep.id, queue);
    expect(result.allowed).toBe(true);
  });

  test("allows mutations on steps without a feature", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed" });
    const ungrouped = makeStep({ status: "pending", title: "ungrouped" });
    const queue = createQueue([s1, ungrouped]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(s1, "completed", queue, null);
    const qcStep = queue.steps.find(s => s.title === "[auth] feature quality check")!;
    qcStep.status = "completed";
    await hook.onStepCompleted(qcStep, "completed", queue, null);

    // Ungrouped step should be allowed
    const result = hook.guardMutation("remove", ungrouped.id, queue);
    expect(result.allowed).toBe(true);
  });

  test("does NOT seal feature when quality check fails", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed" });
    const queue = createQueue([s1]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(s1, "completed", queue, null);
    const qcStep = queue.steps[1];
    qcStep.status = "failed";
    await hook.onStepCompleted(qcStep, "failed", queue, null);

    const state = hook.getState();
    expect(state.sealedFeatures).not.toContain("auth");
  });
});

// ---------------------------------------------------------------------------
// Integration: quality check in executor context (VAL-CROSS-005)
// ---------------------------------------------------------------------------

describe("integration — quality check in executor context", () => {
  test("quality check step carries feature field matching the feature group", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed" });
    const s2 = makeStep({ feature: "auth", status: "completed" });
    const queue = createQueue([s1, s2]);
    queue.steps[0].status = "completed";
    queue.steps[1].status = "completed";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(s2, "completed", queue, null);

    const qcStep = queue.steps[2];
    expect(qcStep.feature).toBe("auth");
  });

  test("quality check step has unique UUID", async () => {
    const s1 = makeStep({ feature: "auth", status: "completed" });
    const queue = createQueue([s1]);
    queue.steps[0].status = "completed";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(s1, "completed", queue, null);

    const qcStep = queue.steps[1];
    expect(qcStep.id).toBeDefined();
    expect(qcStep.id.length).toBeGreaterThan(0);
    expect(qcStep.id).not.toBe(s1.id);
  });

  test("quality check prompt mentions step titles for context", async () => {
    const s1 = makeStep({ feature: "auth", title: "implement user model", status: "completed" });
    const s2 = makeStep({ feature: "auth", title: "add auth routes", status: "completed" });
    const queue = createQueue([s1, s2]);
    queue.steps[0].status = "completed";
    queue.steps[1].status = "completed";

    const hook = createFeatureQualityGateHook();
    await hook.onStepCompleted(s2, "completed", queue, null);

    const qcStep = queue.steps[2];
    expect(qcStep.description).toContain("implement user model");
    expect(qcStep.description).toContain("add auth routes");
  });

  test("multiple features seal independently", async () => {
    const authStep = makeStep({ feature: "auth", status: "completed" });
    const apiStep = makeStep({ feature: "api", status: "completed" });
    const queue = createQueue([authStep, apiStep]);
    queue.steps[0].status = "completed";
    queue.steps[1].status = "completed";

    const hook = createFeatureQualityGateHook();

    // Complete auth feature
    await hook.onStepCompleted(authStep, "completed", queue, null);
    const authQc = queue.steps.find(s => s.title === "[auth] feature quality check")!;
    authQc.status = "completed";
    await hook.onStepCompleted(authQc, "completed", queue, null);

    // Complete api feature
    await hook.onStepCompleted(apiStep, "completed", queue, null);
    const apiQc = queue.steps.find(s => s.title === "[api] feature quality check")!;
    apiQc.status = "completed";
    await hook.onStepCompleted(apiQc, "completed", queue, null);

    const state = hook.getState();
    expect(state.sealedFeatures).toContain("auth");
    expect(state.sealedFeatures).toContain("api");

    // Auth sealed — reject mutation
    const authGuard = hook.guardMutation("remove", authStep.id, queue);
    expect(authGuard.allowed).toBe(false);

    // Api sealed — reject mutation
    const apiGuard = hook.guardMutation("remove", apiStep.id, queue);
    expect(apiGuard.allowed).toBe(false);
  });
});
