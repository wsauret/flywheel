/**
 * Auto-Archive Tests (Step 7)
 *
 * Tests the pipeline completion handler: handleQueueCompletion().
 *
 * This is the extracted pure-function that encapsulates the logic from the
 * shell's queueMicrotask pipeline completion block:
 * - Calls orchestrator.handleAutoArchive() when ship stage completed
 * - Does NOT call auto-archive for non-ship completions
 * - Shows "Session shipped and archived" toast on auto-archive
 * - Disposes the output flusher in all completion paths
 * - Transitions non-ship completions to "completed" (queue-based)
 */

import { describe, it, expect } from "bun:test";
import {
  handleQueueCompletion,
  type QueueCompletionDeps,
} from "../src/tui/session/queue-completion";
import type { QueueResult, CompletedStepResult } from "../src/workflows/queue/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueueResult(overrides?: Partial<QueueResult>): QueueResult {
  return {
    completed: true,
    stepsCompleted: 3,
    stepsTotal: 3,
    stepResults: [],
    ...overrides,
  };
}

function makeMockDeps(overrides?: Partial<QueueCompletionDeps>): {
  deps: QueueCompletionDeps;
  calls: string[];
} {
  const calls: string[] = [];

  const deps: QueueCompletionDeps = {
    orchestrator: {
      handleAutoArchive: async (id: string, results: CompletedStepResult[]) => {
        calls.push(`handleAutoArchive:${id}`);
      },
    },
    sessionId: "session-1",
    flusher: {
      flush: async () => {
        calls.push("flusher.flush");
      },
      dispose: () => {
        calls.push("flusher.dispose");
      },
    },
    toast: {
      show: (opts: { message: string; variant: string }) => {
        calls.push(`toast:${opts.variant}:${opts.message}`);
      },
    },
    updateState: (id: string, state: string) => {
      calls.push(`updateState:${id}:${state}`);
    },
    refreshList: () => {
      calls.push("refreshList");
    },
    ...overrides,
  };

  return { deps, calls };
}

// ---------------------------------------------------------------------------
// Auto-archive triggering
// ---------------------------------------------------------------------------

describe("handleQueueCompletion — auto-archive", () => {
  it("calls orchestrator.handleAutoArchive when pipeline completes with ship stage", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
        { workflow: "review", completed: true },
        { workflow: "ship", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    expect(calls).toContain("handleAutoArchive:session-1");
  });

  it("shows 'Session shipped and archived' toast on auto-archive", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
        { workflow: "ship", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    expect(calls).toContain("toast:info:Session shipped and archived");
  });

  it("passes stepResults to orchestrator.handleAutoArchive", async () => {
    let receivedResults: CompletedStepResult[] = [];
    const { deps } = makeMockDeps({
      orchestrator: {
        handleAutoArchive: async (_id, results) => {
          receivedResults = results;
        },
      },
    });
    const stepResults: CompletedStepResult[] = [
      { workflow: "work", completed: true },
      { workflow: "ship", completed: true },
    ];
    const result = makeQueueResult({ completed: true, stepResults });

    await handleQueueCompletion(result, deps);

    expect(receivedResults).toHaveLength(2);
    expect(receivedResults[1].workflow).toBe("ship");
  });
});

// ---------------------------------------------------------------------------
// Non-ship completions
// ---------------------------------------------------------------------------

