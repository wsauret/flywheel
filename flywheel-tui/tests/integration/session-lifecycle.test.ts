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
import { readSession, deleteSessionWithCompanions } from "../../src/session/persistence";
import { isValidTransition, VALID_TRANSITIONS, type SessionLifecycleState } from "../../src/session/state-machine";
import type { WorkflowSession } from "../../src/tui/components/workflow-session";
import { createOutputPersistence } from "../../src/session/output-persistence";
import { createSessionOrchestrator, type SessionOrchestratorDeps } from "../../src/tui/components/session-orchestrator";
import { toSnapshot, fromSnapshot, type OutputSnapshot } from "../../src/schemas/output";

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

// ===========================================================================
// Phase 8.1: Pause / Resume Lifecycle Integration Tests
// ===========================================================================

describe("Pause / Resume Lifecycle", () => {
  // -------------------------------------------------------------------------
  // Helper: advance a session to work:active
  // -------------------------------------------------------------------------
  function advanceToActive(mgr: SessionManager, id: string): void {
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
  }

  // -------------------------------------------------------------------------
  // Helper: make sample output blocks
  // -------------------------------------------------------------------------
  function makeSampleBlocks(): Array<{ kind: string; [key: string]: unknown }> {
    return [
      { kind: "system", message: "Worker started", timestamp: Date.now() - 5000 },
      { kind: "text", content: "Analyzing codebase...", timestamp: Date.now() - 4000 },
      {
        kind: "tool",
        name: "Read",
        detail: "src/main.ts",
        timestamp: Date.now() - 3000,
      },
      { kind: "text", content: "Found 3 issues", timestamp: Date.now() - 2000 },
      {
        kind: "agent",
        id: "agent-1",
        agentLabel: "Analyzer",
        description: "Analyzing code",
        status: "completed",
        children: [],
        timestamp: Date.now() - 1000,
      },
    ];
  }

  it("full lifecycle: create -> work -> pause -> resume -> work -> complete -> archive", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Create and advance to work:active
    const id = mgr.create("plans/full-pause-resume.md", "Full PR Lifecycle");
    advanceToActive(mgr, id);
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:active");

    // Pause
    mgr.updateState(id, "work:paused");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:paused");

    // Resume
    mgr.updateState(id, "work:active");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:active");

    // Send to review (simulating "ship" pipeline stage)
    mgr.updateState(id, "work:review");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:review");

    // Complete
    mgr.updateState(id, "completed");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("completed");

    // Archive
    mgr.archive(id);
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("archived");
  });

  it("pause persists session state and output to disk", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/pause-persist.md", "Pause Persist");
    advanceToActive(mgr, id);

    // Save output blocks
    const persistence = createOutputPersistence({ sessionId: id, baseDir });
    const blocks = makeSampleBlocks();
    persistence.save(blocks);

    // Pause
    mgr.updateState(id, "work:paused");

    // Verify session state persisted
    const persisted = readSession(id, baseDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.sessionLifecycleState).toBe("work:paused");

    // Verify output file exists on disk
    const outputPath = path.join(baseDir, ".flywheel", "sessions", `${id}.output.json`);
    expect(fs.existsSync(outputPath)).toBe(true);

    // Verify output content is valid
    const raw = fs.readFileSync(outputPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThan(0);
  });

  it("resume loads output from disk and restores blocks", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/resume-load.md", "Resume Load");
    advanceToActive(mgr, id);

    // Save output blocks
    const persistence = createOutputPersistence({ sessionId: id, baseDir });
    const blocks = makeSampleBlocks();
    persistence.save(blocks);

    // Pause
    mgr.updateState(id, "work:paused");

    // Load output back (simulating resume)
    const loaded = await persistence.load();
    expect(loaded.length).toBeGreaterThan(0);

    // Verify the loaded blocks match what we saved
    // (toSnapshot may normalize some fields, so compare kinds)
    const savedKinds = blocks.map((b) => b.kind) as string[];
    const loadedKinds = loaded.map((b) => b.kind) as string[];
    expect(loadedKinds).toEqual(savedKinds);

    // Verify specific block content survived round-trip
    const textBlock = loaded.find((b) => b.kind === "text") as any;
    expect(textBlock).toBeDefined();
    expect(textBlock.content).toBe("Analyzing codebase...");

    const agentBlock = loaded.find((b) => b.kind === "agent") as any;
    expect(agentBlock).toBeDefined();
    expect(agentBlock.agentLabel).toBe("Analyzer");
  });

  it("resume after restart: session is still listed and resumable", () => {
    const baseDir = makeTmpDir();

    // Manager 1: create, work, pause
    const mgr1 = createSessionManager(makeDeps(baseDir));
    const id = mgr1.create("plans/restart-resume.md", "Restart Resume");
    advanceToActive(mgr1, id);

    // Save output before pausing
    const persistence = createOutputPersistence({ sessionId: id, baseDir });
    persistence.save(makeSampleBlocks());

    mgr1.updateState(id, "work:paused");

    // Manager 2: simulate app restart (new manager, same directory)
    const mgr2 = createSessionManager(makeDeps(baseDir));

    // Session is still visible
    const list = mgr2.list();
    const session = list.sessions.find((s) => s.id === id);
    expect(session).toBeDefined();
    expect(session!.lifecycleState).toBe("work:paused");
    expect(session!.name).toBe("Restart Resume");

    // Session can be resumed
    mgr2.updateState(id, "work:active");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:active");

    // Can resume via manager (creates live WorkflowSession)
    const workflowSession = mgr2.resume(id);
    expect(workflowSession).not.toBeNull();
    expect(workflowSession!.planPath).toBe("plans/restart-resume.md");
  });

  it("delete paused session cleans up all companion files", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/delete-paused.md", "Delete Paused");
    advanceToActive(mgr, id);

    // Save output
    const persistence = createOutputPersistence({ sessionId: id, baseDir });
    persistence.save(makeSampleBlocks());

    // Pause
    mgr.updateState(id, "work:paused");

    // Verify files exist before delete
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    const sessionJson = path.join(sessionsDir, `${id}.json`);
    const outputJson = path.join(sessionsDir, `${id}.output.json`);
    expect(fs.existsSync(sessionJson)).toBe(true);
    expect(fs.existsSync(outputJson)).toBe(true);

    // Trash and then delete with companions
    mgr.trash(id);
    const result = deleteSessionWithCompanions(id, baseDir);

    // Both files should be gone
    expect(fs.existsSync(sessionJson)).toBe(false);
    expect(fs.existsSync(outputJson)).toBe(false);
    expect(result.errors).toHaveLength(0);

    // Session should not appear in a fresh list
    const mgr2 = createSessionManager(makeDeps(baseDir));
    const list = mgr2.list();
    expect(list.sessions.find((s) => s.id === id)).toBeUndefined();
  });

  it("multiple pause/resume cycles on same session", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/multi-cycle.md", "Multi Cycle");
    advanceToActive(mgr, id);

    // Cycle 1: pause -> resume
    mgr.updateState(id, "work:paused");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:paused");
    mgr.updateState(id, "work:active");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:active");

    // Cycle 2: pause -> resume
    mgr.updateState(id, "work:paused");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:paused");
    mgr.updateState(id, "work:active");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:active");

    // Cycle 3: pause -> resume
    mgr.updateState(id, "work:paused");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:paused");
    mgr.updateState(id, "work:active");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:active");

    // Verify timestamps advance after each cycle
    const persisted = readSession(id, baseDir);
    expect(persisted).not.toBeNull();

    // Still in work:active after 3 cycles
    expect(persisted!.sessionLifecycleState).toBe("work:active");

    // Can still complete
    mgr.updateState(id, "completed");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("completed");
  });

  it("concurrent guard: only one active workflow session at a time", () => {
    const baseDir = makeTmpDir();
    const destroyedPaths: string[] = [];
    const deps = makeDeps(baseDir, {
      destroyWorkflowSessionFn: (session: WorkflowSession) => {
        destroyedPaths.push(session.planPath);
      },
    });
    const mgr = createSessionManager(deps);

    // Create three sessions, all in work:active
    const id1 = mgr.create("plans/one.md", "One");
    advanceToActive(mgr, id1);

    const id2 = mgr.create("plans/two.md", "Two");
    advanceToActive(mgr, id2);

    const id3 = mgr.create("plans/three.md", "Three");
    advanceToActive(mgr, id3);

    // Resume first — should be active, no destroy yet
    mgr.resume(id1);
    expect(mgr.getActiveSession()!.planPath).toBe("plans/one.md");
    expect(destroyedPaths).toHaveLength(0);

    // Resume second — should destroy first
    mgr.resume(id2);
    expect(mgr.getActiveSession()!.planPath).toBe("plans/two.md");
    expect(destroyedPaths).toEqual(["plans/one.md"]);

    // Resume third — should destroy second
    mgr.resume(id3);
    expect(mgr.getActiveSession()!.planPath).toBe("plans/three.md");
    expect(destroyedPaths).toEqual(["plans/one.md", "plans/two.md"]);

    // Destroy active — should destroy third
    mgr.destroyActive();
    expect(mgr.getActiveSession()).toBeNull();
    expect(destroyedPaths).toEqual(["plans/one.md", "plans/two.md", "plans/three.md"]);
  });
});

