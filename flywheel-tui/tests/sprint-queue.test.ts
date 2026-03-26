// ---------------------------------------------------------------------------
// Sprint Queue Handler — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for createSprintQueueHandler(), the queue-based sprint implementation.
// Covers VAL-SPRINT-001..005, 007..009, 012..016.
// ---------------------------------------------------------------------------

import { describe, expect, test, mock, beforeEach } from "bun:test";
import { randomUUID } from "crypto";

import { createQueue, insertAfter, transitionStep, advanceCursor } from "../src/queue/queue";
import { buildQueueFromTemplate } from "../src/queue/templates";
import type { Step, Queue } from "../src/queue/types";
import type { FlywheelEmitter } from "../src/events/event-bus";
import type { VerificationResult } from "../src/sprint/verification-runner";
import {
  createSprintQueueHandler,
  type SprintQueueOptions,
  type SprintQueueHandler,
  type VerificationScriptRunner,
  type HandoffReaderFn,
} from "../src/queue/sprint";
import {
  createStepExecutor,
  type StepExecutorOptions,
  type DispatcherFn,
  type WorkerFn,
  type EvaluatorFn,
  type WorkerOutput,
  type BudgetChecker,
  type PersistFn,
  type StageContextAccumulator,
} from "../src/queue/executor";

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

/** Minimal no-op emitter that records events */
function createMockEmitter(): FlywheelEmitter & { events: Array<{ method: string; args: unknown[] }> } {
  const events: Array<{ method: string; args: unknown[] }> = [];
  const handler = {
    get(_target: unknown, prop: string) {
      if (prop === "events") return events;
      return (...args: unknown[]) => {
        events.push({ method: prop, args });
      };
    },
  };
  return new Proxy({} as FlywheelEmitter & { events: Array<{ method: string; args: unknown[] }> }, handler);
}

function createPassingVerification(): VerificationScriptRunner {
  return async () => ({
    passed: true,
    stdout: "All tests passed",
    stderr: "",
    exitCode: 0,
    durationMs: 100,
  });
}

function createFailingVerification(
  stdout = "Test failed: expected 1 got 0",
  stderr = "",
  exitCode = 1,
): VerificationScriptRunner {
  return async () => ({
    passed: false,
    stdout,
    stderr,
    exitCode,
    durationMs: 100,
  });
}

function createTimedOutVerification(): VerificationScriptRunner {
  return async () => ({
    passed: false,
    stdout: "",
    stderr: "",
    timedOut: true,
    durationMs: 30000,
  });
}

/** Create a verification runner that returns different results per call. */
function createSequentialVerification(results: VerificationResult[]): VerificationScriptRunner {
  let callIdx = 0;
  return async () => {
    const result = results[callIdx] ?? results[results.length - 1];
    callIdx++;
    return result;
  };
}

function createHandoffReader(data: Record<string, unknown> = {
  summary: "Implemented the feature",
  verification_script_path: ".flywheel/verify/test.ts",
}): HandoffReaderFn {
  return async () => data;
}

function createMissingHandoffReader(): HandoffReaderFn {
  return async () => null;
}

function createDefaultSprintOptions(
  overrides: Partial<SprintQueueOptions> = {},
): SprintQueueOptions {
  return {
    taskDescription: "Add a hello world endpoint",
    projectCwd: "/tmp/test-project",
    sprintConfig: {
      max_iterations: 5,
      verification_timeout_ms: 30000,
      escalate_to_full: true,
      escalate_on_stuck: false,
    },
    emitter: createMockEmitter(),
    workflowId: randomUUID(),
    runVerification: createPassingVerification(),
    readHandoff: createHandoffReader(),
    ...overrides,
  };
}

function createNoopPersist(): PersistFn {
  return async () => {};
}

function createNoopAccumulator(): StageContextAccumulator {
  return {
    accumulate: () => {},
    getContext: () => ({}),
  };
}

function createUnlimitedBudget(): BudgetChecker {
  return { isExhausted: () => false };
}

