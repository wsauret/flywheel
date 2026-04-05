import { describe, it, expect, beforeEach } from "bun:test";
import { randomUUID } from "crypto";
import {
  createSessionOrchestrator,
  type SessionOrchestratorDeps,
  type ResumeResult,
} from "../src/orchestration/session-orchestrator";
import { createQueue } from "../src/workflows/queue/queue";
import type { Session } from "../src/orchestration/session/schemas";
import type { OutputSnapshot } from "../src/orchestration/session/output-schemas";
import type { CompletedStepResult } from "../src/workflows/queue/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid Session data for testing. */
function minimalSession(overrides?: Partial<Session>): Session {
  return {
    label: "plans/test.md",
    planPath: "plans/test.md",
    lastUpdated: new Date().toISOString(),
    sessionLifecycleState: "work:active",
    worktreePath: "/tmp/worktrees/test",
    budgetLimits: { max_invocations: 0, max_tokens: null, wall_clock_deadline: null },
    budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0 },
    workflowType: "work",
    ...overrides,
  };
}

/** Minimal output snapshots for testing. */
function makeFakeSnapshots(): OutputSnapshot[] {
  return [
    { kind: "text", content: "Hello world", timestamp: Date.now() },
    { kind: "system", message: "Step 1 started", timestamp: Date.now() },
  ];
}

/** Create a mock deps object with call tracking. */
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
    createOutputPersistence: (sessionId: string) => {
      calls.push(`createOutputPersistence:${sessionId}`);
      return {
        load: async () => {
          calls.push(`outputPersistence.load:${sessionId}`);
          return makeFakeSnapshots();
        },
      };
    },
    fromSnapshot: (snapshots: unknown[]) => {
      calls.push(`fromSnapshot:${snapshots.length}`);
      return snapshots as OutputSnapshot[];
    },
    manager: {
      updateState: (id: string, newState: string) => {
        calls.push(`manager.updateState:${id}:${newState}`);
      },
      trash: (id: string) => {
        calls.push(`manager.trash:${id}`);
      },
      archive: (id: string) => {
        calls.push(`manager.archive:${id}`);
      },
    },
    worktreeManager: {
      removeForSession: async (id: string) => {
        calls.push(`worktreeManager.removeForSession:${id}`);
      },
      cleanupTrashed: async (id: string) => {
        calls.push(`worktreeManager.cleanupTrashed:${id}`);
        return true;
      },
    },
    createQueuePersistence: (sessionId: string) => ({
      load: async () => createQueue([{
        id: randomUUID(),
        type: "work" as const,
        title: "Test step",
        status: "pending" as const,
      }]),
    }),
    refreshList: () => {
      calls.push("refreshList");
    },
    ...overrides,
  };

  return { deps, calls };
}

// ---------------------------------------------------------------------------
// handleResumeSession
// ---------------------------------------------------------------------------

