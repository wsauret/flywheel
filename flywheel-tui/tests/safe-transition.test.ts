/**
 * Safe Transition & Path Finding Tests
 *
 * Tests for findTransitionPath (state-machine.ts) and safeUpdateState
 * (safe-transition.ts) which together handle graceful state transitions
 * when sessions are stuck in intermediate states.
 */

import { describe, it, expect } from "bun:test";
import {
  findTransitionPath,
  isValidTransition,
  type SessionLifecycleState,
} from "../src/orchestration/session/state-machine";
import { safeUpdateState } from "../src/orchestration/session/safe-transition";

// ---------------------------------------------------------------------------
// findTransitionPath
// ---------------------------------------------------------------------------

describe("findTransitionPath", () => {
  it("returns empty array when from === to (already at target)", () => {
    expect(findTransitionPath("work:active", "work:active")).toEqual([]);
  });

  it("returns single-step path for direct transitions", () => {
    expect(findTransitionPath("work:active", "work:paused")).toEqual(["work:paused"]);
    expect(findTransitionPath("new", "plan:imported")).toEqual(["plan:imported"]);
    expect(findTransitionPath("completed", "archived")).toEqual(["archived"]);
  });

  it("finds multi-step path from 'new' to 'work:paused'", () => {
    const path = findTransitionPath("new", "work:paused");
    expect(path).not.toBeNull();
    expect(path!.length).toBeGreaterThan(1);
    expect(path![path!.length - 1]).toBe("work:paused");

    // Verify every step is a valid transition
    let current: SessionLifecycleState = "new";
    for (const step of path!) {
      expect(isValidTransition(current, step)).toBe(true);
      current = step;
    }
  });

  it("finds path from 'new' to 'completed'", () => {
    const path = findTransitionPath("new", "completed");
    expect(path).not.toBeNull();
    expect(path![path!.length - 1]).toBe("completed");

    // Verify every step is valid
    let current: SessionLifecycleState = "new";
    for (const step of path!) {
      expect(isValidTransition(current, step)).toBe(true);
      current = step;
    }
  });

  it("finds path from 'plan:imported' to 'work:paused'", () => {
    const path = findTransitionPath("plan:imported", "work:paused");
    expect(path).not.toBeNull();
    // plan:imported -> plan:approved -> work:active -> work:paused
    expect(path).toEqual(["plan:approved", "work:active", "work:paused"]);
  });

  it("finds path from 'plan:approved' to 'work:paused'", () => {
    const path = findTransitionPath("plan:approved", "work:paused");
    expect(path).not.toBeNull();
    // plan:approved -> work:active -> work:paused
    expect(path).toEqual(["work:active", "work:paused"]);
  });

  it("returns null for unreachable transitions (terminal states)", () => {
    expect(findTransitionPath("archived", "work:active")).toBeNull();
    expect(findTransitionPath("trashed", "new")).toBeNull();
  });

  it("returns shortest path (BFS property)", () => {
    // new -> plan:imported (1 step, direct)
    const path = findTransitionPath("new", "plan:imported");
    expect(path).toEqual(["plan:imported"]);
  });
});

// ---------------------------------------------------------------------------
// safeUpdateState
// ---------------------------------------------------------------------------

describe("safeUpdateState", () => {
  /** Stateful mock that tracks state and validates transitions */
  function createStatefulManager(initialState: SessionLifecycleState) {
    let state: SessionLifecycleState = initialState;
    const transitions: string[] = [];

    return {
      get state() { return state; },
      transitions,
      updateState: (_id: string, newState: SessionLifecycleState) => {
        if (!isValidTransition(state, newState)) {
          throw new Error(`Invalid state transition: ${state} -> ${newState}`);
        }
        transitions.push(`${state} -> ${newState}`);
        state = newState;
      },
    };
  }

  it("uses direct transition when valid", () => {
    const mgr = createStatefulManager("work:active");
    safeUpdateState(mgr.updateState, "s1", "work:paused");
    expect(mgr.state).toBe("work:paused");
    expect(mgr.transitions).toEqual(["work:active -> work:paused"]);
  });

  it("chains through intermediate states when direct transition is invalid (new -> work:paused)", () => {
    const mgr = createStatefulManager("new");
    safeUpdateState(mgr.updateState, "s1", "work:paused");
    expect(mgr.state).toBe("work:paused");
    // Should have gone through: new -> plan:imported -> plan:approved -> work:active -> work:paused
    expect(mgr.transitions).toEqual([
      "new -> plan:imported",
      "plan:imported -> plan:approved",
      "plan:approved -> work:active",
      "work:active -> work:paused",
    ]);
  });

  it("chains through intermediate states (new -> completed)", () => {
    const mgr = createStatefulManager("new");
    safeUpdateState(mgr.updateState, "s1", "completed");
    expect(mgr.state).toBe("completed");
  });

  it("chains from plan:imported to work:paused", () => {
    const mgr = createStatefulManager("plan:imported");
    safeUpdateState(mgr.updateState, "s1", "work:paused");
    expect(mgr.state).toBe("work:paused");
    expect(mgr.transitions).toEqual([
      "plan:imported -> plan:approved",
      "plan:approved -> work:active",
      "work:active -> work:paused",
    ]);
  });

  it("chains from plan:approved to work:paused", () => {
    const mgr = createStatefulManager("plan:approved");
    safeUpdateState(mgr.updateState, "s1", "work:paused");
    expect(mgr.state).toBe("work:paused");
    expect(mgr.transitions).toEqual([
      "plan:approved -> work:active",
      "work:active -> work:paused",
    ]);
  });

  it("does not throw when transition is impossible (terminal state)", () => {
    const mgr = createStatefulManager("archived");
    // archived has no outbound transitions — should silently fail
    expect(() => safeUpdateState(mgr.updateState, "s1", "work:paused")).not.toThrow();
    expect(mgr.state).toBe("archived"); // unchanged
  });

  it("does not throw when updateState always throws", () => {
    const alwaysThrow = () => { throw new Error("disk full"); };
    expect(() => safeUpdateState(alwaysThrow, "s1", "work:paused")).not.toThrow();
  });
});
