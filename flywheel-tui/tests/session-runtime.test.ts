import { describe, it, expect, beforeEach } from "bun:test";
import {
  type SessionRuntime,
  type PendingRuntime,
  type RunningRuntime,
  isPendingRuntime,
  isRunningRuntime,
  createSessionRuntimeManager,
  type SessionRuntimeManager,
  type SessionRuntimeManagerDeps,
} from "../src/tui/components/session-runtime";
import type { WorkflowSession } from "../src/tui/components/workflow-session";
import type { OutputFlusher } from "../src/session/output-persistence";
import type { BudgetTracker } from "../src/session/budget-tracker";
import { TimerService } from "../src/tui/shared/services/timer";

// ── Test Helpers ──

/** Create a minimal mock WorkflowSession for testing. */
function mockSession(planPath = "test-plan.md"): WorkflowSession {
  return {
    store: {} as WorkflowSession["store"],
    adapter: {
      stop: () => {},
      disconnect: () => {},
      pauseFlush: () => {},
      resumeFlush: () => {},
    } as unknown as WorkflowSession["adapter"],
    eventBus: {} as WorkflowSession["eventBus"],
    planPath,
    timer: new TimerService(),
  };
}

/** Create a mock OutputFlusher. */
function mockFlusher(): OutputFlusher & { disposed: boolean } {
  return {
    disposed: false,
    schedule: () => {},
    flush: async () => {},
    dispose() { this.disposed = true; },
  };
}

/** Create a mock BudgetTracker. */
function mockBudgetTracker(): BudgetTracker & { disposed: boolean } {
  return {
    disposed: false,
    handleEvent: () => {},
    getTotalCost: () => 0,
    incrementInvocations: () => {},
    getInvocationsUsed: () => 0,
    getTokensUsed: () => 0,
    isExhausted: () => false,
    getBudgetStatus: () => ({
      invocations_remaining: null,
      token_budget_remaining: null,
      wall_clock_deadline: null,
    }),
    flush: () => {},
    dispose() { this.disposed = true; },
  };
}

/** Track destroy calls. */
function trackingDestroySession(): { calls: WorkflowSession[]; fn: (s: WorkflowSession) => void } {
  const calls: WorkflowSession[] = [];
  return { calls, fn: (s: WorkflowSession) => calls.push(s) };
}

/** Default manager deps with a tracking destroy function. */
function makeDeps(overrides?: Partial<SessionRuntimeManagerDeps>): SessionRuntimeManagerDeps {
  const tracker = trackingDestroySession();
  return {
    destroyWorkflowSession: overrides?.destroyWorkflowSession ?? tracker.fn,
  };
}

// ── Step 2.2: SessionRuntime Discriminated Union ──

describe("SessionRuntime discriminated union", () => {
  it("PendingRuntime has kind 'pending'", () => {
    const session = mockSession();
    const runtime: PendingRuntime = {
      kind: "pending",
      sessionId: "sess-1",
      session,
    };
    expect(runtime.kind).toBe("pending");
    expect(runtime.sessionId).toBe("sess-1");
    expect(runtime.session).toBe(session);
  });

  it("RunningRuntime has kind 'running' with all fields", () => {
    const session = mockSession();
    const flusher = mockFlusher();
    const budget = mockBudgetTracker();
    const runtime: RunningRuntime = {
      kind: "running",
      sessionId: "sess-2",
      session,

      flusher,
      budgetTracker: budget,
      storeUnsub: () => {},
      questionCleanup: () => {},
      queueCleanup: () => {},
      contextIndexer: null,
      workerPid: null,
    };
    expect(runtime.kind).toBe("running");
    expect(runtime.flusher).toBe(flusher);
    expect(runtime.budgetTracker).toBe(budget);
    expect(runtime.workerPid).toBeNull();
  });

  it("isPendingRuntime type guard returns true for pending", () => {
    const runtime: SessionRuntime = {
      kind: "pending",
      sessionId: "sess-1",
      session: mockSession(),
    };
    expect(isPendingRuntime(runtime)).toBe(true);
    expect(isRunningRuntime(runtime)).toBe(false);
  });

  it("isRunningRuntime type guard returns true for running", () => {
    const runtime: SessionRuntime = {
      kind: "running",
      sessionId: "sess-2",
      session: mockSession(),

      flusher: mockFlusher(),
      budgetTracker: mockBudgetTracker(),
      storeUnsub: () => {},
      questionCleanup: () => {},
      queueCleanup: () => {},
      contextIndexer: null,
      workerPid: null,
    };
    expect(isRunningRuntime(runtime)).toBe(true);
    expect(isPendingRuntime(runtime)).toBe(false);
  });
});

