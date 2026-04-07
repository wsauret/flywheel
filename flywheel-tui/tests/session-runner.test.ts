/**
 * Tests for SessionRunner interface compliance.
 *
 * Verifies that WorkflowRunner's shape satisfies the SessionRunner interface
 * at the type level (compile-time check via assignability).
 */

import { describe, it, expect } from "bun:test";
import type { SessionRunner } from "../src/orchestration/session-runner";
import type { WorkflowRunner } from "../src/orchestration/workflow-runner";

describe("SessionRunner interface", () => {
  it("WorkflowRunner shape satisfies SessionRunner", () => {
    // Type-level check: a WorkflowRunner must be assignable to SessionRunner.
    // If this compiles, the interface contract is satisfied.
    const assertAssignable = (_runner: SessionRunner) => {};

    // We can't easily construct a real WorkflowRunner in a unit test,
    // so we verify assignability with a typed mock that matches WorkflowRunner.
    const mockWorkflowRunner: WorkflowRunner = {
      sessionId: "test-session",
      run: async () => ({ completed: true, stepsCompleted: 1, stepsTotal: 1, cost: 0, tokens: 0 }),
      pause: () => {},
      abort: () => {},
      injectMessage: (_text: string) => true,
      cancelShutdown: () => {},
      dispose: async () => {},
    };

    // This line would fail to compile if WorkflowRunner doesn't extend SessionRunner
    assertAssignable(mockWorkflowRunner);

    // Runtime sanity: the common subset is present
    expect(typeof mockWorkflowRunner.sessionId).toBe("string");
    expect(typeof mockWorkflowRunner.abort).toBe("function");
    expect(typeof mockWorkflowRunner.dispose).toBe("function");
    expect(typeof mockWorkflowRunner.injectMessage).toBe("function");
  });

  it("SessionRunner requires exactly sessionId, abort, dispose, injectMessage", () => {
    // Minimal object that satisfies SessionRunner — verifies we haven't
    // accidentally added extra required members.
    const minimal: SessionRunner = {
      sessionId: "minimal",
      abort: () => {},
      dispose: async () => {},
      injectMessage: () => true,
    };

    expect(minimal.sessionId).toBe("minimal");
  });
});
