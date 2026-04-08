// ---------------------------------------------------------------------------
// Tiered Evaluation — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for the tiered evaluation model: which step types get which
// combination of native checks, self-review, and evaluator.
//
// The createPostTurnVerificationHook factory composes the hook based on
// step type. The step-runner calls the hook without knowing the internals.
// ---------------------------------------------------------------------------

import { describe, expect, test, mock } from "bun:test";
import { randomUUID } from "crypto";

import type { Step } from "../src/workflows/queue/types";
import type { WorkerOutput } from "../src/workflows/queue/executor-types.js";
import {
  createPostTurnVerificationHook,
  SELF_REVIEW_CHECKLIST,
  type PostTurnVerificationConfig,
} from "../src/workflows/queue/post-turn-verification.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStep(overrides: Partial<Step> = {}): Step {
  return {
    id: randomUUID(),
    type: "work",
    title: "Test step",
    status: "running",
    ...overrides,
  };
}

function makeWorkerOutput(overrides: Partial<WorkerOutput> = {}): WorkerOutput {
  return {
    output: "done",
    handoffPath: `/tmp/handoff-${randomUUID()}.json`,
    durationMs: 100,
    sessionId: randomUUID(),
    ...overrides,
  };
}

function makeConfig(overrides: Partial<PostTurnVerificationConfig> = {}): PostTurnVerificationConfig {
  return {
    nativeChecks: false, // Disable native checks by default to avoid subprocess spawning in tests
    nativeCheckTypes: ["build", "test", "lint"],
    selfReview: true,
    maxFixAttempts: 2,
    projectCwd: "/tmp/test-project",
    ...overrides,
  };
}

// ===========================================================================
// Tiered Evaluation: step type determines verification behavior
// ===========================================================================