// ===========================================================================
// Phase 8.1: Auto-Archive Integration Tests
// ===========================================================================

describe("Auto-Archive via orchestrator", () => {
  it("auto-archives when ship stage completes", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/ship-archive.md", "Ship Archive");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");

    let listRefreshed = false;
    const orchestrator = createSessionOrchestrator({
      readSession: (sessionId) => readSession(sessionId, baseDir),
      createOutputPersistence: (sessionId) =>
        createOutputPersistence({ sessionId, baseDir }),
      fromSnapshot,
      manager: mgr,
      refreshList: () => { listRefreshed = true; },
    });

    // Simulate pipeline completion with ship stage
    await orchestrator.handleAutoArchive(id, [
      { workflow: "work", completed: true },
      { workflow: "review", completed: true },
      { workflow: "ship", completed: true },
    ]);

    // Should be archived
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("archived");
    expect(listRefreshed).toBe(true);
  });

  it("transitions to completed (not archived) when no ship stage", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/no-ship.md", "No Ship");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");

    const orchestrator = createSessionOrchestrator({
      readSession: (sessionId) => readSession(sessionId, baseDir),
      createOutputPersistence: (sessionId) =>
        createOutputPersistence({ sessionId, baseDir }),
      fromSnapshot,
      manager: mgr,
      refreshList: () => {},
    });

    // Simulate pipeline completion without ship stage
    await orchestrator.handleAutoArchive(id, [
      { workflow: "work", completed: true },
    ]);

    // Should be completed but NOT archived
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("completed");
  });
});

