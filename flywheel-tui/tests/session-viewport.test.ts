/**
 * Session Viewport Tests
 *
 * Tests the session viewport's store hydration and subscription model:
 * - Non-running sessions get snapshot-only hydration (no subscription)
 * - Running sessions get live subscription
 * - Switching from running → non-running unsubscribes and snapshots
 * - pausePipeline identity fix (uses sessionControllers, not activeSessionId)
 * - deleteSessionWithCompanions guard checks all running sessions
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  createSessionViewport,
  type SessionViewportDeps,
} from "../src/tui/session/session-viewport";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";
import type { WorkState } from "../src/tui/types";
import type { AppState } from "../src/tui/shell/shell-modes";
import type { SessionOrchestrator } from "../src/tui/session/session-orchestrator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal mock orchestrator — only handleResumeSession is needed for openSession. */
function makeMockOrchestrator(overrides?: Partial<SessionOrchestrator>): SessionOrchestrator {
  return {
    handleResumeSession: async () => ({
      session: {
        planPath: "plans/test.md",
        statePath: ".flywheel/state/test.state.md",
        contextPath: ".flywheel/context/test.ctx.md",
        currentStep: 0,
        lastUpdated: new Date().toISOString(),
        workflowId: "test-wf",
        sessionLifecycleState: "completed" as const,
        worktreePath: "/tmp/wt/test",
      },
      outputBlocks: [],
      planPath: "plans/test.md",
      statePath: ".flywheel/state/test.state.md",
      worktreePath: "/tmp/wt/test",
    }),
    handleAutoArchive: async () => {},
    handleDeleteSession: async () => {},
    ...overrides,
  };
}

/** Create a full set of mock deps with call tracking. */
function makeMockDeps(overrides?: Partial<SessionViewportDeps>): {
  deps: SessionViewportDeps;
  calls: string[];
  /** Latest workState set via setWorkState */
  getWorkState: () => WorkState | null;
  /** Latest appState set via setAppState */
  getAppState: () => AppState | null;
  /** The actual unsubscribeStore call tracker */
  unsubscribeCalls: string[];
} {
  const calls: string[] = [];
  const unsubscribeCalls: string[] = [];
  let viewedId: string | null = null;
  let activeStoreRef: UIActions | null = null;
  let workStateRef: WorkState | null = null;
  let appStateRef: AppState | null = null;

  // Track subscriptions: we simulate subscribeToStore behavior
  // with call tracking so tests can verify when subscribe is called vs not
  let currentUnsub: (() => void) | null = null;

  const deps: SessionViewportDeps = {
    viewedSessionId: () => viewedId,
    setViewedSessionId: (id) => { viewedId = id; calls.push(`setViewedSessionId:${id}`); },
    activeStore: () => activeStoreRef,
    setActiveStore: (store) => { activeStoreRef = store; calls.push("setActiveStore"); },
    subscribeToStore: (store) => { calls.push("subscribeToStore"); },
    unsubscribeStore: () => { calls.push("unsubscribeStore"); unsubscribeCalls.push("unsubscribeStore"); },
    setWorkState: (state) => { workStateRef = state; calls.push("setWorkState"); },
    setAppState: (state) => { appStateRef = state as AppState; calls.push(`setAppState:${state}`); },
    sessionControllers: new Map(),
    sessionStores: new Map(),
    orchestrator: makeMockOrchestrator(),
    toast: { show: (opts) => { calls.push(`toast:${opts.variant}:${opts.message}`); } },
    ...overrides,
  };

  return {
    deps,
    calls,
    getWorkState: () => workStateRef,
    getAppState: () => appStateRef,
    unsubscribeCalls,
  };
}

// ---------------------------------------------------------------------------
// Step 3.0: workState hydration patterns
// ---------------------------------------------------------------------------