function createSuccessWorker(output = "done"): WorkerFn {
  return async (_step, _prompt) => ({
    output,
    handoffPath: `/tmp/handoff-${randomUUID()}.json`,
    durationMs: 100,
    sessionId: randomUUID(),
  });
}

function createSimpleDispatcher(prompt = "do the work"): DispatcherFn {
  return async (_step, _context) => ({
    prompt,
    validationCriteria: null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VAL-SPRINT-001: Sprint creates work + verify queue", () => {
  test("buildQueueFromTemplate('sprint') creates [work, verify] queue", () => {
    const queue = buildQueueFromTemplate("sprint");
    expect(queue.steps).toHaveLength(2);
    expect(queue.steps[0].type).toBe("work");
    expect(queue.steps[0].title).toBe("Sprint work");
    expect(queue.steps[0].status).toBe("pending");
    expect(queue.steps[1].type).toBe("verify");
    expect(queue.steps[1].title).toBe("Verify changes");
    expect(queue.steps[1].status).toBe("pending");
    expect(queue.cursor).toBe(0);
  });
});

describe("VAL-SPRINT-002: Work step uses sprint-specific prompt", () => {
  test("first iteration uses buildSprintPhasePrompt", () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions());
    const step = makeStep({ type: "work", title: "Sprint work" });
    const prompt = handler.buildWorkStepPrompt(step);

    expect(prompt).toContain("# Sprint Execution");
    expect(prompt).toContain("Add a hello world endpoint");
    expect(prompt).toContain("Verification Script");
    expect(prompt).not.toContain("Previous Attempts");
  });

  test("revision iteration uses buildSprintRevisionPrompt", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      runVerification: createFailingVerification(),
    }));

    // Simulate first iteration completion by calling onStepCompleted
    const queue = buildQueueFromTemplate("sprint");
    const workStep = queue.steps[0];
    workStep.status = "completed";

    // Complete work step
    await handler.onStepCompleted(workStep, "completed", queue, {
      summary: "First attempt",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    // Fail verify step
    const verifyStep = queue.steps[1];
    verifyStep.status = "failed";
    await handler.onStepCompleted(verifyStep, "failed", queue, {
      verificationResult: {
        passed: false,
        stdout: "Test failed",
        stderr: "",
        exitCode: 1,
        durationMs: 100,
      },
    });

    // Now the second iteration work step should use revision prompt
    const newWorkStep = queue.steps.find(
      (s) => s.type === "work" && s.status === "pending",
    );
    expect(newWorkStep).toBeDefined();
    const prompt = handler.buildWorkStepPrompt(newWorkStep!);
    expect(prompt).toContain("Previous Attempts");
    expect(prompt).toContain("Iteration 2 of 5");
  });
});

describe("VAL-SPRINT-003: Verify step runs verification script", () => {
  test("executeVerifyStep calls verification runner with script path from handoff", async () => {
    let capturedPath = "";
    let capturedOpts: { projectCwd: string; timeoutMs: number } | undefined;

    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      runVerification: async (scriptPath, opts) => {
        capturedPath = scriptPath;
        capturedOpts = opts;
        return { passed: true, stdout: "OK", stderr: "", exitCode: 0, durationMs: 50 };
      },
    }));

    const verifyStep = makeStep({ type: "verify", title: "Verify" });
    const result = await handler.executeVerifyStep(verifyStep, {
      verification_script_path: ".flywheel/verify/my-test.ts",
    });

    expect(result.passed).toBe(true);
    expect(capturedPath).toBe(".flywheel/verify/my-test.ts");
    expect(capturedOpts?.projectCwd).toBe("/tmp/test-project");
    expect(capturedOpts?.timeoutMs).toBe(30000);
  });

  test("executeVerifyStep returns failure when no handoff available", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions());
    const verifyStep = makeStep({ type: "verify", title: "Verify" });
    const result = await handler.executeVerifyStep(verifyStep, null);

    expect(result.passed).toBe(false);
    expect(result.error).toContain("No handoff available");
  });

  test("executeVerifyStep returns failure when handoff has no script path", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions());
    const verifyStep = makeStep({ type: "verify", title: "Verify" });
    const result = await handler.executeVerifyStep(verifyStep, {
      summary: "did stuff",
    });

    expect(result.passed).toBe(false);
    expect(result.error).toContain("No verification_script_path");
  });
});