// ===========================================================================
// Phase 8.2: Crash Recovery
// ===========================================================================

describe("Crash recovery: stale work:active sessions", () => {
  it("stale work:active sessions transition to work:paused on startup recovery", () => {
    const baseDir = makeTmpDir();

    // Manager 1: create sessions in various states, then "crash" (discard manager)
    const mgr1 = createSessionManager(makeDeps(baseDir));

    // Session A: work:active (stale — no running pipeline)
    const idA = mgr1.create("plans/stale-a.md", "Stale A");
    mgr1.updateState(idA, "plan:imported");
    mgr1.updateState(idA, "plan:approved");
    mgr1.updateState(idA, "work:active");

    // Session B: also work:active (stale)
    const idB = mgr1.create("plans/stale-b.md", "Stale B");
    mgr1.updateState(idB, "plan:imported");
    mgr1.updateState(idB, "plan:approved");
    mgr1.updateState(idB, "work:active");

    // Session C: work:paused (not stale — already paused)
    const idC = mgr1.create("plans/paused-c.md", "Paused C");
    mgr1.updateState(idC, "plan:imported");
    mgr1.updateState(idC, "plan:approved");
    mgr1.updateState(idC, "work:active");
    mgr1.updateState(idC, "work:paused");

    // Session D: completed (not stale)
    const idD = mgr1.create("plans/done-d.md", "Done D");
    mgr1.updateState(idD, "plan:imported");
    mgr1.updateState(idD, "plan:approved");
    mgr1.updateState(idD, "work:active");
    mgr1.updateState(idD, "completed");

    // Manager 2: simulate restart — run crash recovery
    const mgr2 = createSessionManager(makeDeps(baseDir));
    const recovered = mgr2.recoverStaleSessions();

    // Stale sessions should have been recovered
    expect(recovered).toBe(2);

    // Verify A and B are now paused
    expect(readSession(idA, baseDir)!.sessionLifecycleState).toBe("work:paused");
    expect(readSession(idB, baseDir)!.sessionLifecycleState).toBe("work:paused");

    // C was already paused — unchanged
    expect(readSession(idC, baseDir)!.sessionLifecycleState).toBe("work:paused");

    // D was completed — unchanged
    expect(readSession(idD, baseDir)!.sessionLifecycleState).toBe("completed");
  });

  it("recovered sessions can be resumed after recovery", () => {
    const baseDir = makeTmpDir();

    // Create a stale work:active session
    const mgr1 = createSessionManager(makeDeps(baseDir));
    const id = mgr1.create("plans/recover-resume.md", "Recover Resume");
    mgr1.updateState(id, "plan:imported");
    mgr1.updateState(id, "plan:approved");
    mgr1.updateState(id, "work:active");

    // "Restart" and recover
    const mgr2 = createSessionManager(makeDeps(baseDir));
    mgr2.recoverStaleSessions();

    // Session should be paused now
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:paused");

    // Resume it
    mgr2.updateState(id, "work:active");
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:active");

    // Create live workflow session
    const session = mgr2.resume(id);
    expect(session).not.toBeNull();
    expect(session!.planPath).toBe("plans/recover-resume.md");
  });

  it("recovery is idempotent — running it twice does nothing extra", () => {
    const baseDir = makeTmpDir();

    const mgr1 = createSessionManager(makeDeps(baseDir));
    const id = mgr1.create("plans/idempotent.md", "Idempotent");
    mgr1.updateState(id, "plan:imported");
    mgr1.updateState(id, "plan:approved");
    mgr1.updateState(id, "work:active");

    // Recovery run 1
    const mgr2 = createSessionManager(makeDeps(baseDir));
    const recovered1 = mgr2.recoverStaleSessions();
    expect(recovered1).toBe(1);

    // Recovery run 2 — already paused, nothing to do
    const recovered2 = mgr2.recoverStaleSessions();
    expect(recovered2).toBe(0);

    // Still paused
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:paused");
  });
});

