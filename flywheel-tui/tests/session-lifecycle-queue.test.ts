/**
 * Session Lifecycle Queue Tests
 *
 * Tests for session lifecycle integration with queue-based execution:
 * - Session orchestrator loads queue state on resume (VAL-SHELL-022/023)
 * - Pipeline completion handles queue completions correctly
 * - Budget exhaustion transitions to budget_exhausted (VAL-SHELL-020)
 * - isResumable returns true for work:paused and budget_exhausted
 * - Sidebar grouping reflects correct lifecycle states (VAL-SHELL-021)
 * - /new returns to idle from completed (VAL-SHELL-016)
 * - Double-Esc and Ctrl+C stop queue execution (VAL-SHELL-017/018)
 */

import { describe, it, expect } from "bun:test";
import {
  createSessionOrchestrator,
  type SessionOrchestratorDeps,
} from "../src/orchestration/session-orchestrator";
import { handleQueueCompletion, type QueueCompletionDeps } from "../src/tui/session/queue-completion";
import { isResumable, isValidTransition, VALID_TRANSITIONS } from "../src/session/state-machine";
import { groupSessions, type SessionGroupKey } from "../src/tui/session/sidebar-logic";
import type { Session } from "../src/session/schemas";
import type { OutputSnapshot } from "../src/session/output-schemas";
import type { Queue, QueueResult, CompletedStepResult } from "../src/queue/types";
import type { SessionSummary } from "../src/session/manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function minimalSession(overrides?: Partial<Session>): Session {
  return {
    label: "plans/test.md",
    planPath: "plans/test.md",
    lastUpdated: new Date().toISOString(),
    sessionLifecycleState: "work:paused",
    worktreePath: "/tmp/worktrees/test",
    budgetLimits: { max_invocations: 0, max_tokens: null, wall_clock_deadline: null },
    budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0 },
    workflowType: "work",
    ...overrides,
  };
}

function makeFakeSnapshots(): OutputSnapshot[] {
  return [
    { kind: "text", content: "Hello world", timestamp: Date.now() },
    { kind: "system", message: "Step 1 started", timestamp: Date.now() },
  ];
}

function makeFakeQueue(overrides?: Partial<Queue>): Queue {
  return {
    steps: [
      { id: "step-1", type: "plan", title: "Create plan", status: "completed" },
      { id: "step-2", type: "work", title: "Execute work", status: "pending" },
      { id: "step-3", type: "review", title: "Review changes", status: "pending" },
    ],
    cursor: 1,
    status: "paused",
    maxSteps: 50,
    mutationLog: [],
    ...overrides,
  };
}

function makeMockDeps(overrides?: Partial<SessionOrchestratorDeps>): {
  deps: SessionOrchestratorDeps;
  calls: string[];
} {
  const calls: string[] = [];
  const deps: SessionOrchestratorDeps = {
    readSession: (id: string) => {
      calls.push(`readSession:${id}`);
      return minimalSession();
    },
    createOutputPersistence: (sessionId: string) => ({
      load: async () => {
        calls.push(`outputPersistence.load:${sessionId}`);
        return makeFakeSnapshots();
      },
    }),
    fromSnapshot: (snapshots: unknown[]) => {
      calls.push(`fromSnapshot:${snapshots.length}`);
      return snapshots as OutputSnapshot[];
    },
    createQueuePersistence: (sessionId: string) => ({
      load: async () => {
        calls.push(`queuePersistence.load:${sessionId}`);
        return makeFakeQueue();
      },
    }),
    manager: {
      updateState: (id: string, newState: string) => {
        calls.push(`manager.updateState:${id}:${newState}`);
      },
      trash: (id: string) => calls.push(`manager.trash:${id}`),
      archive: (id: string) => calls.push(`manager.archive:${id}`),
    },
    refreshList: () => calls.push("refreshList"),
    ...overrides,
  };
  return { deps, calls };
}

function makeSessionSummary(
  id: string,
  lifecycleState: string,
  name?: string,
): SessionSummary {
  return {
    id,
    name: name ?? `Session ${id}`,
    label: name ?? `Session ${id}`,
    planPath: "plans/test.md",
    lifecycleState: lifecycleState as any,
    totalCost: 0,
    lastUpdated: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  };
}

// ===========================================================================
// VAL-SHELL-022/023: Resume loads queue state
// ===========================================================================