describe("VAL-SPRINT-004: Failed verify inserts new work+verify pair", () => {
  test("on verify failure, new work+verify pair inserted after failed verify", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      runVerification: createFailingVerification(),
    }));

    const queue = buildQueueFromTemplate("sprint");
    const workStep = queue.steps[0];
    const verifyStep = queue.steps[1];

    // Complete work step
    workStep.status = "completed";
    await handler.onStepCompleted(workStep, "completed", queue, {
      summary: "Did the work",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    // Fail verify step
    verifyStep.status = "failed";
    await handler.onStepCompleted(verifyStep, "failed", queue, {
      verificationResult: {
        passed: false, stdout: "FAIL", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    // Queue should now have 4 steps: [work(done), verify(failed), work(pending), verify(pending)]
    expect(queue.steps).toHaveLength(4);
    expect(queue.steps[2].type).toBe("work");
    expect(queue.steps[2].status).toBe("pending");
    expect(queue.steps[2].title).toContain("iteration 2");
    expect(queue.steps[3].type).toBe("verify");
    expect(queue.steps[3].status).toBe("pending");
    expect(queue.steps[3].title).toContain("iteration 2");

    // Sprint state tracks iteration
    const state = handler.getState();
    expect(state.iterationCount).toBe(1);
    expect(state.iterationHistory).toHaveLength(1);
    expect(state.escalated).toBe(false);
    expect(state.completed).toBe(false);
  });

  test("verify failure result contains continueExecution: true", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      runVerification: createFailingVerification(),
    }));

    const queue = buildQueueFromTemplate("sprint");
    const workStep = queue.steps[0];
    const verifyStep = queue.steps[1];

    workStep.status = "completed";
    await handler.onStepCompleted(workStep, "completed", queue, {
      summary: "Did work",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    verifyStep.status = "failed";
    const result = await handler.onStepCompleted(verifyStep, "failed", queue, {
      verificationResult: {
        passed: false, stdout: "FAIL", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    expect(result.continueExecution).toBe(true);
  });
});

describe("VAL-SPRINT-005: Revision work step includes prior context", () => {
  test("revision prompt includes previous iteration summary and verification output", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      runVerification: createFailingVerification("expected: true, got: false"),
    }));

    const queue = buildQueueFromTemplate("sprint");
    const workStep = queue.steps[0];
    const verifyStep = queue.steps[1];

    // Complete first iteration work
    workStep.status = "completed";
    await handler.onStepCompleted(workStep, "completed", queue, {
      summary: "Added endpoint handler",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    // Fail first iteration verify
    verifyStep.status = "failed";
    await handler.onStepCompleted(verifyStep, "failed", queue, {
      verificationResult: {
        passed: false,
        stdout: "expected: true, got: false",
        stderr: "",
        exitCode: 1,
        durationMs: 100,
      },
    });

    // Get revision prompt for iteration 2
    const pendingWork = queue.steps.find(
      (s) => s.type === "work" && s.status === "pending",
    );
    const prompt = handler.buildWorkStepPrompt(pendingWork!);

    // Should contain iteration history
    expect(prompt).toContain("Previous Attempts");
    expect(prompt).toContain("Added endpoint handler");
    expect(prompt).toContain("expected: true, got: false");
  });
});

