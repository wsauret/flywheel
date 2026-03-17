/**
 * Integration tests for full session lifecycle.
 *
 * Exercises the SessionManager through complete multi-step lifecycles
 * using real persistence (temp directories) but mock workflow sessions.
 * Validates state transitions, persistence, list accuracy, and error
 * handling across the full state machine.
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createSessionManager,
  type SessionManager,
  type SessionManagerDeps,
} from "../../src/session/manager";
import { readSession } from "../../src/session/persistence";
import { isValidTransition, VALID_TRANSITIONS, type SessionLifecycleState } from "../../src/session/state-machine";
import type { WorkflowSession } from "../../src/tui/components/workflow-session";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-lifecycle-integ-${process.pid}-${Date.now()}`,
);

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeMockWorkflowSession(planPath: string): WorkflowSession {
  return {
    store: {} as WorkflowSession["store"],
    adapter: {
      stop: () => {},
      disconnect: () => {},
    } as WorkflowSession["adapter"],
    eventBus: {} as WorkflowSession["eventBus"],
    planPath,
  };
}

function makeDeps(
  baseDir: string,
  overrides?: Partial<SessionManagerDeps>,
): SessionManagerDeps {
  return {
    baseDir,
    createWorkflowSessionFn: (planPath: string) =>
      makeMockWorkflowSession(planPath),
    destroyWorkflowSessionFn: (_session: WorkflowSession) => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ===========================================================================
// Lifecycle 1: create -> import plan -> approve -> work -> review -> ship -> archive
// ===========================================================================

describe("Lifecycle: import -> approve -> work -> review -> complete -> archive", () => {
  it("traverses the full happy path and persists every state change", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Step 1: Create session
    const id = mgr.create("plans/feature-x.md", "Feature X");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    let persisted = readSession(id, baseDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.sessionLifecycleState).toBe("new");
    expect(persisted!.planPath).toBe("plans/feature-x.md");
    expect(persisted!.name).toBe("Feature X");

    // Step 2: Import plan (new -> plan:imported)
    mgr.updateState(id, "plan:imported");
    persisted = readSession(id, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("plan:imported");

    // Step 3: Approve plan (plan:imported -> plan:approved)
    mgr.updateState(id, "plan:approved");
    persisted = readSession(id, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("plan:approved");

    // Step 4: Start work (plan:approved -> work:active)
    mgr.updateState(id, "work:active");
    persisted = readSession(id, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("work:active");

    // Step 5: Send to review (work:active -> work:review)
    mgr.updateState(id, "work:review");
    persisted = readSession(id, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("work:review");

    // Step 6: Complete (work:review -> completed) — "ship"
    mgr.updateState(id, "completed");
    persisted = readSession(id, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("completed");

    // Step 7: Archive (completed -> archived)
    mgr.archive(id);
    persisted = readSession(id, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("archived");
  });

  it("sidebar list reflects each state change accurately", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/feature-x.md", "Feature X");

    // After creation, list shows "new"
    let list = mgr.list();
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0].lifecycleState).toBe("new");
    expect(list.sessions[0].name).toBe("Feature X");

    // Walk through transitions and verify list at each step
    const transitions: SessionLifecycleState[] = [
      "plan:imported",
      "plan:approved",
      "work:active",
      "work:review",
      "completed",
    ];

    for (const state of transitions) {
      mgr.updateState(id, state);
      list = mgr.list();
      const session = list.sessions.find((s) => s.id === id);
      expect(session).toBeDefined();
      expect(session!.lifecycleState).toBe(state);
    }

    // Archive
    mgr.archive(id);
    list = mgr.list();
    const archived = list.sessions.find((s) => s.id === id);
    expect(archived!.lifecycleState).toBe("archived");
  });

  it("archived is terminal — no further transitions allowed", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
    mgr.updateState(id, "completed");
    mgr.archive(id);

    // Archived is terminal
    expect(() => mgr.updateState(id, "work:active")).toThrow(
      /Invalid state transition.*archived/,
    );
    expect(() => mgr.trash(id)).toThrow(
      /Invalid state transition.*archived/,
    );
  });
});

// ===========================================================================
// Lifecycle 2: create -> draft -> approve -> work -> pause -> resume -> complete
// ===========================================================================

describe("Lifecycle: draft -> needs-fix -> approve -> work -> pause -> resume -> complete", () => {
  it("traverses the draft/revision path with pause and resume", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Step 1: Create session
    const id = mgr.create("plans/new-idea.md", "New Idea");

    // Step 2: Draft plan (new -> plan:draft)
    mgr.updateState(id, "plan:draft");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("plan:draft");

    // Step 3: Needs fix (plan:draft -> plan:needs-fix)
    mgr.updateState(id, "plan:needs-fix");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("plan:needs-fix");

    // Step 4: Re-import after fix (plan:needs-fix -> plan:imported)
    mgr.updateState(id, "plan:imported");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("plan:imported");

    // Step 5: Approve (plan:imported -> plan:approved)
    mgr.updateState(id, "plan:approved");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("plan:approved");

    // Step 6: Start work (plan:approved -> work:active)
    mgr.updateState(id, "work:active");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:active");

    // Step 7: Pause (work:active -> work:paused)
    mgr.updateState(id, "work:paused");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:paused");

    // Step 8: Resume (work:paused -> work:active)
    mgr.updateState(id, "work:active");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:active");

    // Step 9: Complete (work:active -> completed)
    mgr.updateState(id, "completed");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("completed");
  });

  it("sidebar reflects all intermediate states including pause/resume", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/new-idea.md", "New Idea");

    const steps: SessionLifecycleState[] = [
      "plan:draft",
      "plan:needs-fix",
      "plan:imported",
      "plan:approved",
      "work:active",
      "work:paused",
      "work:active",
      "completed",
    ];

    for (const state of steps) {
      mgr.updateState(id, state);
      const list = mgr.list();
      const session = list.sessions.find((s) => s.id === id);
      expect(session).toBeDefined();
      expect(session!.lifecycleState).toBe(state);
    }
  });
});

// ===========================================================================
// Multi-session lifecycle: sidebar tracks multiple sessions concurrently
// ===========================================================================

describe("Multi-session sidebar tracking", () => {
  it("tracks multiple sessions in different lifecycle stages simultaneously", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Session A: in progress
    const idA = mgr.create("plans/session-a.md", "Session A");
    mgr.updateState(idA, "plan:imported");
    mgr.updateState(idA, "plan:approved");
    mgr.updateState(idA, "work:active");

    // Session B: paused
    const idB = mgr.create("plans/session-b.md", "Session B");
    mgr.updateState(idB, "plan:imported");
    mgr.updateState(idB, "plan:approved");
    mgr.updateState(idB, "work:active");
    mgr.updateState(idB, "work:paused");

    // Session C: completed
    const idC = mgr.create("plans/session-c.md", "Session C");
    mgr.updateState(idC, "plan:imported");
    mgr.updateState(idC, "plan:approved");
    mgr.updateState(idC, "work:active");
    mgr.updateState(idC, "completed");

    // Session D: trashed
    const idD = mgr.create("plans/session-d.md", "Session D");
    mgr.updateState(idD, "plan:draft");
    mgr.trash(idD);

    // Verify all sessions visible in list
    const list = mgr.list();
    expect(list.sessions).toHaveLength(4);

    const byId = new Map(list.sessions.map((s) => [s.id, s]));
    expect(byId.get(idA)!.lifecycleState).toBe("work:active");
    expect(byId.get(idB)!.lifecycleState).toBe("work:paused");
    expect(byId.get(idC)!.lifecycleState).toBe("completed");
    expect(byId.get(idD)!.lifecycleState).toBe("trashed");

    // Verify names
    expect(byId.get(idA)!.name).toBe("Session A");
    expect(byId.get(idB)!.name).toBe("Session B");
    expect(byId.get(idC)!.name).toBe("Session C");
    expect(byId.get(idD)!.name).toBe("Session D");
  });

  it("mutating one session does not affect others", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id1 = mgr.create("plans/one.md", "One");
    const id2 = mgr.create("plans/two.md", "Two");

    mgr.updateState(id1, "plan:imported");
    mgr.updateState(id1, "plan:approved");
    mgr.updateState(id1, "work:active");

    // id2 should still be "new"
    const list = mgr.list();
    const s2 = list.sessions.find((s) => s.id === id2);
    expect(s2!.lifecycleState).toBe("new");
  });
});

// ===========================================================================
// Completed -> restart cycle
// ===========================================================================

describe("Completed -> restart (re-work) cycle", () => {
  it("allows completed -> work:active -> completed cycle", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/restart.md", "Restart Test");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
    mgr.updateState(id, "completed");

    // Re-open completed work
    mgr.updateState(id, "work:active");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:active");

    // Complete again
    mgr.updateState(id, "completed");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("completed");

    // Archive after second completion
    mgr.archive(id);
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("archived");
  });
});

// ===========================================================================
// Plan revision loop: needs-fix -> approved (direct bypass)
// ===========================================================================

describe("Plan revision loop", () => {
  it("allows plan:needs-fix -> plan:approved (direct fix-and-approve)", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/revision.md", "Revision Test");
    mgr.updateState(id, "plan:draft");
    mgr.updateState(id, "plan:needs-fix");

    // Direct approve from needs-fix (allowed by state machine)
    mgr.updateState(id, "plan:approved");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("plan:approved");
  });

  it("allows multiple needs-fix rounds before approval", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/multi-revision.md", "Multi Revision");
    mgr.updateState(id, "plan:draft");

    // Round 1: needs fix
    mgr.updateState(id, "plan:needs-fix");
    mgr.updateState(id, "plan:imported");

    // Round 2: still needs fix
    mgr.updateState(id, "plan:needs-fix");
    mgr.updateState(id, "plan:imported");

    // Finally approve
    mgr.updateState(id, "plan:approved");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("plan:approved");
  });
});

// ===========================================================================
// Trash from various states
// ===========================================================================

describe("Trash from any non-terminal state", () => {
  it("can trash from every non-terminal state except 'new'", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // States that support trash (everything except 'new', 'archived', 'trashed')
    // Note: 'new' does NOT have 'trashed' in its valid transitions
    const trashablePaths: Array<{ label: string; steps: SessionLifecycleState[] }> = [
      { label: "plan:draft", steps: ["plan:draft"] },
      { label: "plan:imported", steps: ["plan:imported"] },
      { label: "plan:approved", steps: ["plan:imported", "plan:approved"] },
      { label: "plan:needs-fix", steps: ["plan:draft", "plan:needs-fix"] },
      { label: "work:active", steps: ["plan:imported", "plan:approved", "work:active"] },
      { label: "work:paused", steps: ["plan:imported", "plan:approved", "work:active", "work:paused"] },
      { label: "work:review", steps: ["plan:imported", "plan:approved", "work:active", "work:review"] },
      { label: "completed", steps: ["plan:imported", "plan:approved", "work:active", "completed"] },
    ];

    for (const { label, steps } of trashablePaths) {
      const id = mgr.create(`plans/${label}.md`, label);
      for (const step of steps) {
        mgr.updateState(id, step);
      }
      mgr.trash(id);
      expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("trashed");
    }
  });

  it("trashed is terminal — no further transitions", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/trash-terminal.md");
    mgr.updateState(id, "plan:draft");
    mgr.trash(id);

    // No outbound transitions from trashed
    for (const state of [
      "new", "plan:draft", "plan:imported", "plan:approved",
      "plan:needs-fix", "work:active", "work:paused", "work:review",
      "completed", "archived",
    ] as SessionLifecycleState[]) {
      expect(() => mgr.updateState(id, state)).toThrow(
        /Invalid state transition/,
      );
    }
  });
});

// ===========================================================================
// Active session management through lifecycle
// ===========================================================================

describe("Active session management across lifecycle", () => {
  it("resume sets active, destroyActive clears it", () => {
    const baseDir = makeTmpDir();
    let destroyCount = 0;
    const deps = makeDeps(baseDir, {
      destroyWorkflowSessionFn: () => { destroyCount++; },
    });
    const mgr = createSessionManager(deps);

    const id = mgr.create("plans/active-test.md", "Active Test");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");

    // No active session initially
    expect(mgr.getActiveSession()).toBeNull();

    // Resume -> active
    mgr.resume(id);
    expect(mgr.getActiveSession()).not.toBeNull();
    expect(mgr.getActiveSession()!.planPath).toBe("plans/active-test.md");

    // Destroy -> cleared
    mgr.destroyActive();
    expect(mgr.getActiveSession()).toBeNull();
    expect(destroyCount).toBe(1);
  });

  it("switching active sessions destroys the previous one", () => {
    const baseDir = makeTmpDir();
    const destroyedPaths: string[] = [];
    const deps = makeDeps(baseDir, {
      destroyWorkflowSessionFn: (session: WorkflowSession) => {
        destroyedPaths.push(session.planPath);
      },
    });
    const mgr = createSessionManager(deps);

    // Create two sessions and move both to work:active
    const id1 = mgr.create("plans/first.md", "First");
    mgr.updateState(id1, "plan:imported");
    mgr.updateState(id1, "plan:approved");
    mgr.updateState(id1, "work:active");

    const id2 = mgr.create("plans/second.md", "Second");
    mgr.updateState(id2, "plan:imported");
    mgr.updateState(id2, "plan:approved");
    mgr.updateState(id2, "work:active");

    // Resume first
    mgr.resume(id1);
    expect(mgr.getActiveSession()!.planPath).toBe("plans/first.md");

    // Resume second — should destroy first
    mgr.resume(id2);
    expect(mgr.getActiveSession()!.planPath).toBe("plans/second.md");
    expect(destroyedPaths).toEqual(["plans/first.md"]);
  });
});

// ===========================================================================
// Invalid transitions are rejected
// ===========================================================================

describe("Invalid transitions are rejected", () => {
  it("rejects new -> work:active (skipping plan phases)", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/invalid.md");
    expect(() => mgr.updateState(id, "work:active")).toThrow(
      /Invalid state transition/,
    );
  });

  it("rejects plan:draft -> work:active", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/invalid.md");
    mgr.updateState(id, "plan:draft");
    expect(() => mgr.updateState(id, "work:active")).toThrow(
      /Invalid state transition/,
    );
  });

  it("rejects work:paused -> completed (must go through active first)", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/invalid.md");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
    mgr.updateState(id, "work:paused");

    expect(() => mgr.updateState(id, "completed")).toThrow(
      /Invalid state transition/,
    );
  });

  it("rejects new -> archived", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/invalid.md");
    expect(() => mgr.archive(id)).toThrow(/Invalid state transition/);
  });
});

// ===========================================================================
// Persistence integrity
// ===========================================================================

describe("Persistence integrity across lifecycle", () => {
  it("lastUpdated advances with every state change", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/timestamps.md");
    const timestamps: string[] = [];

    timestamps.push(readSession(id, baseDir)!.lastUpdated);

    const states: SessionLifecycleState[] = [
      "plan:imported",
      "plan:approved",
      "work:active",
      "completed",
    ];

    for (const state of states) {
      mgr.updateState(id, state);
      timestamps.push(readSession(id, baseDir)!.lastUpdated);
    }

    // Each timestamp should be >= the previous one
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] >= timestamps[i - 1]).toBe(true);
    }
  });

  it("session data survives manager recreation (new manager reads same dir)", () => {
    const baseDir = makeTmpDir();

    // Manager 1: create and advance session
    const mgr1 = createSessionManager(makeDeps(baseDir));
    const id = mgr1.create("plans/survive.md", "Survivor");
    mgr1.updateState(id, "plan:imported");
    mgr1.updateState(id, "plan:approved");
    mgr1.updateState(id, "work:active");

    // Manager 2: should see session in work:active
    const mgr2 = createSessionManager(makeDeps(baseDir));
    const list = mgr2.list();
    const session = list.sessions.find((s) => s.id === id);

    expect(session).toBeDefined();
    expect(session!.lifecycleState).toBe("work:active");
    expect(session!.name).toBe("Survivor");

    // Manager 2 can continue advancing state
    mgr2.updateState(id, "completed");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("completed");
  });

  it("all fields round-trip through create -> list", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/roundtrip.md", "Round Trip");

    const list = mgr.list();
    const session = list.sessions.find((s) => s.id === id);

    expect(session).toBeDefined();
    expect(session!.id).toBe(id);
    expect(session!.name).toBe("Round Trip");
    expect(session!.planPath).toBe("plans/roundtrip.md");
    expect(session!.lifecycleState).toBe("new");
    expect(session!.currentPhase).toBe(0);
    expect(session!.totalCost).toBe(0);
    expect(session!.lastUpdated).toBeDefined();
    expect(session!.createdAt).toBeDefined();
  });
});

// ===========================================================================
// State machine exhaustiveness
// ===========================================================================

describe("State machine transition table exhaustiveness", () => {
  it("every non-terminal state has at least one outbound transition", () => {
    const nonTerminal: SessionLifecycleState[] = [
      "new", "plan:draft", "plan:imported", "plan:approved",
      "plan:needs-fix", "work:active", "work:paused", "work:review",
      "completed",
    ];

    for (const state of nonTerminal) {
      expect(VALID_TRANSITIONS[state].length).toBeGreaterThan(0);
    }
  });

  it("terminal states have no outbound transitions", () => {
    expect(VALID_TRANSITIONS["archived"]).toHaveLength(0);
    expect(VALID_TRANSITIONS["trashed"]).toHaveLength(0);
  });

  it("every listed transition target is a valid state", () => {
    const allStates = Object.keys(VALID_TRANSITIONS) as SessionLifecycleState[];

    for (const from of allStates) {
      for (const to of VALID_TRANSITIONS[from]) {
        expect(allStates).toContain(to);
        expect(isValidTransition(from, to)).toBe(true);
      }
    }
  });

  it("non-listed transitions are rejected", () => {
    // Spot-check some known-invalid transitions
    expect(isValidTransition("new", "work:active")).toBe(false);
    expect(isValidTransition("new", "completed")).toBe(false);
    expect(isValidTransition("archived", "new")).toBe(false);
    expect(isValidTransition("trashed", "new")).toBe(false);
    expect(isValidTransition("work:paused", "completed")).toBe(false);
    expect(isValidTransition("plan:approved", "plan:draft")).toBe(false);
  });
});

// ===========================================================================
// Error handling
// ===========================================================================

describe("Error handling in lifecycle operations", () => {
  it("updateState on nonexistent session throws", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    expect(() => mgr.updateState("nonexistent-id", "plan:draft")).toThrow(
      /Session not found/,
    );
  });

  it("trash on nonexistent session throws", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    expect(() => mgr.trash("nonexistent-id")).toThrow(/Session not found/);
  });

  it("archive on nonexistent session throws", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    expect(() => mgr.archive("nonexistent-id")).toThrow(/Session not found/);
  });

  it("resume on nonexistent session returns null", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const result = mgr.resume("nonexistent-id");
    expect(result).toBeNull();
  });

  it("list handles corrupt session files gracefully", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Create a valid session
    const validId = mgr.create("plans/valid.md", "Valid");

    // Write a corrupt session file
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.writeFileSync(
      path.join(sessionsDir, "corrupt-id.json"),
      "NOT VALID JSON",
    );

    // List should return the valid session and report the error
    const result = mgr.list();
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe(validId);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