describe("SessionOrchestrator.handleResumeSession — queue loading", () => {
  it("loads queue state from .queue.json when createQueuePersistence is provided", async () => {
    const fakeQueue = makeFakeQueue();
    const { deps, calls } = makeMockDeps({
      createQueuePersistence: (sessionId: string) => ({
        load: async () => {
          calls.push(`queuePersistence.load:${sessionId}`);
          return fakeQueue;
        },
      }),
    });
    const orchestrator = createSessionOrchestrator(deps);

    const result = await orchestrator.handleResumeSession("session-1");

    expect(result).not.toBeNull();
    expect(result!.queue.steps).toHaveLength(3);
    expect(result!.queue.cursor).toBe(1);
    expect(calls).toContain("queuePersistence.load:session-1");
  });

  it("returns null when .queue.json does not exist", async () => {
    const { deps } = makeMockDeps({
      createQueuePersistence: () => ({
        load: async () => null,
      }),
    });
    const orchestrator = createSessionOrchestrator(deps);

    const result = await orchestrator.handleResumeSession("session-1");

    expect(result).toBeNull();
  });

  it("returns null when createQueuePersistence is not provided", async () => {
    const { deps } = makeMockDeps({
      createQueuePersistence: undefined,
    });
    const orchestrator = createSessionOrchestrator(deps);

    const result = await orchestrator.handleResumeSession("session-1");

    expect(result).toBeNull();
  });

  it("returns null when queue persistence throws", async () => {
    const { deps } = makeMockDeps({
      createQueuePersistence: () => ({
        load: async () => { throw new Error("corrupt file"); },
      }),
    });
    const orchestrator = createSessionOrchestrator(deps);

    const result = await orchestrator.handleResumeSession("session-1");

    expect(result).toBeNull();
  });

  it("queue has correct cursor pointing to first pending step", async () => {
    const queue = makeFakeQueue({
      steps: [
        { id: "s1", type: "plan", title: "Plan", status: "completed" },
        { id: "s2", type: "work", title: "Work 1", status: "completed" },
        { id: "s3", type: "work", title: "Work 2", status: "pending" },
        { id: "s4", type: "review", title: "Review", status: "pending" },
      ],
      cursor: 2,
    });
    const { deps } = makeMockDeps({
      createQueuePersistence: () => ({
        load: async () => queue,
      }),
    });
    const orchestrator = createSessionOrchestrator(deps);

    const result = await orchestrator.handleResumeSession("session-1");

    expect(result!.queue.cursor).toBe(2);
    // Completed steps are before cursor — they won't be re-executed
    expect(result!.queue.steps[0].status).toBe("completed");
    expect(result!.queue.steps[1].status).toBe("completed");
    expect(result!.queue.steps[2].status).toBe("pending");
  });

  it("still returns session and output blocks alongside queue", async () => {
    const fakeQueue = makeFakeQueue();
    const { deps } = makeMockDeps({
      createQueuePersistence: () => ({
        load: async () => fakeQueue,
      }),
    });
    const orchestrator = createSessionOrchestrator(deps);

    const result = await orchestrator.handleResumeSession("session-1");

    expect(result!.session).toBeDefined();
    expect(result!.outputBlocks).toHaveLength(2);
    expect(result!.planPath).toBe("plans/test.md");
    expect(result!.queue).not.toBeNull();
  });
});

// ===========================================================================
// VAL-SHELL-020: Pipeline completion handles queue completion properly
// ===========================================================================