describe("VAL-SPRINT-007: Max iterations respected", () => {
  test("after max_iterations verify failures, escalation triggers", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      sprintConfig: {
        max_iterations: 2,
        verification_timeout_ms: 30000,
        escalate_to_full: true,
        escalate_on_stuck: false,
      },
      runVerification: createFailingVerification(),
    }));

    const queue = buildQueueFromTemplate("sprint");

    // -- Iteration 1 --
    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Attempt 1",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "FAIL 1", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    // After first fail, retry pair inserted
    expect(queue.steps).toHaveLength(4);

    // -- Iteration 2 --
    queue.steps[2].status = "completed";
    await handler.onStepCompleted(queue.steps[2], "completed", queue, {
      summary: "Attempt 2",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[3].status = "failed";
    await handler.onStepCompleted(queue.steps[3], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "FAIL 2", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    // max_iterations=2 reached → escalation steps inserted
    const state = handler.getState();
    expect(state.iterationCount).toBe(2);
    expect(state.escalated).toBe(true);

    // Escalation steps: [plan, work, review]
    const pendingSteps = queue.steps.filter((s) => s.status === "pending");
    expect(pendingSteps).toHaveLength(3);
    expect(pendingSteps[0].type).toBe("plan");
    expect(pendingSteps[1].type).toBe("work");
    expect(pendingSteps[2].type).toBe("review");
  });

  test("max_iterations=1 escalates after single failure", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      sprintConfig: {
        max_iterations: 1,
        verification_timeout_ms: 30000,
        escalate_to_full: true,
        escalate_on_stuck: false,
      },
    }));

    const queue = buildQueueFromTemplate("sprint");

    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Attempt 1",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "FAIL", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    const state = handler.getState();
    expect(state.iterationCount).toBe(1);
    expect(state.escalated).toBe(true);

    // Escalation steps inserted
    const pendingSteps = queue.steps.filter((s) => s.status === "pending");
    expect(pendingSteps).toHaveLength(3);
    expect(pendingSteps.map((s) => s.type)).toEqual(["plan", "work", "review"]);
  });

  test("escalate_to_full=false stops without inserting escalation steps", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      sprintConfig: {
        max_iterations: 1,
        verification_timeout_ms: 30000,
        escalate_to_full: false,
        escalate_on_stuck: false,
      },
    }));

    const queue = buildQueueFromTemplate("sprint");

    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Attempt 1",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    const result = await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "FAIL", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    // No escalation steps, but escalated flag is true
    expect(result.continueExecution).toBe(false);
    const state = handler.getState();
    expect(state.escalated).toBe(true);
    // Queue should still have just 2 steps
    expect(queue.steps).toHaveLength(2);
  });
});

describe("VAL-SPRINT-008: Escalation inserts plan→work→review", () => {
  test("escalation steps are in correct order: plan, work, review", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      sprintConfig: {
        max_iterations: 1,
        verification_timeout_ms: 30000,
        escalate_to_full: true,
        escalate_on_stuck: false,
      },
    }));

    const queue = buildQueueFromTemplate("sprint");

    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Attempt 1",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "FAIL", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    // Verify escalation steps are properly named
    const pendingSteps = queue.steps.filter((s) => s.status === "pending");
    expect(pendingSteps[0].type).toBe("plan");
    expect(pendingSteps[0].title).toContain("Escalation");
    expect(pendingSteps[1].type).toBe("work");
    expect(pendingSteps[1].title).toContain("Escalation");
    expect(pendingSteps[2].type).toBe("review");
    expect(pendingSteps[2].title).toContain("Escalation");
  });
});

describe("VAL-SPRINT-009: Escalation context carries iteration history", () => {
  test("getState returns escalation context with full history", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      sprintConfig: {
        max_iterations: 2,
        verification_timeout_ms: 30000,
        escalate_to_full: true,
        escalate_on_stuck: false,
      },
    }));

    const queue = buildQueueFromTemplate("sprint");

    // Iteration 1
    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Attempt 1: added handler",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "Test 1 failed", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    // Iteration 2
    queue.steps[2].status = "completed";
    await handler.onStepCompleted(queue.steps[2], "completed", queue, {
      summary: "Attempt 2: fixed route",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[3].status = "failed";
    await handler.onStepCompleted(queue.steps[3], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "Test 2 failed", stderr: "err", exitCode: 1, durationMs: 100,
      },
    });

    const state = handler.getState();
    expect(state.escalated).toBe(true);
    expect(state.escalationContext).toBeDefined();
    expect(state.escalationContext!.iterationsUsed).toBe(2);
    expect(state.escalationContext!.iterationHistory).toHaveLength(2);
    expect(state.escalationContext!.iterationHistory[0].workerSummary).toBe("Attempt 1: added handler");
    expect(state.escalationContext!.iterationHistory[1].workerSummary).toBe("Attempt 2: fixed route");
  });
});