describe("SessionOrchestrator.handleResumeSession", () => {
  it("loads session from disk and returns session data with planPath and worktreePath", async () => {
    const session = minimalSession({
      planPath: "plans/my-plan.md",
      worktreePath: "/tmp/wt/session-1",
    });
    const { deps } = makeMockDeps({
      readSession: () => session,
    });
    const orchestrator = createSessionOrchestrator(deps);

    const result = await orchestrator.handleResumeSession("session-1");

    expect(result).not.toBeNull();
    expect(result!.session.planPath).toBe("plans/my-plan.md");
    expect(result!.session.worktreePath).toBe("/tmp/wt/session-1");
    expect(result!.planPath).toBe("plans/my-plan.md");
    expect(result!.worktreePath).toBe("/tmp/wt/session-1");
  });

  it("loads OutputSnapshot from persistence and converts via fromSnapshot()", async () => {
    const rawSnapshots = makeFakeSnapshots();
    const { deps, calls } = makeMockDeps({
      createOutputPersistence: (sessionId: string) => ({
        load: async () => rawSnapshots,
      }),
      fromSnapshot: (snapshots: unknown[]) => {
        calls.push(`fromSnapshot:${snapshots.length}`);
        return snapshots as OutputSnapshot[];
      },
    });
    const orchestrator = createSessionOrchestrator(deps);

    const result = await orchestrator.handleResumeSession("session-1");

    expect(result).not.toBeNull();
    expect(result!.outputBlocks).toHaveLength(2);
    expect(calls).toContain("fromSnapshot:2");
  });

  it("returns empty output array when .output.json is missing (no crash)", async () => {
    const { deps } = makeMockDeps({
      createOutputPersistence: () => ({
        load: async () => [],
      }),
      fromSnapshot: (snapshots: unknown[]) => [],
    });
    const orchestrator = createSessionOrchestrator(deps);

    const result = await orchestrator.handleResumeSession("session-1");

    expect(result).not.toBeNull();
    expect(result!.outputBlocks).toHaveLength(0);
  });

  it("returns session with default fields when session has minimal data", async () => {
    const session = minimalSession();
    const { deps } = makeMockDeps({
      readSession: () => session,
    });
    const orchestrator = createSessionOrchestrator(deps);

    const result = await orchestrator.handleResumeSession("session-1");

    expect(result).not.toBeNull();
    expect(result!.session.label).toBe("plans/test.md");
  });

  it("returns null when session is not found on disk", async () => {
    const { deps } = makeMockDeps({
      readSession: () => null,
    });
    const orchestrator = createSessionOrchestrator(deps);

    const result = await orchestrator.handleResumeSession("non-existent");

    expect(result).toBeNull();
  });

  it("calls readSession with the correct session ID", async () => {
    const { deps, calls } = makeMockDeps();
    const orchestrator = createSessionOrchestrator(deps);

    await orchestrator.handleResumeSession("abc-123");

    expect(calls).toContain("readSession:abc-123");
  });

  it("calls createOutputPersistence with the correct session ID", async () => {
    const { deps, calls } = makeMockDeps();
    const orchestrator = createSessionOrchestrator(deps);

    await orchestrator.handleResumeSession("abc-123");

    expect(calls).toContain("createOutputPersistence:abc-123");
  });
});

// ---------------------------------------------------------------------------
// handleAutoArchive
// ---------------------------------------------------------------------------

describe("SessionOrchestrator.handleAutoArchive", () => {
  it("archives when ship stage is present and completed", async () => {
    const { deps, calls } = makeMockDeps();
    const orchestrator = createSessionOrchestrator(deps);

    const stepResults: CompletedStepResult[] = [
      { workflow: "work", completed: true },
      { workflow: "review", completed: true },
      { workflow: "ship", completed: true },
    ];

    await orchestrator.handleAutoArchive("session-1", stepResults);

    expect(calls).toContain("manager.updateState:session-1:completed");
    expect(calls).toContain("manager.archive:session-1");
    expect(calls).toContain("worktreeManager.removeForSession:session-1");
    expect(calls).toContain("refreshList");
  });

  it("does NOT archive when ship stage is not present", async () => {
    const { deps, calls } = makeMockDeps();
    const orchestrator = createSessionOrchestrator(deps);

    const stepResults: CompletedStepResult[] = [
      { workflow: "work", completed: true },
      { workflow: "review", completed: true },
    ];

    await orchestrator.handleAutoArchive("session-1", stepResults);

    expect(calls).toContain("manager.updateState:session-1:completed");
    expect(calls).not.toContain("manager.archive:session-1");
    expect(calls).not.toContain("worktreeManager.removeForSession:session-1");
    expect(calls).toContain("refreshList");
  });

  it("does NOT archive when ship stage is present but not completed", async () => {
    const { deps, calls } = makeMockDeps();
    const orchestrator = createSessionOrchestrator(deps);

    const stepResults: CompletedStepResult[] = [
      { workflow: "work", completed: true },
      { workflow: "ship", completed: false, reason: "cancelled" },
    ];

    await orchestrator.handleAutoArchive("session-1", stepResults);

    expect(calls).toContain("manager.updateState:session-1:completed");
    expect(calls).not.toContain("manager.archive:session-1");
    expect(calls).toContain("refreshList");
  });

  it("works without worktreeManager (optional)", async () => {
    const { deps, calls } = makeMockDeps();
    deps.worktreeManager = undefined;
    const orchestrator = createSessionOrchestrator(deps);

    const stepResults: CompletedStepResult[] = [
      { workflow: "ship", completed: true },
    ];

    await orchestrator.handleAutoArchive("session-1", stepResults);

    expect(calls).toContain("manager.updateState:session-1:completed");
    expect(calls).toContain("manager.archive:session-1");
    expect(calls).not.toContain("worktreeManager.removeForSession:session-1");
    expect(calls).toContain("refreshList");
  });

  it("always calls refreshList", async () => {
    const { deps, calls } = makeMockDeps();
    const orchestrator = createSessionOrchestrator(deps);

    await orchestrator.handleAutoArchive("session-1", []);

    expect(calls).toContain("refreshList");
  });
});