// ── Step 2.3: createSessionRuntimeManager ──

describe("createSessionRuntimeManager", () => {
  let manager: SessionRuntimeManager;
  let destroyTracker: { calls: WorkflowSession[]; fn: (s: WorkflowSession) => void };

  beforeEach(() => {
    destroyTracker = trackingDestroySession();
    manager = createSessionRuntimeManager({
      destroyWorkflowSession: destroyTracker.fn,
    });
  });

  describe("register + get", () => {
    it("registers a pending runtime and retrieves it", () => {
      const session = mockSession();
      const runtime: PendingRuntime = { kind: "pending", sessionId: "s1", session };
      manager.register("s1", runtime);
      expect(manager.get("s1")).toBe(runtime);
    });

    it("registers a running runtime and retrieves it", () => {
      const runtime: RunningRuntime = {
        kind: "running",
        sessionId: "s2",
        session: mockSession(),

        flusher: mockFlusher(),
        budgetTracker: mockBudgetTracker(),
        storeUnsub: () => {},
        questionCleanup: () => {},
        queueCleanup: () => {},
        contextIndexer: null,
        workerPid: null,
      };
      manager.register("s2", runtime);
      expect(manager.get("s2")).toBe(runtime);
    });

    it("returns undefined for unknown ID", () => {
      expect(manager.get("nonexistent")).toBeUndefined();
    });
  });

  describe("has + size", () => {
    it("has() returns true for registered, false for unknown", () => {
      manager.register("s1", { kind: "pending", sessionId: "s1", session: mockSession() });
      expect(manager.has("s1")).toBe(true);
      expect(manager.has("s2")).toBe(false);
    });

    it("size reflects number of registered runtimes", () => {
      expect(manager.size).toBe(0);
      manager.register("s1", { kind: "pending", sessionId: "s1", session: mockSession() });
      expect(manager.size).toBe(1);
      manager.register("s2", { kind: "pending", sessionId: "s2", session: mockSession() });
      expect(manager.size).toBe(2);
    });
  });

  describe("promote", () => {
    it("promotes pending to running", () => {
      const session = mockSession();
      manager.register("s1", { kind: "pending", sessionId: "s1", session });

      const fields = {

        flusher: mockFlusher(),
        budgetTracker: mockBudgetTracker(),
        storeUnsub: () => {},
        questionCleanup: () => {},
        queueCleanup: () => {},
        contextIndexer: null,
        workerPid: null,
      };
      manager.promote("s1", fields);

      const runtime = manager.get("s1");
      expect(runtime?.kind).toBe("running");
      expect((runtime as RunningRuntime).session).toBe(session);
      expect((runtime as RunningRuntime).flusher).toBe(fields.flusher);
    });

    it("throws when promoting a non-existent ID", () => {
      expect(() =>
        manager.promote("nonexistent", {
          flusher: mockFlusher(),
          budgetTracker: mockBudgetTracker(),
          storeUnsub: () => {},
          questionCleanup: () => {},
          queueCleanup: () => {},
          contextIndexer: null,
          workerPid: null,
        })
      ).toThrow();
    });
  });

  describe("getRunningIds", () => {
    it("returns only IDs with kind 'running'", () => {
      manager.register("s1", { kind: "pending", sessionId: "s1", session: mockSession() });
      manager.register("s2", {
        kind: "running",
        sessionId: "s2",
        session: mockSession(),

        flusher: mockFlusher(),
        budgetTracker: mockBudgetTracker(),
        storeUnsub: () => {},
        questionCleanup: () => {},
        queueCleanup: () => {},
        contextIndexer: null,
        workerPid: null,
      });
      manager.register("s3", { kind: "pending", sessionId: "s3", session: mockSession() });

      expect(manager.getRunningIds()).toEqual(["s2"]);
    });

    it("returns empty array when no running runtimes", () => {
      manager.register("s1", { kind: "pending", sessionId: "s1", session: mockSession() });
      expect(manager.getRunningIds()).toEqual([]);
    });
  });

  describe("background + foreground", () => {
    it("background calls adapter.pauseFlush on a running runtime", () => {
      let paused = false;
      const session = mockSession();
      (session.adapter as any).pauseFlush = () => { paused = true; };

      manager.register("s1", {
        kind: "running",
        sessionId: "s1",
        session,

        flusher: mockFlusher(),
        budgetTracker: mockBudgetTracker(),
        storeUnsub: () => {},
        questionCleanup: () => {},
        queueCleanup: () => {},
        contextIndexer: null,
        workerPid: null,
      });

      manager.background("s1");
      expect(paused).toBe(true);
    });

    it("foreground calls adapter.resumeFlush on a running runtime", () => {
      let resumed = false;
      const session = mockSession();
      (session.adapter as any).resumeFlush = () => { resumed = true; };

      manager.register("s1", {
        kind: "running",
        sessionId: "s1",
        session,

        flusher: mockFlusher(),
        budgetTracker: mockBudgetTracker(),
        storeUnsub: () => {},
        questionCleanup: () => {},
        queueCleanup: () => {},
        contextIndexer: null,
        workerPid: null,
      });

      manager.foreground("s1");
      expect(resumed).toBe(true);
    });

    it("background/foreground is no-op for pending runtimes", () => {
      manager.register("s1", { kind: "pending", sessionId: "s1", session: mockSession() });
      // Should not throw
      manager.background("s1");
      manager.foreground("s1");
    });

    it("background/foreground is no-op for unknown IDs", () => {
      // Should not throw
      manager.background("nonexistent");
      manager.foreground("nonexistent");
    });
  });

  // ── Step 2.4: teardown isolation ──

  describe("teardown", () => {
    it("tears down a single runtime and removes it from the map", () => {
      const session = mockSession();
      const flusher = mockFlusher();
      const budget = mockBudgetTracker();
      let storeUnsubbed = false;
      let questionCleaned = false;
      let queueCleaned = false;

      manager.register("s1", {
        kind: "running",
        sessionId: "s1",
        session,

        flusher,
        budgetTracker: budget,
        storeUnsub: () => { storeUnsubbed = true; },
        questionCleanup: () => { questionCleaned = true; },
        queueCleanup: () => { queueCleaned = true; },
        contextIndexer: null,
        workerPid: null,
      });

      manager.teardown("s1");

      expect(manager.has("s1")).toBe(false);
      expect(manager.size).toBe(0);
      expect(flusher.disposed).toBe(true);
      expect(budget.disposed).toBe(true);
      expect(storeUnsubbed).toBe(true);
      expect(questionCleaned).toBe(true);
      expect(queueCleaned).toBe(true);
      expect(destroyTracker.calls).toHaveLength(1);
      expect(destroyTracker.calls[0]).toBe(session);
    });

    it("teardown of one runtime does not affect another", () => {
      const sessionA = mockSession("plan-a.md");
      const sessionB = mockSession("plan-b.md");
      const flusherA = mockFlusher();
      const flusherB = mockFlusher();

      const makeRunning = (id: string, session: WorkflowSession, flusher: OutputFlusher & { disposed: boolean }): RunningRuntime => ({
        kind: "running",
        sessionId: id,
        session,

        flusher,
        budgetTracker: mockBudgetTracker(),
        storeUnsub: () => {},
        questionCleanup: () => {},
        queueCleanup: () => {},
        contextIndexer: null,
        workerPid: null,
      });

      manager.register("a", makeRunning("a", sessionA, flusherA));
      manager.register("b", makeRunning("b", sessionB, flusherB));

      manager.teardown("a");

      // A is gone
      expect(manager.has("a")).toBe(false);
      expect(flusherA.disposed).toBe(true);
      expect(destroyTracker.calls).toHaveLength(1);
      expect(destroyTracker.calls[0]).toBe(sessionA);

      // B is unaffected
      expect(manager.has("b")).toBe(true);
      expect(flusherB.disposed).toBe(false);
      expect(manager.get("b")?.session).toBe(sessionB);
    });

    it("teardown is no-op for unknown IDs", () => {
      manager.teardown("nonexistent");
      expect(manager.size).toBe(0);
    });

    it("teardown of pending runtime destroys session only", () => {
      const session = mockSession();
      manager.register("s1", { kind: "pending", sessionId: "s1", session });

      manager.teardown("s1");

      expect(manager.has("s1")).toBe(false);
      expect(destroyTracker.calls).toHaveLength(1);
      expect(destroyTracker.calls[0]).toBe(session);
    });

    it("teardown uses try/finally per resource — one failure doesn't block others", () => {
      const session = mockSession();
      const budget = mockBudgetTracker();
      let questionCleaned = false;

      // Flusher dispose throws
      const throwingFlusher: OutputFlusher & { disposed: boolean } = {
        disposed: false,
        schedule: () => {},
        flush: async () => {},
        dispose() {
          this.disposed = true;
          throw new Error("flusher disposal failed");
        },
      };

      manager.register("s1", {
        kind: "running",
        sessionId: "s1",
        session,

        flusher: throwingFlusher,
        budgetTracker: budget,
        storeUnsub: () => {},
        questionCleanup: () => { questionCleaned = true; },
        queueCleanup: () => {},
        contextIndexer: null,
        workerPid: null,
      });

      // Should NOT throw despite flusher.dispose() throwing
      manager.teardown("s1");

      // Other resources are still cleaned up
      expect(budget.disposed).toBe(true);
      expect(questionCleaned).toBe(true);
      expect(destroyTracker.calls).toHaveLength(1);
      expect(manager.has("s1")).toBe(false);
    });

    it("teardown disposes contextIndexer when present", () => {
      const session = mockSession();
      let indexerDisposed = false;
      const fakeIndexer = { dispose: () => { indexerDisposed = true; } };

      manager.register("s1", {
        kind: "running",
        sessionId: "s1",
        session,

        flusher: mockFlusher(),
        budgetTracker: mockBudgetTracker(),
        storeUnsub: () => {},
        questionCleanup: () => {},
        queueCleanup: () => {},
        contextIndexer: fakeIndexer as any,
        workerPid: null,
      });

      manager.teardown("s1");
      expect(indexerDisposed).toBe(true);
    });
  });

  describe("teardownAll", () => {
    it("tears down all runtimes", () => {
      const sessionA = mockSession("a.md");
      const sessionB = mockSession("b.md");

      manager.register("a", {
        kind: "running",
        sessionId: "a",
        session: sessionA,

        flusher: mockFlusher(),
        budgetTracker: mockBudgetTracker(),
        storeUnsub: () => {},
        questionCleanup: () => {},
        queueCleanup: () => {},
        contextIndexer: null,
        workerPid: null,
      });
      manager.register("b", { kind: "pending", sessionId: "b", session: sessionB });

      manager.teardownAll();

      expect(manager.size).toBe(0);
      expect(destroyTracker.calls).toHaveLength(2);
    });
  });

  describe("multiple concurrent runtimes", () => {
    it("three runtimes coexist independently", () => {
      const sessions = ["s1", "s2", "s3"].map((id) => ({
        id,
        session: mockSession(`${id}.md`),
      }));

      for (const { id, session } of sessions) {
        manager.register(id, { kind: "pending", sessionId: id, session });
      }

      expect(manager.size).toBe(3);
      for (const { id, session } of sessions) {
        expect(manager.get(id)?.session).toBe(session);
      }

      // Promote one
      manager.promote("s2", {

        flusher: mockFlusher(),
        budgetTracker: mockBudgetTracker(),
        storeUnsub: () => {},
        questionCleanup: () => {},
        queueCleanup: () => {},
        contextIndexer: null,
        workerPid: 1234,
      });

      expect(manager.get("s1")?.kind).toBe("pending");
      expect(manager.get("s2")?.kind).toBe("running");
      expect((manager.get("s2") as RunningRuntime).workerPid).toBe(1234);
      expect(manager.get("s3")?.kind).toBe("pending");
      expect(manager.getRunningIds()).toEqual(["s2"]);
    });
  });

  describe("remove (no disposal)", () => {
    it("removes a runtime from the map without disposing resources", () => {
      const session = mockSession();
      const flusher = mockFlusher();

      manager.register("s1", {
        kind: "running",
        sessionId: "s1",
        session,

        flusher,
        budgetTracker: mockBudgetTracker(),
        storeUnsub: () => {},
        questionCleanup: () => {},
        queueCleanup: () => {},
        contextIndexer: null,
        workerPid: null,
      });

      manager.remove("s1");

      expect(manager.has("s1")).toBe(false);
      expect(manager.size).toBe(0);
      // Flusher was NOT disposed — that's the key difference from teardown
      expect(flusher.disposed).toBe(false);
      // destroyWorkflowSession was NOT called
      expect(destroyTracker.calls).toHaveLength(0);
    });

    it("remove is no-op for unknown IDs", () => {
      manager.remove("nonexistent");
      expect(manager.size).toBe(0);
    });
  });
});