describe("VAL-SPRINT-012: Verification timeout triggers retry logic", () => {
  test("timed out verification counts as failed iteration, inserts retry", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      runVerification: createTimedOutVerification(),
    }));

    const queue = buildQueueFromTemplate("sprint");

    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Work done",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    const result = await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "", stderr: "", timedOut: true, durationMs: 30000,
      },
    });

    expect(result.continueExecution).toBe(true);
    expect(queue.steps).toHaveLength(4); // original 2 + retry pair
    const state = handler.getState();
    expect(state.iterationCount).toBe(1);
    expect(state.iterationHistory[0].verificationResult?.timedOut).toBe(true);
  });
});

describe("VAL-SPRINT-013: Stuck detection triggers early escalation", () => {
  test("identical verify output 2 times with escalate_on_stuck=true triggers escalation", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      sprintConfig: {
        max_iterations: 5,
        verification_timeout_ms: 30000,
        escalate_to_full: true,
        escalate_on_stuck: true,
      },
    }));

    const queue = buildQueueFromTemplate("sprint");
    const sameOutput = {
      passed: false, stdout: "Error: X not found", stderr: "", exitCode: 1, durationMs: 100,
    };

    // Iteration 1
    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Attempt 1",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: sameOutput,
    });

    // Retry pair inserted for iteration 2
    expect(queue.steps).toHaveLength(4);

    // Iteration 2 — same output
    queue.steps[2].status = "completed";
    await handler.onStepCompleted(queue.steps[2], "completed", queue, {
      summary: "Attempt 2",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[3].status = "failed";
    const result = await handler.onStepCompleted(queue.steps[3], "failed", queue, {
      verificationResult: sameOutput,
    });

    // Stuck detected → escalation
    expect(result.continueExecution).toBe(true);
    const state = handler.getState();
    expect(state.escalated).toBe(true);
    expect(state.iterationCount).toBe(2);

    // Escalation steps inserted
    const pendingSteps = queue.steps.filter((s) => s.status === "pending");
    expect(pendingSteps).toHaveLength(3);
    expect(pendingSteps.map((s) => s.type)).toEqual(["plan", "work", "review"]);
  });

  test("different verify output does NOT trigger stuck detection", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      sprintConfig: {
        max_iterations: 5,
        verification_timeout_ms: 30000,
        escalate_to_full: true,
        escalate_on_stuck: true,
      },
    }));

    const queue = buildQueueFromTemplate("sprint");

    // Iteration 1
    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Attempt 1",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "Error A", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    // Iteration 2 — different output
    queue.steps[2].status = "completed";
    await handler.onStepCompleted(queue.steps[2], "completed", queue, {
      summary: "Attempt 2",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[3].status = "failed";
    await handler.onStepCompleted(queue.steps[3], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "Error B", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    // Not stuck — retry pair inserted instead of escalation
    const state = handler.getState();
    expect(state.escalated).toBe(false);
    expect(state.iterationCount).toBe(2);
    expect(queue.steps).toHaveLength(6); // original 2 + 2 retry pairs
  });

  test("escalate_on_stuck=false does not check for stuck", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      sprintConfig: {
        max_iterations: 5,
        verification_timeout_ms: 30000,
        escalate_to_full: true,
        escalate_on_stuck: false,
      },
    }));

    const queue = buildQueueFromTemplate("sprint");
    const sameOutput = {
      passed: false, stdout: "Same error", stderr: "", exitCode: 1, durationMs: 100,
    };

    // Two iterations with identical output
    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Attempt 1",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: sameOutput,
    });

    queue.steps[2].status = "completed";
    await handler.onStepCompleted(queue.steps[2], "completed", queue, {
      summary: "Attempt 2",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[3].status = "failed";
    await handler.onStepCompleted(queue.steps[3], "failed", queue, {
      verificationResult: sameOutput,
    });

    // Not escalated because escalate_on_stuck=false
    const state = handler.getState();
    expect(state.escalated).toBe(false);
    // Retry pair inserted instead
    expect(queue.steps).toHaveLength(6);
  });
});