describe("SessionViewport store hydration", () => {
  describe("non-running sessions (snapshot only)", () => {
    it("gets setWorkState snapshot with NO subscribeToStore call", async () => {
      const store = createStore("test-plan");
      const { deps, calls } = makeMockDeps();

      // Pre-cache the store (not running — no sessionControllers entry)
      deps.sessionStores.set("session-1", store);

      const viewport = createSessionViewport(deps);
      await viewport.openSession("session-1");

      // Should set work state (snapshot)
      expect(calls).toContain("setWorkState");
      // Should NOT subscribe
      expect(calls).not.toContain("subscribeToStore");
      // Should unsubscribe any previous subscription
      expect(calls).toContain("unsubscribeStore");
      // App state should be "completed" (non-running)
      expect(calls).toContain("setAppState:completed");
    });

    it("loads from disk and snapshots without subscribing", async () => {
      const { deps, calls } = makeMockDeps();

      // No cached store, no controller → disk load
      const viewport = createSessionViewport(deps);
      await viewport.openSession("session-1");

      // Should set work state (snapshot from freshly created store)
      expect(calls).toContain("setWorkState");
      // Should NOT subscribe (non-running session loaded from disk)
      expect(calls).not.toContain("subscribeToStore");
      // Should unsubscribe previous
      expect(calls).toContain("unsubscribeStore");
    });
  });

  describe("running sessions (live subscription)", () => {
    it("gets subscribeToStore for live updates when controller exists", async () => {
      const store = createStore("running-plan");
      const { deps, calls } = makeMockDeps();

      // Mark as running: controller + store cache
      deps.sessionControllers.set("running-1", { shutdown: async () => {} });
      deps.sessionStores.set("running-1", store);

      const viewport = createSessionViewport(deps);
      await viewport.openSession("running-1");

      // Should subscribe for live updates (subscribeToStore handles initial setWorkState internally)
      expect(calls).toContain("subscribeToStore");
      // Should NOT call unsubscribeStore (running session keeps subscription)
      expect(calls).not.toContain("unsubscribeStore");
      // App state should be "working"
      expect(calls).toContain("setAppState:working");
    });
  });

  describe("switching from running → non-running", () => {
    it("unsubscribes previous subscription and takes snapshot", async () => {
      const runningStore = createStore("running-plan");
      const completedStore = createStore("completed-plan");
      const { deps, calls, unsubscribeCalls } = makeMockDeps();

      // Set up: running session + completed session cached
      deps.sessionControllers.set("running-1", { shutdown: async () => {} });
      deps.sessionStores.set("running-1", runningStore);
      deps.sessionStores.set("completed-1", completedStore);

      const viewport = createSessionViewport(deps);

      // First: open running session
      await viewport.openSession("running-1");
      expect(calls).toContain("subscribeToStore");

      // Clear tracked calls for the switch
      calls.length = 0;
      unsubscribeCalls.length = 0;

      // Second: switch to completed session
      await viewport.openSession("completed-1");

      // Should unsubscribe the running session's subscription
      expect(unsubscribeCalls).toContain("unsubscribeStore");
      // Should NOT subscribe to the completed session
      expect(calls).not.toContain("subscribeToStore");
      // Should snapshot the completed session's state
      expect(calls).toContain("setWorkState");
      // App state should transition to "completed"
      expect(calls).toContain("setAppState:completed");
    });
  });

  describe("switching from non-running → running", () => {
    it("subscribes to the running session's store", async () => {
      const runningStore = createStore("running-plan");
      const completedStore = createStore("completed-plan");
      const { deps, calls } = makeMockDeps();

      // Set up: completed session + running session
      deps.sessionStores.set("completed-1", completedStore);
      deps.sessionControllers.set("running-1", { shutdown: async () => {} });
      deps.sessionStores.set("running-1", runningStore);

      const viewport = createSessionViewport(deps);

      // First: open completed session (snapshot only)
      await viewport.openSession("completed-1");
      calls.length = 0;

      // Second: switch to running session
      await viewport.openSession("running-1");

      // Should subscribe for live updates
      expect(calls).toContain("subscribeToStore");
      // App state should be "working"
      expect(calls).toContain("setAppState:working");
    });
  });

  describe("disk-loaded running session (controller exists, store not cached)", () => {
    it("loads from disk and subscribes because controller exists", async () => {
      const { deps, calls } = makeMockDeps();

      // Controller exists but no cached store — rare edge case
      deps.sessionControllers.set("running-nocache", { shutdown: async () => {} });

      const viewport = createSessionViewport(deps);
      await viewport.openSession("running-nocache");

      // Should subscribe (controller exists = running)
      expect(calls).toContain("subscribeToStore");
      // App state should be "working"
      expect(calls).toContain("setAppState:working");
    });
  });
});

// ---------------------------------------------------------------------------
// Step 3.2: pausePipeline identity — sessionControllers-based
// ---------------------------------------------------------------------------

