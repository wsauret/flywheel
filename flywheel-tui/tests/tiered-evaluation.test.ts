// ---------------------------------------------------------------------------
// Tiered Evaluation — Unit Tests
// ---------------------------------------------------------------------------
//
// Tests for the tiered evaluation model: which step types get native checks.
// Post-turn verification runs native checks and injects fix feedback on
// failure. Self-review is handled separately by subprocess-callback.
// ---------------------------------------------------------------------------

import { describe, expect, test, mock } from "bun:test";
import { randomUUID } from "crypto";

import type { Step } from "../src/workflows/queue/types";
import type { WorkerOutput } from "../src/workflows/queue/executor-types.js";
import {
  createPostTurnVerificationHook,
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
    nativeCheckTypes: ["build", "test", "lint"],
    maxFixAttempts: 2,
    projectCwd: "/tmp/test-project",
    ...overrides,
  };
}

// ===========================================================================
// Tiered Evaluation: step type determines verification behavior
// ===========================================================================

describe("Tiered Evaluation", () => {
  test("work step returns a result (not null)", async () => {
    const config = makeConfig();
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "work" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: { summary: "done" },
    });

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
  });

  test("plan step: hook returns null (no verification)", async () => {
    const config = makeConfig();
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "plan" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).toBeNull();
  });

  test("debug step returns a result (code step)", async () => {
    const config = makeConfig();
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "debug" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: { summary: "fixed bug" },
    });

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
  });

  test("verify step: hook returns null (no verification)", async () => {
    const config = makeConfig();
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "verify" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).toBeNull();
  });

  test("ship step returns a result", async () => {
    const config = makeConfig();
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "ship" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
  });

  test("review step: hook returns null (no verification)", async () => {
    const config = makeConfig();
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "review" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).toBeNull();
  });

  test("research step: hook returns null (no verification)", async () => {
    const config = makeConfig();
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "research" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).toBeNull();
  });

  test("gate step: hook returns null (no verification)", async () => {
    const config = makeConfig();
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "gate" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: null,
    });

    expect(result).toBeNull();
  });

  test("no stdinWrite/awaitNextTurn: still returns result without crashing", async () => {
    const config = makeConfig();
    const hook = createPostTurnVerificationHook(config);

    const step = makeStep({ type: "work" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: { summary: "done" },
    });

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
  });

  test("no stdinWrite injection occurs from post-turn verification", async () => {
    const stdinWrite = mock((_msg: string) => {});
    const awaitNextTurn = mock(async (): Promise<WorkerOutput> => makeWorkerOutput());

    const config = makeConfig();
    const hook = createPostTurnVerificationHook(config, stdinWrite, awaitNextTurn);

    const step = makeStep({ type: "work" });
    const result = await hook({
      step,
      workerOutput: makeWorkerOutput(),
      handoffData: { summary: "done" },
    });

    expect(result).not.toBeNull();
    expect(result!.passed).toBe(true);
    // No native checks configured to fail, so no stdin injection
    expect(stdinWrite).not.toHaveBeenCalled();
  });
});