describe("VAL-SPRINT-014: Sprint success completes queue", () => {
  test("verify passes → no more pairs inserted → sprint completed", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions());

    const queue = buildQueueFromTemplate("sprint");

    // Complete work step
    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Implementation done",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    // Complete verify step (passed)
    queue.steps[1].status = "completed";
    const result = await handler.onStepCompleted(queue.steps[1], "completed", queue, {
      verificationResult: {
        passed: true, stdout: "All tests passed", stderr: "", exitCode: 0, durationMs: 100,
      },
    });

    // No continuation needed — sprint succeeded
    expect(result.continueExecution).toBe(false);
    const state = handler.getState();
    expect(state.completed).toBe(true);
    expect(state.iterationCount).toBe(1);
    expect(state.escalated).toBe(false);
    // No new steps inserted
    expect(queue.steps).toHaveLength(2);
  });

  test("verify passes on second iteration → sprint success", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions());

    const queue = buildQueueFromTemplate("sprint");

    // Iteration 1: work passes, verify fails
    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Attempt 1",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "FAIL", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    // Iteration 2: work passes, verify passes
    queue.steps[2].status = "completed";
    await handler.onStepCompleted(queue.steps[2], "completed", queue, {
      summary: "Attempt 2",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[3].status = "completed";
    const result = await handler.onStepCompleted(queue.steps[3], "completed", queue, {
      verificationResult: {
        passed: true, stdout: "All passed", stderr: "", exitCode: 0, durationMs: 100,
      },
    });

    expect(result.continueExecution).toBe(false);
    const state = handler.getState();
    expect(state.completed).toBe(true);
    expect(state.iterationCount).toBe(2);
    expect(state.escalated).toBe(false);
    expect(queue.steps).toHaveLength(4); // No more pairs inserted
  });
});

describe("VAL-SPRINT-015: Worker crash counted as failed iteration", () => {
  test("work step failure (worker crash) counts as failed iteration, inserts retry", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions());

    const queue = buildQueueFromTemplate("sprint");

    // Work step fails (worker crash)
    queue.steps[0].status = "failed";
    const result = await handler.onStepCompleted(queue.steps[0], "failed", queue, null);

    expect(result.continueExecution).toBe(true);
    const state = handler.getState();
    expect(state.iterationCount).toBe(1);
    expect(state.iterationHistory[0].workerCrashed).toBe(true);

    // Verify step should be skipped, retry pair inserted
    expect(queue.steps[1].status).toBe("skipped");
    expect(queue.steps).toHaveLength(4); // original 2 + retry pair
    const pendingSteps = queue.steps.filter((s) => s.status === "pending");
    expect(pendingSteps).toHaveLength(2);
    expect(pendingSteps[0].type).toBe("work");
    expect(pendingSteps[1].type).toBe("verify");
  });

  test("worker crash at max_iterations triggers escalation", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      sprintConfig: {
        max_iterations: 1,
        verification_timeout_ms: 30000,
        escalate_to_full: true,
        escalate_on_stuck: false,
      },
    }));

    const queue = buildQueueFromTemplate("sprint");

    // Work step fails (worker crash)
    queue.steps[0].status = "failed";
    await handler.onStepCompleted(queue.steps[0], "failed", queue, null);

    const state = handler.getState();
    expect(state.iterationCount).toBe(1);
    expect(state.escalated).toBe(true);

    // Escalation steps should be present
    const pendingSteps = queue.steps.filter((s) => s.status === "pending");
    expect(pendingSteps.map((s) => s.type)).toEqual(["plan", "work", "review"]);
  });
});