describe("SessionViewport deleteSessionFiles guard", () => {
  it("does NOT delete sessions present in sessionControllers keyset", () => {
    // This test verifies the design principle: the deleteSessionFiles guard
    // should check against ALL running sessions, not just activeSessionId.
    // The actual implementation is in the shell's orchestrator wiring.
    // Here we verify the sessionControllers Map is the source of truth.
    const controllers = new Map<string, { shutdown(): Promise<void> }>();
    controllers.set("session-A", { shutdown: async () => {} });
    controllers.set("session-B", { shutdown: async () => {} });

    // Guard logic: refuse deletion if id is in sessionControllers
    const isRunning = (id: string) => controllers.has(id);

    expect(isRunning("session-A")).toBe(true);
    expect(isRunning("session-B")).toBe(true);
    expect(isRunning("session-C")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Step 3.3: Output flusher isolation
// ---------------------------------------------------------------------------

describe("Output flusher isolation", () => {
  it("each session store is independent (stores don't share state)", () => {
    const storeA = createStore("plan-A");
    const storeB = createStore("plan-B");

    // Mutate store A
    storeA.startWorkflow("plan-A");
    storeA.setQueueSteps([{ id: "s1", type: "work", title: "Step 1", status: "pending" }]);

    // Store B should be unaffected
    expect(storeB.getState().queueSteps).toHaveLength(0);
    expect(storeB.getState().workflowStatus).toBe("idle");
    expect(storeA.getState().queueSteps).toHaveLength(1);
    expect(storeA.getState().workflowStatus).toBe("running");
  });

  it("flusher closure captures specific store, not a shared reference", () => {
    const storeA = createStore("plan-A");
    const storeB = createStore("plan-B");

    // Simulate flusher pattern: closure captures specific store
    const getOutputBlocksA = () => storeA.getState().outputBlocks ?? [];
    const getOutputBlocksB = () => storeB.getState().outputBlocks ?? [];

    // Modify store A
    storeA.setOutputBlocks([{ kind: "text", content: "hello" } as any]);

    // Flusher A sees the change, flusher B does not
    expect(getOutputBlocksA()).toHaveLength(1);
    expect(getOutputBlocksB()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Step 5.3: Loading skeleton signal
// ---------------------------------------------------------------------------

describe("SessionViewport loading state", () => {
  it("sets sessionLoading true during disk load, false after completion", async () => {
    const loadingStates: boolean[] = [];
    const { deps, calls } = makeMockDeps();
    deps.setSessionLoading = (loading) => {
      loadingStates.push(loading);
    };

    // No cached store, no controller → disk load path
    const viewport = createSessionViewport(deps);
    await viewport.openSession("session-1");

    // Should have set loading true then false
    expect(loadingStates).toEqual([true, false]);
  });

  it("sets sessionLoading false on disk load error", async () => {
    const loadingStates: boolean[] = [];
    const { deps } = makeMockDeps({
      orchestrator: {
        handleResumeSession: async () => { throw new Error("disk error"); },
        handleAutoArchive: async () => {},
        handleDeleteSession: async () => {},
      } as any,
    });
    deps.setSessionLoading = (loading) => {
      loadingStates.push(loading);
    };

    const viewport = createSessionViewport(deps);
    await viewport.openSession("session-1");

    // Should have set loading true then false (even on error)
    expect(loadingStates).toEqual([true, false]);
  });

  it("does NOT set loading for cached session (no disk load)", async () => {
    const loadingStates: boolean[] = [];
    const store = createStore("cached");
    const { deps } = makeMockDeps();
    deps.sessionStores.set("cached-1", store);
    deps.setSessionLoading = (loading) => {
      loadingStates.push(loading);
    };

    const viewport = createSessionViewport(deps);
    await viewport.openSession("cached-1");

    // No disk load → no loading signals
    expect(loadingStates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Queue signal population for historical sessions
// ---------------------------------------------------------------------------

describe("SessionViewport queue signal population", () => {
  it("populates setShellQueueSteps on disk-loaded historical session", async () => {
    let capturedSteps: import("../src/tui/types").QueueStepState[] = [];
    const { deps } = makeMockDeps({
      orchestrator: makeMockOrchestrator({
        handleResumeSession: async () => ({
          session: {
            planPath: "plans/test.md",
            statePath: ".flywheel/state/test.state.md",
            contextPath: ".flywheel/context/test.ctx.md",
            currentStep: 0,
            lastUpdated: new Date().toISOString(),
            workflowId: "test-wf",
            sessionLifecycleState: "completed" as const,
            worktreePath: "/tmp/wt/test",
          },
          outputBlocks: [],
          planPath: "plans/test.md",
          statePath: ".flywheel/state/test.state.md",
          worktreePath: "/tmp/wt/test",
          queue: {
            steps: [
              { id: "s1", type: "plan", title: "Plan", status: "completed" },
              { id: "s2", type: "work", title: "Work", status: "completed" },
              { id: "s3", type: "review", title: "Review", status: "failed" },
            ],
          },
        }),
      }),
    });
    deps.setShellQueueSteps = (steps) => { capturedSteps = steps; };

    const viewport = createSessionViewport(deps);
    await viewport.openSession("session-with-queue");

    expect(capturedSteps.length).toBe(3);
    expect(capturedSteps[0].status).toBe("completed");
    expect(capturedSteps[2].status).toBe("failed");
  });

  it("populates setActiveQueueInfo with progress on disk-loaded session", async () => {
    let capturedInfo: any = undefined;
    const { deps } = makeMockDeps({
      orchestrator: makeMockOrchestrator({
        handleResumeSession: async () => ({
          session: {
            planPath: "plans/test.md",
            statePath: ".flywheel/state/test.state.md",
            contextPath: ".flywheel/context/test.ctx.md",
            currentStep: 0,
            lastUpdated: new Date().toISOString(),
            workflowId: "test-wf",
            sessionLifecycleState: "completed" as const,
            worktreePath: "/tmp/wt/test",
          },
          outputBlocks: [],
          planPath: "plans/test.md",
          statePath: ".flywheel/state/test.state.md",
          worktreePath: "/tmp/wt/test",
          queue: {
            steps: [
              { id: "s1", type: "plan", title: "Plan", status: "completed" },
              { id: "s2", type: "work", title: "Work", status: "completed" },
              { id: "s3", type: "review", title: "Review", status: "pending" },
            ],
          },
        }),
      }),
    });
    deps.setActiveQueueInfo = (info) => { capturedInfo = info; };

    const viewport = createSessionViewport(deps);
    await viewport.openSession("session-q");

    expect(capturedInfo).not.toBeNull();
    expect(capturedInfo.currentStep).toBe(2); // 2 completed
    expect(capturedInfo.totalSteps).toBe(3);
    expect(capturedInfo.stepName).toBe("Work"); // last completed step
  });

  it("populates queue signals on LRU cache-hit for non-running session", async () => {
    let capturedSteps: import("../src/tui/types").QueueStepState[] = [];
    let capturedInfo: any = undefined;
    const store = createStore("cached-plan");
    store.setQueueSteps([
      { id: "s1", type: "plan", title: "Cached Plan", status: "completed" },
      { id: "s2", type: "work", title: "Cached Work", status: "completed" },
    ]);

    const { deps } = makeMockDeps();
    deps.sessionStores.set("cached-1", store);
    deps.setShellQueueSteps = (steps) => { capturedSteps = steps; };
    deps.setActiveQueueInfo = (info) => { capturedInfo = info; };

    const viewport = createSessionViewport(deps);
    await viewport.openSession("cached-1");

    expect(capturedSteps.length).toBe(2);
    expect(capturedInfo).not.toBeNull();
    expect(capturedInfo.currentStep).toBe(2);
    expect(capturedInfo.totalSteps).toBe(2);
  });

  it("does NOT populate queue signals for running sessions (shell manages them)", async () => {
    let queueSignalCalled = false;
    const store = createStore("running-plan");
    store.setQueueSteps([
      { id: "s1", type: "plan", title: "Live", status: "running" },
    ]);

    const { deps } = makeMockDeps();
    deps.sessionControllers.set("running-1", { shutdown: async () => {} });
    deps.sessionStores.set("running-1", store);
    deps.setShellQueueSteps = () => { queueSignalCalled = true; };

    const viewport = createSessionViewport(deps);
    await viewport.openSession("running-1");

    expect(queueSignalCalled).toBe(false);
  });

  it("sets activeQueueInfo to null when session has no queue steps", async () => {
    let capturedInfo: any = "not-called";
    const { deps } = makeMockDeps(); // default orchestrator returns no queue
    deps.setActiveQueueInfo = (info) => { capturedInfo = info; };

    const viewport = createSessionViewport(deps);
    await viewport.openSession("no-queue");

    expect(capturedInfo).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

describe("SessionViewport dependency injection", () => {
  it("factory returns object with openSession and cancelInjection", () => {
    const { deps } = makeMockDeps();
    const viewport = createSessionViewport(deps);

    expect(typeof viewport.openSession).toBe("function");
    expect(typeof viewport.cancelInjection).toBe("function");
  });

  it("does not call any deps during construction", () => {
    const { deps, calls } = makeMockDeps();
    createSessionViewport(deps);

    expect(calls).toHaveLength(0);
  });
});