// ---------------------------------------------------------------------------
// handleDeleteSession
// ---------------------------------------------------------------------------

describe("SessionOrchestrator.handleDeleteSession", () => {
  it("trashes the session via manager", async () => {
    const { deps, calls } = makeMockDeps();
    const orchestrator = createSessionOrchestrator(deps);

    await orchestrator.handleDeleteSession("session-1");

    expect(calls).toContain("manager.trash:session-1");
  });

  it("cleans up worktree after trashing", async () => {
    const { deps, calls } = makeMockDeps();
    const orchestrator = createSessionOrchestrator(deps);

    await orchestrator.handleDeleteSession("session-1");

    expect(calls).toContain("worktreeManager.cleanupTrashed:session-1");
  });

  it("calls refreshList after deletion", async () => {
    const { deps, calls } = makeMockDeps();
    const orchestrator = createSessionOrchestrator(deps);

    await orchestrator.handleDeleteSession("session-1");

    expect(calls).toContain("refreshList");
  });

  it("trash comes before cleanup, deleteFiles, and refreshList", async () => {
    const order: string[] = [];
    const { deps } = makeMockDeps();

    deps.manager.trash = (id: string) => {
      order.push("trash");
    };
    deps.worktreeManager = {
      removeForSession: async () => {},
      cleanupTrashed: async (id: string) => {
        order.push("cleanup");
        return true;
      },
    };
    deps.deleteSessionFiles = (id: string) => {
      order.push("deleteFiles");
      return { deleted: [], errors: [] };
    };
    deps.refreshList = () => {
      order.push("refreshList");
    };

    const orchestrator = createSessionOrchestrator(deps);
    await orchestrator.handleDeleteSession("session-1");

    expect(order).toEqual(["trash", "cleanup", "deleteFiles", "refreshList"]);
  });

  it("works without worktreeManager (optional)", async () => {
    const { deps, calls } = makeMockDeps();
    deps.worktreeManager = undefined;
    const orchestrator = createSessionOrchestrator(deps);

    await orchestrator.handleDeleteSession("session-1");

    expect(calls).toContain("manager.trash:session-1");
    expect(calls).not.toContain("worktreeManager.cleanupTrashed:session-1");
    expect(calls).toContain("refreshList");
  });

  it("calls deleteSessionFiles when provided", async () => {
    const { deps, calls } = makeMockDeps();
    deps.deleteSessionFiles = (id: string) => {
      calls.push(`deleteSessionFiles:${id}`);
      return { deleted: ["a.json", "b.json"], errors: [] };
    };
    const orchestrator = createSessionOrchestrator(deps);

    await orchestrator.handleDeleteSession("session-1");

    expect(calls).toContain("deleteSessionFiles:session-1");
  });

  it("works without deleteSessionFiles (optional)", async () => {
    const { deps, calls } = makeMockDeps();
    // deleteSessionFiles is not set — should not crash
    const orchestrator = createSessionOrchestrator(deps);

    await orchestrator.handleDeleteSession("session-1");

    expect(calls).toContain("manager.trash:session-1");
    expect(calls).toContain("refreshList");
  });
});

// ---------------------------------------------------------------------------
// Dependency injection — pure functions, no direct imports
// ---------------------------------------------------------------------------

describe("SessionOrchestrator dependency injection", () => {
  it("factory returns a plain object with all methods", () => {
    const { deps } = makeMockDeps();
    const orchestrator = createSessionOrchestrator(deps);

    expect(typeof orchestrator.handleResumeSession).toBe("function");
    expect(typeof orchestrator.handleAutoArchive).toBe("function");
    expect(typeof orchestrator.handleDeleteSession).toBe("function");
  });

  it("factory returns a fresh instance each call", () => {
    const { deps } = makeMockDeps();
    const o1 = createSessionOrchestrator(deps);
    const o2 = createSessionOrchestrator(deps);

    expect(o1).not.toBe(o2);
  });

  it("does not call any deps during construction", () => {
    const { deps, calls } = makeMockDeps();
    createSessionOrchestrator(deps);

    expect(calls).toHaveLength(0);
  });
});