describe("VAL-SPRINT-016: Missing handoff counted as failed iteration", () => {
  test("verify step with no handoff counts as failed iteration", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions());

    const queue = buildQueueFromTemplate("sprint");

    // Work completes but without script path in handoff
    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Did something",
      // No verification_script_path
    });

    // Verify step fails
    queue.steps[1].status = "failed";
    const result = await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "", stderr: "", error: "No verification_script_path", durationMs: 0,
      },
    });

    expect(result.continueExecution).toBe(true);
    const state = handler.getState();
    expect(state.iterationCount).toBe(1);
    expect(state.iterationHistory[0].missingArtifact).toContain("verification_script_path");
  });

  test("verify step with null handoff data counts as failed iteration", async () => {
    const handler = createSprintQueueHandler(createDefaultSprintOptions());

    const queue = buildQueueFromTemplate("sprint");

    // Work completes but handoff is null
    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, null);

    // Verify step fails
    queue.steps[1].status = "failed";
    const result = await handler.onStepCompleted(queue.steps[1], "failed", queue, null);

    expect(result.continueExecution).toBe(true);
    const state = handler.getState();
    expect(state.iterationCount).toBe(1);
    // Retry pair inserted
    expect(queue.steps).toHaveLength(4);
  });
});

describe("Step executor integration with onStepCompleted hook", () => {
  test("executor continues after failed step when hook returns continueExecution=true", async () => {
    const queue = createQueue([
      makeStep({ type: "work", title: "Work" }),
      makeStep({ type: "verify", title: "Verify" }),
    ]);

    let hookCalled = false;
    const executor = createStepExecutor({
      queue,
      workflowId: randomUUID(),
      emitter: createMockEmitter(),
      dispatcher: createSimpleDispatcher(),
      worker: async (step) => {
        if (step.type === "work") {
          return { output: "done", handoffPath: "/tmp/h.json", durationMs: 100 };
        }
        // verify step — simulate failure
        throw new Error("verify failed");
      },
      evaluator: null,
      handoffReader: async () => ({ summary: "done" }),
      budgetChecker: createUnlimitedBudget(),
      persist: createNoopPersist(),
      accumulator: createNoopAccumulator(),
      maxRevisions: 0,
      onStepCompleted: async (step, status, q, handoff) => {
        hookCalled = true;
        if (step.type === "verify" && status === "failed") {
          // Insert a new work step after the failed verify
          const newStep = makeStep({
            type: "work",
            title: "Retry work",
          });
          insertAfter(q, step.id, [newStep], {
            actor: "test",
            reason: "retry",
          });
          return { continueExecution: true };
        }
        return { continueExecution: false };
      },
    });

    const result = await executor.run();
    expect(hookCalled).toBe(true);
    // The verify step failed, but hook said continue → executor processed the new work step
    expect(result.stepsCompleted).toBe(2); // work + retry work
    // The verify step failed, the retry work completed
    expect(queue.steps).toHaveLength(3);
    expect(queue.steps[0].status).toBe("completed");
    expect(queue.steps[1].status).toBe("failed");
    expect(queue.steps[2].status).toBe("completed");
  });

  test("executor stops when hook returns continueExecution=false", async () => {
    const queue = createQueue([
      makeStep({ type: "work", title: "Work" }),
      makeStep({ type: "verify", title: "Verify" }),
    ]);

    const executor = createStepExecutor({
      queue,
      workflowId: randomUUID(),
      emitter: createMockEmitter(),
      dispatcher: createSimpleDispatcher(),
      worker: async (step) => {
        if (step.type === "work") {
          return { output: "done", handoffPath: "/tmp/h.json", durationMs: 100 };
        }
        throw new Error("verify failed");
      },
      evaluator: null,
      handoffReader: async () => ({ summary: "done" }),
      budgetChecker: createUnlimitedBudget(),
      persist: createNoopPersist(),
      accumulator: createNoopAccumulator(),
      maxRevisions: 0,
      onStepCompleted: async (_step, status, _q, _handoff) => {
        return { continueExecution: false };
      },
    });

    const result = await executor.run();
    expect(result.completed).toBe(false);
    expect(result.stepsCompleted).toBe(1); // Only the work step
    expect(result.reason).toContain("Verify");
  });

  test("onStepCompleted called for successful steps too", async () => {
    const queue = createQueue([
      makeStep({ type: "work", title: "Work 1" }),
      makeStep({ type: "work", title: "Work 2" }),
    ]);

    const hookCalls: Array<{ type: string; status: string }> = [];

    const executor = createStepExecutor({
      queue,
      workflowId: randomUUID(),
      emitter: createMockEmitter(),
      dispatcher: createSimpleDispatcher(),
      worker: createSuccessWorker(),
      evaluator: null,
      handoffReader: async () => ({ summary: "done" }),
      budgetChecker: createUnlimitedBudget(),
      persist: createNoopPersist(),
      accumulator: createNoopAccumulator(),
      maxRevisions: 0,
      onStepCompleted: async (step, status) => {
        hookCalls.push({ type: step.type, status });
        return { continueExecution: false };
      },
    });

    await executor.run();
    expect(hookCalls).toHaveLength(2);
    expect(hookCalls[0]).toEqual({ type: "work", status: "completed" });
    expect(hookCalls[1]).toEqual({ type: "work", status: "completed" });
  });

  test("executor updates stepsTotal when queue grows dynamically", async () => {
    const queue = createQueue([
      makeStep({ type: "work", title: "Step 1" }),
    ]);

    const executor = createStepExecutor({
      queue,
      workflowId: randomUUID(),
      emitter: createMockEmitter(),
      dispatcher: createSimpleDispatcher(),
      worker: createSuccessWorker(),
      evaluator: null,
      handoffReader: async () => ({ summary: "done" }),
      budgetChecker: createUnlimitedBudget(),
      persist: createNoopPersist(),
      accumulator: createNoopAccumulator(),
      maxRevisions: 0,
      onStepCompleted: async (step, status, q) => {
        // Insert a new step on the first completion
        if (q.steps.length === 1) {
          insertAfter(q, step.id, [makeStep({ type: "work", title: "Step 2" })], {
            actor: "test",
            reason: "dynamic insert",
          });
        }
        return { continueExecution: false };
      },
    });

    const result = await executor.run();
    expect(result.completed).toBe(true);
    expect(result.stepsTotal).toBe(2);
    expect(result.stepsCompleted).toBe(2);
  });
});