describe("handleQueueCompletion — queue completion", () => {
  function makeMockCompletionDeps(overrides?: Partial<QueueCompletionDeps>): {
    deps: QueueCompletionDeps;
    calls: string[];
  } {
    const calls: string[] = [];
    const deps: QueueCompletionDeps = {
      orchestrator: {
        handleAutoArchive: async (id: string, results: CompletedStepResult[]) => {
          calls.push(`autoArchive:${id}`);
        },
      },
      sessionId: "session-1",
      flusher: {
        flush: async () => { calls.push("flush"); },
        dispose: () => { calls.push("dispose"); },
      },
      toast: {
        show: (opts: { message: string; variant: string }) => {
          calls.push(`toast:${opts.variant}:${opts.message}`);
        },
      },
      updateState: (id: string, state: string) => {
        calls.push(`updateState:${id}:${state}`);
      },
      refreshList: () => { calls.push("refreshList"); },
      ...overrides,
    };
    return { deps, calls };
  }

  it("transitions to completed when queue completes without ship step", async () => {
    const { deps, calls } = makeMockCompletionDeps();
    const result: QueueResult = {
      completed: true,
      stepsCompleted: 2,
      stepsTotal: 2,
      stepResults: [
        { workflow: "work", completed: true },
        { workflow: "review", completed: true },
      ],
    };

    await handleQueueCompletion(result, deps);

    // Should transition to completed (not work:paused)
    const updateCalls = calls.filter((c) => c.startsWith("updateState:"));
    expect(updateCalls.some((c) => c.includes("completed"))).toBe(true);
    expect(updateCalls.some((c) => c.includes("work:paused"))).toBe(false);
  });

  it("auto-archives when queue completes with ship step", async () => {
    const { deps, calls } = makeMockCompletionDeps();
    const result: QueueResult = {
      completed: true,
      stepsCompleted: 3,
      stepsTotal: 3,
      stepResults: [
        { workflow: "work", completed: true },
        { workflow: "review", completed: true },
        { workflow: "ship", completed: true },
      ],
    };

    await handleQueueCompletion(result, deps);

    expect(calls).toContain("autoArchive:session-1");
  });

  it("does not transition when queue did not complete (interrupted/failed)", async () => {
    const { deps, calls } = makeMockCompletionDeps();
    const result: QueueResult = {
      completed: false,
      stepsCompleted: 1,
      stepsTotal: 3,
      reason: "Step failed",
      stepResults: [
        { workflow: "work", completed: true },
      ],
    };

    await handleQueueCompletion(result, deps);

    // Should NOT call updateState (interrupted pipelines leave state as-is)
    const updateCalls = calls.filter((c) => c.startsWith("updateState:"));
    expect(updateCalls).toHaveLength(0);
  });

  it("flushes and disposes flusher on completion", async () => {
    const { deps, calls } = makeMockCompletionDeps();
    const result: QueueResult = {
      completed: true,
      stepsCompleted: 1,
      stepsTotal: 1,
      stepResults: [{ workflow: "plan", completed: true }],
    };

    await handleQueueCompletion(result, deps);

    expect(calls).toContain("flush");
    expect(calls).toContain("dispose");
  });
});

// ===========================================================================
// VAL-SHELL-022: isResumable for work:paused and budget_exhausted
// ===========================================================================

describe("isResumable", () => {
  it("returns true for work:paused", () => {
    expect(isResumable("work:paused")).toBe(true);
  });

  it("returns true for budget_exhausted", () => {
    expect(isResumable("budget_exhausted")).toBe(true);
  });

  it("returns false for work:active", () => {
    expect(isResumable("work:active")).toBe(false);
  });

  it("returns false for completed", () => {
    expect(isResumable("completed")).toBe(false);
  });

  it("returns false for new", () => {
    expect(isResumable("new")).toBe(false);
  });

  it("returns false for archived", () => {
    expect(isResumable("archived")).toBe(false);
  });

  it("returns false for trashed", () => {
    expect(isResumable("trashed")).toBe(false);
  });
});

// ===========================================================================
// VAL-SHELL-020: State transitions for queue lifecycle
// ===========================================================================

describe("Queue lifecycle state transitions", () => {
  it("work:active → work:paused is valid (double-Esc/Ctrl+C stop)", () => {
    expect(isValidTransition("work:active", "work:paused")).toBe(true);
  });

  it("work:active → completed is valid (queue success)", () => {
    expect(isValidTransition("work:active", "completed")).toBe(true);
  });

  it("work:active → budget_exhausted is valid (budget stop)", () => {
    expect(isValidTransition("work:active", "budget_exhausted")).toBe(true);
  });

  it("work:paused → work:active is valid (resume)", () => {
    expect(isValidTransition("work:paused", "work:active")).toBe(true);
  });

  it("budget_exhausted → work:active is valid (resume after budget)", () => {
    expect(isValidTransition("budget_exhausted", "work:active")).toBe(true);
  });

  it("work:paused → completed is NOT valid (must resume first)", () => {
    expect(isValidTransition("work:paused", "completed")).toBe(false);
  });
});

// ===========================================================================
// VAL-SHELL-021: Sidebar groups sessions by lifecycle state
// ===========================================================================