// ===========================================================================
// Phase 8.3: Edge Cases
// ===========================================================================

describe("Edge cases", () => {
  it("corrupt .state.md on resume: session still loads (graceful degradation)", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/corrupt-state.md", "Corrupt State");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");

    // Read session to get the statePath
    const session = readSession(id, baseDir);
    expect(session).not.toBeNull();

    // Write corrupt content to the state path
    const stateFullPath = path.resolve(baseDir, session!.statePath);
    fs.mkdirSync(path.dirname(stateFullPath), { recursive: true });
    fs.writeFileSync(stateFullPath, "<<<CORRUPT DATA>>>");

    // Pause and then resume — session itself should be readable
    mgr.updateState(id, "work:paused");
    mgr.updateState(id, "work:active");

    // Session is still valid and can be resumed
    const workflowSession = mgr.resume(id);
    expect(workflowSession).not.toBeNull();
    expect(workflowSession!.planPath).toBe("plans/corrupt-state.md");

    // Session still reflects correct state
    expect(readSession(id, baseDir)!.sessionLifecycleState).toBe("work:active");
  });

  it("resume with modified plan file: uses persisted session data", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Create plan file
    const planDir = path.join(baseDir, "plans");
    fs.mkdirSync(planDir, { recursive: true });
    const planPath = path.join(planDir, "modifiable.md");
    fs.writeFileSync(planPath, "# Original Plan\n\n- Phase 1: Setup\n- Phase 2: Build");

    const id = mgr.create("plans/modifiable.md", "Modifiable Plan");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");

    // Pause
    mgr.updateState(id, "work:paused");

    // Modify plan file on disk
    fs.writeFileSync(planPath, "# Modified Plan\n\n- Phase 1: NEW PHASE\n- Phase 2: Build\n- Phase 3: Test");

    // Resume — session data should reflect the original planPath
    mgr.updateState(id, "work:active");
    const persisted = readSession(id, baseDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.planPath).toBe("plans/modifiable.md");

    // The currentPhase from the session persisted data is still 0 (unchanged)
    expect(persisted!.currentPhase).toBe(0);

    // Session is still functional
    const workflowSession = mgr.resume(id);
    expect(workflowSession).not.toBeNull();
  });

  it("corrupt output file: load returns empty array gracefully", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/corrupt-output.md", "Corrupt Output");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");

    // Write corrupt output file
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.writeFileSync(path.join(sessionsDir, `${id}.output.json`), "NOT JSON{{{");

    // Load should return empty array, not throw
    const persistence = createOutputPersistence({ sessionId: id, baseDir });
    const loaded = await persistence.load();
    expect(loaded).toEqual([]);
  });

  it("missing output file: load returns empty array", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/missing-output.md", "Missing Output");

    // No output file written — load should return empty
    const persistence = createOutputPersistence({ sessionId: id, baseDir });
    const loaded = await persistence.load();
    expect(loaded).toEqual([]);
  });

  it("output with mixed valid/invalid blocks: invalid are filtered out", async () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const id = "test-mixed-output";
    const outputPath = path.join(sessionsDir, `${id}.output.json`);

    // Write output with valid and invalid blocks
    const mixedData = [
      { kind: "text", content: "valid block", timestamp: 1234 },
      { kind: "UNKNOWN_KIND", data: "invalid" },
      { kind: "system", message: "also valid", timestamp: 5678 },
      { kind: "text" }, // missing required fields
    ];
    fs.writeFileSync(outputPath, JSON.stringify(mixedData));

    const persistence = createOutputPersistence({ sessionId: id, baseDir });
    const loaded = await persistence.load();

    // Only the two valid blocks should survive
    expect(loaded).toHaveLength(2);
    expect(loaded[0].kind).toBe("text");
    expect(loaded[1].kind).toBe("system");
  });
});