describe("Event emission", () => {
  test("sprint handler emits queueStepInserted for retry pairs", async () => {
    const emitter = createMockEmitter();
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      emitter,
    }));

    const queue = buildQueueFromTemplate("sprint");

    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Work done",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "FAIL", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    const insertEvents = emitter.events.filter((e) => e.method === "queueStepInserted");
    expect(insertEvents).toHaveLength(2); // work + verify
  });

  test("sprint handler emits queueStepInserted for escalation steps", async () => {
    const emitter = createMockEmitter();
    const handler = createSprintQueueHandler(createDefaultSprintOptions({
      emitter,
      sprintConfig: {
        max_iterations: 1,
        verification_timeout_ms: 30000,
        escalate_to_full: true,
        escalate_on_stuck: false,
      },
    }));

    const queue = buildQueueFromTemplate("sprint");

    queue.steps[0].status = "completed";
    await handler.onStepCompleted(queue.steps[0], "completed", queue, {
      summary: "Attempt 1",
      verification_script_path: ".flywheel/verify/test.ts",
    });

    queue.steps[1].status = "failed";
    await handler.onStepCompleted(queue.steps[1], "failed", queue, {
      verificationResult: {
        passed: false, stdout: "FAIL", stderr: "", exitCode: 1, durationMs: 100,
      },
    });

    const insertEvents = emitter.events.filter((e) => e.method === "queueStepInserted");
    expect(insertEvents).toHaveLength(3); // plan + work + review
  });
});