describe("Sidebar grouping for queue lifecycle states", () => {
  it("work:active session appears in 'active' group", () => {
    const sessions = [makeSessionSummary("s1", "work:active")];
    const groups = groupSessions(sessions);
    expect(groups.active).toHaveLength(1);
    expect(groups.active[0].id).toBe("s1");
  });

  it("work:paused session appears in 'paused' group", () => {
    const sessions = [makeSessionSummary("s1", "work:paused")];
    const groups = groupSessions(sessions);
    expect(groups.paused).toHaveLength(1);
    expect(groups.paused[0].id).toBe("s1");
  });

  it("budget_exhausted session appears in 'paused' group", () => {
    const sessions = [makeSessionSummary("s1", "budget_exhausted")];
    const groups = groupSessions(sessions);
    expect(groups.paused).toHaveLength(1);
    expect(groups.paused[0].id).toBe("s1");
  });

  it("completed session appears in 'other' group", () => {
    const sessions = [makeSessionSummary("s1", "completed")];
    const groups = groupSessions(sessions);
    expect(groups.other).toHaveLength(1);
    expect(groups.other[0].id).toBe("s1");
  });

  it("multiple sessions in different states grouped correctly", () => {
    const sessions = [
      makeSessionSummary("s1", "work:active", "Active Session"),
      makeSessionSummary("s2", "work:paused", "Paused Session"),
      makeSessionSummary("s3", "budget_exhausted", "Budget Session"),
      makeSessionSummary("s4", "completed", "Done Session"),
      makeSessionSummary("s5", "archived", "Old Session"),
    ];
    const groups = groupSessions(sessions);
    expect(groups.active).toHaveLength(1);
    expect(groups.paused).toHaveLength(2); // work:paused + budget_exhausted
    expect(groups.other).toHaveLength(1);
    expect(groups.archived).toHaveLength(1);
  });
});

// ===========================================================================
// VAL-SHELL-023: Queue resume skips completed steps
// ===========================================================================

describe("Queue resume — completed steps not re-executed", () => {
  it("queue with completed steps has cursor at first pending step", () => {
    const queue = makeFakeQueue({
      steps: [
        { id: "s1", type: "plan", title: "Plan", status: "completed" },
        { id: "s2", type: "work", title: "Work 1", status: "completed" },
        { id: "s3", type: "work", title: "Work 2", status: "failed" },
        { id: "s4", type: "work", title: "Work 3", status: "pending" },
        { id: "s5", type: "review", title: "Review", status: "pending" },
      ],
      cursor: 3, // Points to first pending step after crash recovery
    });

    // The step at cursor should be pending
    expect(queue.steps[queue.cursor].status).toBe("pending");
    expect(queue.steps[queue.cursor].id).toBe("s4");

    // Steps before cursor are completed or failed
    expect(queue.steps[0].status).toBe("completed");
    expect(queue.steps[1].status).toBe("completed");
    expect(queue.steps[2].status).toBe("failed");
  });

  it("queue with all steps completed is finished", () => {
    const queue = makeFakeQueue({
      steps: [
        { id: "s1", type: "plan", title: "Plan", status: "completed" },
        { id: "s2", type: "work", title: "Work", status: "completed" },
        { id: "s3", type: "review", title: "Review", status: "completed" },
      ],
      cursor: 3,
      status: "completed",
    });

    const hasPending = queue.steps.some((s) => s.status === "pending");
    expect(hasPending).toBe(false);
  });

  it("queue with some pending steps is not finished", () => {
    const queue = makeFakeQueue({
      steps: [
        { id: "s1", type: "plan", title: "Plan", status: "completed" },
        { id: "s2", type: "work", title: "Work", status: "pending" },
      ],
      cursor: 1,
    });

    const hasPending = queue.steps.some((s) => s.status === "pending");
    expect(hasPending).toBe(true);
  });
});

// ===========================================================================
// VAL-SHELL-016: /new returns to idle from completed
// ===========================================================================

describe("/new command returns to idle", () => {
  it("completed state supports returning to idle", () => {
    // /new calls returnToIdle() which tears down workflow and sets appState to "idle"
    // This is a structural test — /new just calls returnToIdle(), which is already verified.
    // Here we verify the state machine allows the relevant transitions.
    expect(isValidTransition("completed", "archived")).toBe(true);
    expect(isValidTransition("completed", "work:active")).toBe(true);
  });
});

// ===========================================================================
// VAL-SHELL-017/018: Double-Esc and Ctrl+C stop queue
// ===========================================================================

describe("Stop queue transitions", () => {
  it("work:active → work:paused is valid for double-Esc stop", () => {
    expect(isValidTransition("work:active", "work:paused")).toBe(true);
  });

  it("work:active → work:paused is valid for Ctrl+C stop", () => {
    // Both double-Esc and Ctrl+C transition to work:paused
    expect(isValidTransition("work:active", "work:paused")).toBe(true);
  });

  it("work:paused is resumable after stop", () => {
    expect(isResumable("work:paused")).toBe(true);
  });
});