describe("Tiered Evaluation", () => {
  test("work step (type: 'work'): self-review + native checks, evaluator null", async () => {
    const stdinWrite = mock((_msg: string) => {});
    const awaitNextTurn = mock(async (): Promise<WorkerOutput> => makeWorkerOutput());

    const config = makeConfig({ selfReview: true, nativeChecks: false });
    const hook = createPostTurnVerificationHook(config, stdinWrite, awaitNextTurn);

    const step = makeStep({ type: "work" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: { summary: "done" },
    });

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    expect(result!.selfReviewCompleted).toBe(true);
    // Self-review checklist was injected via stdin
    expect(stdinWrite).toHaveBeenCalledTimes(1);
    expect(stdinWrite.mock.calls[0][0]).toBe(SELF_REVIEW_CHECKLIST);
    expect(awaitNextTurn).toHaveBeenCalledTimes(1);
  });

  test("plan step (type: 'plan'): hook returns null (no verification)", async () => {
    const stdinWrite = mock((_msg: string) => {});
    const awaitNextTurn = mock(async (): Promise<WorkerOutput> => makeWorkerOutput());

    const config = makeConfig({ selfReview: true, nativeChecks: true });
    const hook = createPostTurnVerificationHook(config, stdinWrite, awaitNextTurn);

    const step = makeStep({ type: "plan" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).toBeNull();
    expect(stdinWrite).not.toHaveBeenCalled();
    expect(awaitNextTurn).not.toHaveBeenCalled();
  });

  test("debug step (type: 'debug'): self-review runs (code step)", async () => {
    const stdinWrite = mock((_msg: string) => {});
    const awaitNextTurn = mock(async (): Promise<WorkerOutput> => makeWorkerOutput());

    const config = makeConfig({ selfReview: true, nativeChecks: false });
    const hook = createPostTurnVerificationHook(config, stdinWrite, awaitNextTurn);

    const step = makeStep({ type: "debug" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: { summary: "fixed bug" },
    });

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    expect(result!.selfReviewCompleted).toBe(true);
    expect(stdinWrite).toHaveBeenCalledTimes(1);
  });

  test("verify step (type: 'verify'): hook returns null (no verification)", async () => {
    const stdinWrite = mock((_msg: string) => {});
    const awaitNextTurn = mock(async (): Promise<WorkerOutput> => makeWorkerOutput());

    const config = makeConfig({ selfReview: true, nativeChecks: true });
    const hook = createPostTurnVerificationHook(config, stdinWrite, awaitNextTurn);

    const step = makeStep({ type: "verify" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).toBeNull();
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  test("ship step (type: 'ship'): native git checks only, no self-review", async () => {
    // Ship steps get verification but NOT self-review.
    // We disable nativeChecks to avoid spawning real subprocesses.
    const stdinWrite = mock((_msg: string) => {});
    const awaitNextTurn = mock(async (): Promise<WorkerOutput> => makeWorkerOutput());

    const config = makeConfig({ selfReview: true, nativeChecks: false });
    const hook = createPostTurnVerificationHook(config, stdinWrite, awaitNextTurn);

    const step = makeStep({ type: "ship" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    // Ship steps skip self-review even when config.selfReview is true
    expect(result!.selfReviewCompleted).toBe(false);
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  test("review step (type: 'review'): hook returns null (no verification)", async () => {
    const config = makeConfig({ selfReview: true, nativeChecks: true });
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "review" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).toBeNull();
  });

  test("research step (type: 'research'): hook returns null (no verification)", async () => {
    const config = makeConfig({ selfReview: true, nativeChecks: true });
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "research" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).toBeNull();
  });

  test("gate step (type: 'gate'): hook returns null (no verification)", async () => {
    const config = makeConfig({ selfReview: true, nativeChecks: true });
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "gate" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).toBeNull();
  });

  test("same behavior in headless mode (no stdinWrite/awaitNextTurn)", async () => {
    // In headless mode, stdinWrite and awaitNextTurn are not provided.
    // Self-review should be skipped gracefully (no crash).
    const config = makeConfig({ selfReview: true, nativeChecks: false });
    const hook = createPostTurnVerificationHook(config); // no stdinWrite, no awaitNextTurn

    const step = makeStep({ type: "work" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: { summary: "done" },
    });

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    // Self-review NOT completed because no stdin injection available
    expect(result!.selfReviewCompleted).toBe(false);
  });

  test("same behavior in interactive mode (stdinWrite/awaitNextTurn provided)", async () => {
    const stdinWrite = mock((_msg: string) => {});
    const awaitNextTurn = mock(async (): Promise<WorkerOutput> => makeWorkerOutput());

    const config = makeConfig({ selfReview: true, nativeChecks: false });
    const hook = createPostTurnVerificationHook(config, stdinWrite, awaitNextTurn);

    const step = makeStep({ type: "work" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: { summary: "done" },
    });

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    expect(result!.selfReviewCompleted).toBe(true);
    expect(stdinWrite).toHaveBeenCalledTimes(1);
  });

  test("SELF_REVIEW_CHECKLIST is a non-empty string with expected items", () => {
    expect(typeof SELF_REVIEW_CHECKLIST).toBe("string");
    expect(SELF_REVIEW_CHECKLIST.length).toBeGreaterThan(0);
    // Verify it contains the 6 checklist items
    expect(SELF_REVIEW_CHECKLIST).toContain("Diff review");
    expect(SELF_REVIEW_CHECKLIST).toContain("Task alignment");
    expect(SELF_REVIEW_CHECKLIST).toContain("Completeness");
    expect(SELF_REVIEW_CHECKLIST).toContain("Test coverage");
    expect(SELF_REVIEW_CHECKLIST).toContain("Regression check");
    expect(SELF_REVIEW_CHECKLIST).toContain("Edge cases");
  });

  test("self-review disabled in config: no stdin injection even for work steps", async () => {
    const stdinWrite = mock((_msg: string) => {});
    const awaitNextTurn = mock(async (): Promise<WorkerOutput> => makeWorkerOutput());

    const config = makeConfig({ selfReview: false, nativeChecks: false });
    const hook = createPostTurnVerificationHook(config, stdinWrite, awaitNextTurn);

    const step = makeStep({ type: "work" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: { summary: "done" },
    });

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    expect(result!.selfReviewCompleted).toBe(false);
    expect(stdinWrite).not.toHaveBeenCalled();
  });
});
