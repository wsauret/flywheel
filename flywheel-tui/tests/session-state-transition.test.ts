/**
 * Session State Transition Fix Tests
 *
 * Tests for the fix to "Invalid state transition: new -> work:paused" error
 * that occurs during pipeline completion when the session fails to transition
 * through the proper lifecycle states (new -> plan:imported -> plan:approved ->
 * work:active) during startup.
 *
 * Covers:
 * - handleQueueCompletion gracefully handles session stuck in "new" state
 * - handleAutoArchive gracefully handles session stuck in "new" state
 * - All valid state transitions still work correctly
 */

import { describe, it, expect } from "bun:test";
import {
  handleQueueCompletion,
  type PipelineCompletionDeps,
} from "../src/tui/components/queue-completion";
import {
  createSessionOrchestrator,
  type SessionOrchestratorDeps,
} from "../src/tui/components/session-orchestrator";
import type {
  QueueResult,
  CompletedStepResult,
} from "../src/controller/queue-types";
import type { SessionLifecycleState } from "../src/session/state-machine";
import { isValidTransition } from "../src/session/state-machine";

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

/**
 * Simulates a session manager that tracks lifecycle state and throws on
 * invalid transitions — matching real SessionManager.updateState behavior.
 */
function createStatefulMockManager(initialState: SessionLifecycleState = "new") {
  let currentState: SessionLifecycleState = initialState;
  const transitions: string[] = [];

  return {
    get currentState() { return currentState; },
    transitions,
    updateState: (id: string, newState: SessionLifecycleState) => {
      if (!isValidTransition(currentState, newState)) {
        throw new Error(`Invalid state transition: ${currentState} -> ${newState}`);
      }
      transitions.push(`${currentState} -> ${newState}`);
      currentState = newState;
    },
  };
}

function makeMockDeps(
  overrides?: Partial<PipelineCompletionDeps>,
): { deps: PipelineCompletionDeps; calls: string[] } {
  const calls: string[] = [];
  const deps: PipelineCompletionDeps = {
    orchestrator: {
      handleAutoArchive: async (id: string, _results: CompletedStepResult[]) => {
        calls.push(`handleAutoArchive:${id}`);
      },
    },
    sessionId: "session-1",
    flusher: {
      flush: async () => { calls.push("flusher.flush"); },
      dispose: () => { calls.push("flusher.dispose"); },
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

// ---------------------------------------------------------------------------
// handleQueueCompletion — state transition resilience
// ---------------------------------------------------------------------------

describe("handleQueueCompletion — state transition resilience", () => {
  it("does not throw when updateState throws (session stuck in 'new' state)", async () => {
    const manager = createStatefulMockManager("new");
    const { deps } = makeMockDeps({
      updateState: (id, state) => manager.updateState(id, state as SessionLifecycleState),
    });

    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "plan", completed: true },
        { workflow: "work", completed: true },
        { workflow: "review", completed: true },
      ],
    });

    // Should NOT throw — the handler must be resilient to state transition errors
    await expect(handleQueueCompletion(result, deps)).resolves.toBeUndefined();
  });

  it("still refreshes session list even when state transition fails", async () => {
    const calls: string[] = [];
    const manager = createStatefulMockManager("new");
    const { deps } = makeMockDeps({
      updateState: (id, state) => manager.updateState(id, state as SessionLifecycleState),
      refreshList: () => { calls.push("refreshList"); },
    });

    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    expect(calls).toContain("refreshList");
  });

  it("transitions through intermediate states when session is in 'new' state", async () => {
    const manager = createStatefulMockManager("new");
    const { deps } = makeMockDeps({
      updateState: (id, state) => manager.updateState(id, state as SessionLifecycleState),
    });

    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
        { workflow: "review", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    // Session should end up in completed, having transitioned through intermediate states
    expect(manager.currentState).toBe("completed");
  });

  it("transitions through intermediate states when session is in 'plan:imported' state", async () => {
    const manager = createStatefulMockManager("plan:imported");
    const { deps } = makeMockDeps({
      updateState: (id, state) => manager.updateState(id, state as SessionLifecycleState),
    });

    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    expect(manager.currentState).toBe("completed");
  });

  it("transitions through intermediate states when session is in 'plan:approved' state", async () => {
    const manager = createStatefulMockManager("plan:approved");
    const { deps } = makeMockDeps({
      updateState: (id, state) => manager.updateState(id, state as SessionLifecycleState),
    });

    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    expect(manager.currentState).toBe("completed");
  });

  it("works normally when session is already in 'work:active' state", async () => {
    const manager = createStatefulMockManager("work:active");
    const { deps } = makeMockDeps({
      updateState: (id, state) => manager.updateState(id, state as SessionLifecycleState),
    });

    const result = makeQueueResult({
      completed: true,
      stepResults: [
        { workflow: "work", completed: true },
      ],
    });

    await handleQueueCompletion(result, deps);

    expect(manager.currentState).toBe("completed");
    expect(manager.transitions).toEqual(["work:active -> completed"]);
  });
});

// ---------------------------------------------------------------------------
// handleAutoArchive — state transition resilience
// ---------------------------------------------------------------------------

describe("handleAutoArchive — state transition resilience", () => {
  it("does not throw when session is stuck in 'new' state", async () => {
    const manager = createStatefulMockManager("new");
    const refreshCalls: string[] = [];
    const orchestrator = createSessionOrchestrator({
      readSession: () => ({ sessionLifecycleState: "new" } as any),
      createOutputPersistence: () => ({ load: async () => [] }),
      fromSnapshot: (s) => s as any[],
      manager: {
        updateState: (id, state) => manager.updateState(id, state as SessionLifecycleState),
        trash: () => {},
        archive: () => {},
      },
      refreshList: () => { refreshCalls.push("refreshList"); },
    });

    // Should NOT throw
    await expect(
      orchestrator.handleAutoArchive("session-1", [
        { workflow: "ship", completed: true },
      ]),
    ).resolves.toBeUndefined();

    expect(refreshCalls).toContain("refreshList");
  });

  it("transitions through intermediate states to 'completed' when session is in 'new' state", async () => {
    const manager = createStatefulMockManager("new");
    const orchestrator = createSessionOrchestrator({
      readSession: () => ({ sessionLifecycleState: "new" } as any),
      createOutputPersistence: () => ({ load: async () => [] }),
      fromSnapshot: (s) => s as any[],
      manager: {
        updateState: (id, state) => manager.updateState(id, state as SessionLifecycleState),
        trash: () => {},
        archive: () => {},
      },
      refreshList: () => {},
    });

    await orchestrator.handleAutoArchive("session-1", [
      { workflow: "ship", completed: true },
    ]);

    // Session should end up archived (completed -> archived), having gone through intermediate states
    // The handleAutoArchive should transition to completed, then archive for ship stage
    expect(["completed", "archived"]).toContain(manager.currentState);
  });

  it("works normally when session is in 'work:active' state", async () => {
    const manager = createStatefulMockManager("work:active");
    const orchestrator = createSessionOrchestrator({
      readSession: () => ({ sessionLifecycleState: "work:active" } as any),
      createOutputPersistence: () => ({ load: async () => [] }),
      fromSnapshot: (s) => s as any[],
      manager: {
        updateState: (id, state) => manager.updateState(id, state as SessionLifecycleState),
        trash: () => {},
        archive: () => {},
      },
      refreshList: () => {},
    });

    await orchestrator.handleAutoArchive("session-1", []);

    // Without ship stage, should transition to completed
    expect(manager.currentState).toBe("completed");
  });
});