describe("handleQueueCompletion — non-ship completions", () => {
  it("transitions plan+work+review pipeline to completed (queue-based)", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: true,
      stepsCompleted: 3,
      stepsTotal: 3,
      stepResults: [
        { workflow: "plan", completed: true },
        { workflow: "work", completed: true },
        { workflow: "review", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    // Queue completed all steps (no ship) → session is completed
    expect(calls).toContain("updateState:session-1:completed");
    expect(calls).not.toContain("updateState:session-1:work:paused");
    expect(calls).not.toContain("handleAutoArchive:session-1");
  });

  it("does NOT call handleAutoArchive when no ship stage is present", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
        { workflow: "review", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    expect(calls).not.toContain("handleAutoArchive:session-1");
  });

  it("transitions to 'completed' for non-ship completions (queue-based)", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    expect(calls).toContain("updateState:session-1:completed");
    expect(calls).toContain("refreshList");
  });

  it("does NOT call handleAutoArchive when ship stage is present but NOT completed", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: false,
      stepResults: [
        { workflow: "work", completed: true },
        { workflow: "ship", completed: false, reason: "cancelled" },
      ],
    });

    await handleQueueCompletion(result, deps);

    expect(calls).not.toContain("handleAutoArchive:session-1");
  });

  it("does NOT show ship toast for non-ship completions", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
        { workflow: "review", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    const toastCalls = calls.filter((c) => c.startsWith("toast:"));
    expect(toastCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Flusher lifecycle
// ---------------------------------------------------------------------------

describe("handleQueueCompletion — flusher lifecycle", () => {
  it("flushes and disposes flusher on successful ship completion", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "ship", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    expect(calls).toContain("flusher.flush");
    expect(calls).toContain("flusher.dispose");
  });

  it("flushes and disposes flusher on non-ship completion", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    expect(calls).toContain("flusher.flush");
    expect(calls).toContain("flusher.dispose");
  });

  it("disposes flusher even when pipeline did not complete (failed/interrupted)", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: false,
      stepResults: [],
      reason: "Pipeline failed",
    });

    await handleQueueCompletion(result, deps);

    expect(calls).toContain("flusher.flush");
    expect(calls).toContain("flusher.dispose");
  });

  it("handles null flusher gracefully", async () => {
    const { deps, calls } = makeMockDeps({ flusher: null });
    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "ship", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    // Should not crash, and should still do the auto-archive
    expect(calls).toContain("handleAutoArchive:session-1");
  });

  it("flush errors are swallowed (does not block completion)", async () => {
    const { deps, calls } = makeMockDeps({
      flusher: {
        flush: async () => {
          throw new Error("disk full");
        },
        dispose: () => {
          calls.push("flusher.dispose");
        },
      },
    });
    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
      ],
    });

    // Should not throw
    await handleQueueCompletion(result, deps);

    // Dispose should still be called even after flush error
    expect(calls).toContain("flusher.dispose");
  });

  it("flushes before calling orchestrator (ordering)", async () => {
    const order: string[] = [];
    const deps: QueueCompletionDeps = {
      orchestrator: {
        handleAutoArchive: async () => {
          order.push("archive");
        },
      },
      sessionId: "session-1",
      flusher: {
        flush: async () => {
          order.push("flush");
        },
        dispose: () => {
          order.push("dispose");
        },
      },
      toast: { show: () => {} },
      updateState: () => {},
      refreshList: () => {},
    };

    const result = makeQueueResult({
      completed: true,
      stepResults: [{ workflow: "ship", completed: true }],
    });

    await handleQueueCompletion(result, deps);

    const flushIdx = order.indexOf("flush");
    const archiveIdx = order.indexOf("archive");
    expect(flushIdx).toBeLessThan(archiveIdx);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("handleQueueCompletion — edge cases", () => {
  it("does nothing when sessionId is null", async () => {
    const { deps, calls } = makeMockDeps({ sessionId: null });
    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "ship", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    // Flusher should still be disposed
    expect(calls).toContain("flusher.flush");
    expect(calls).toContain("flusher.dispose");

    // But no archive or state update
    expect(calls).not.toContain("handleAutoArchive:null");
    const archiveCalls = calls.filter((c) => c.startsWith("handleAutoArchive"));
    expect(archiveCalls).toHaveLength(0);
  });

  it("does not change state when pipeline was interrupted (not completed)", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: false,
      stepResults: [
        { workflow: "work", completed: true },
        { workflow: "review", completed: false, reason: "User stopped" },
      ],
    });

    await handleQueueCompletion(result, deps);

    // Should NOT call updateState or handleAutoArchive
    const stateCalls = calls.filter((c) => c.startsWith("updateState"));
    const archiveCalls = calls.filter((c) => c.startsWith("handleAutoArchive"));
    expect(stateCalls).toHaveLength(0);
    expect(archiveCalls).toHaveLength(0);
  });

  it("handles empty stepResults with completed=true (edge case)", async () => {
    const { deps, calls } = makeMockDeps();
    const result = makeQueueResult({
      completed: true,
      stepResults: [],
    });

    await handleQueueCompletion(result, deps);

    // No ship stage → non-ship completion path → completed (queue-based)
    expect(calls).toContain("updateState:session-1:completed");
    expect(calls).not.toContain("handleAutoArchive:session-1");
  });
});
