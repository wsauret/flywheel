/**
 * Integration tests for full session lifecycle (3-state model).
 *
 * Exercises the SessionManager through complete lifecycles using real
 * persistence (temp directories). Validates state transitions, persistence,
 * list accuracy, and error handling across the 3-state machine:
 *   active -> paused -> active (resume)
 *   active -> completed (finish)
 *   paused -> active (resume)
 *   completed is terminal
 */

import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createSessionManager,
  type SessionManager,
  type SessionManagerDeps,
} from "../src/orchestration/session/manager";
import { readSession } from "../src/orchestration/session/persistence";
import { isValidTransition, VALID_TRANSITIONS, type SessionState } from "../src/orchestration/session/state-machine";
import { createOutputPersistence } from "../src/orchestration/session/output-persistence";
import { fromSnapshot, type OutputSnapshot } from "../src/orchestration/session/output-schemas";

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

function makeDeps(
  baseDir: string,
  overrides?: Partial<SessionManagerDeps>,
): SessionManagerDeps {
  return {
    baseDir,
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
// Lifecycle 1: create -> pause -> resume -> complete
// ===========================================================================

describe("Lifecycle: create -> pause -> resume -> complete", () => {
  it("traverses the full happy path and persists every state change", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Step 1: Create session (starts as active)
    const id = mgr.create("plans/feature-x.md", "Feature X");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    let persisted = readSession(id, baseDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.state).toBe("active");
    expect(persisted!.planPath).toBe("plans/feature-x.md");
    expect(persisted!.name).toBe("Feature X");

    // Step 2: Pause (active -> paused)
    mgr.updateState(id, "paused");
    persisted = readSession(id, baseDir);
    expect(persisted!.state).toBe("paused");

    // Step 3: Resume (paused -> active)
    mgr.updateState(id, "active");
    persisted = readSession(id, baseDir);
    expect(persisted!.state).toBe("active");

    // Step 4: Complete (active -> completed)
    mgr.updateState(id, "completed");
    persisted = readSession(id, baseDir);
    expect(persisted!.state).toBe("completed");
  });

  it("sidebar list reflects each state change accurately", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/feature-x.md", "Feature X");

    // After creation, list shows "active"
    let list = mgr.list();
    expect(list.sessions).toHaveLength(1);
    expect(list.sessions[0].state).toBe("active");
    expect(list.sessions[0].name).toBe("Feature X");

    // Walk through transitions and verify list at each step
    const transitions: SessionState[] = ["paused", "active", "completed"];

    for (const state of transitions) {
      mgr.updateState(id, state);
      list = mgr.list();
      const session = list.sessions.find((s) => s.id === id);
      expect(session).toBeDefined();
      expect(session!.state).toBe(state);
    }
  });

  it("completed is terminal -- no further transitions allowed", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "completed");

    // Completed allows no transitions
    expect(() => mgr.updateState(id, "active")).toThrow(
      /Invalid state transition.*completed/,
    );
    expect(() => mgr.updateState(id, "paused")).toThrow(
      /Invalid state transition.*completed/,
    );
  });
});

// ===========================================================================
// Lifecycle 2: create -> pause -> resume cycle -> complete
// ===========================================================================

describe("Lifecycle: multiple pause/resume cycles", () => {
  it("supports repeated pause and resume cycles", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/new-idea.md", "New Idea");

    // Pause/resume cycle 1
    mgr.updateState(id, "paused");
    expect(readSession(id, baseDir)!.state).toBe("paused");
    mgr.updateState(id, "active");
    expect(readSession(id, baseDir)!.state).toBe("active");

    // Pause/resume cycle 2
    mgr.updateState(id, "paused");
    expect(readSession(id, baseDir)!.state).toBe("paused");
    mgr.updateState(id, "active");
    expect(readSession(id, baseDir)!.state).toBe("active");

    // Pause/resume cycle 3
    mgr.updateState(id, "paused");
    expect(readSession(id, baseDir)!.state).toBe("paused");
    mgr.updateState(id, "active");
    expect(readSession(id, baseDir)!.state).toBe("active");

    // Finally complete
    mgr.updateState(id, "completed");
    persisted();
    function persisted() {
      expect(readSession(id, baseDir)!.state).toBe("completed");
    }
  });

  it("lastUpdated moves forward on each state change", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    let prevUpdated = readSession(id, baseDir)!.lastUpdated;

    mgr.updateState(id, "paused");
    let updated = readSession(id, baseDir)!.lastUpdated;
    expect(updated >= prevUpdated).toBe(true);
    prevUpdated = updated;

    mgr.updateState(id, "active");
    updated = readSession(id, baseDir)!.lastUpdated;
    expect(updated >= prevUpdated).toBe(true);
  });
});

// ===========================================================================
// Error handling: invalid transitions
// ===========================================================================

describe("Invalid transitions are rejected", () => {
  it("completed -> active is rejected", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "completed");

    expect(() => mgr.updateState(id, "active")).toThrow(
      /Invalid state transition/,
    );
  });

  it("completed -> paused is rejected", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "completed");

    expect(() => mgr.updateState(id, "paused")).toThrow(
      /Invalid state transition/,
    );
  });

  it("paused -> completed is rejected (must go through active)", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "paused");

    expect(() => mgr.updateState(id, "completed")).toThrow(
      /Invalid state transition/,
    );
  });

  it("self-transitions are rejected", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");

    expect(() => mgr.updateState(id, "active")).toThrow(
      /Invalid state transition/,
    );
  });

  it("non-existent session throws", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    expect(() => mgr.updateState("nonexistent-id", "paused")).toThrow(
      /Session not found/,
    );
  });
});

// ===========================================================================
// Multi-session lifecycle
// ===========================================================================

describe("Multi-session lifecycle", () => {
  it("multiple sessions in different states coexist", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Create sessions in different states
    const idA = mgr.create("plans/a.md", "A");
    // A stays active

    const idB = mgr.create("plans/b.md", "B");
    mgr.updateState(idB, "paused");

    const idC = mgr.create("plans/c.md", "C");
    mgr.updateState(idC, "completed");

    const idD = mgr.create("plans/d.md", "D");
    // D stays active

    const { sessions } = mgr.list();
    expect(sessions).toHaveLength(4);

    const byId = new Map(sessions.map((s) => [s.id, s]));
    expect(byId.get(idA)!.state).toBe("active");
    expect(byId.get(idB)!.state).toBe("paused");
    expect(byId.get(idC)!.state).toBe("completed");
    expect(byId.get(idD)!.state).toBe("active");
  });

  it("operations on one session don't affect others", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id1 = mgr.create("plans/x.md", "X");
    const id2 = mgr.create("plans/y.md", "Y");

    mgr.updateState(id1, "paused");

    // id2 should still be active
    expect(readSession(id2, baseDir)!.state).toBe("active");
    expect(readSession(id1, baseDir)!.state).toBe("paused");
  });
});

// ===========================================================================
// Pause/resume persists correctly
// ===========================================================================

describe("Pause/resume persistence", () => {
  it("paused state persists across manager instances", () => {
    const baseDir = makeTmpDir();
    const mgr1 = createSessionManager(makeDeps(baseDir));

    const id = mgr1.create("plans/persist.md", "Persist Test");
    mgr1.updateState(id, "paused");

    // Create a new manager to read from disk
    const mgr2 = createSessionManager(makeDeps(baseDir));
    const { sessions } = mgr2.list();

    const session = sessions.find((s) => s.id === id);
    expect(session).toBeDefined();
    expect(session!.state).toBe("paused");
  });

  it("resume works across manager instances", () => {
    const baseDir = makeTmpDir();
    const mgr1 = createSessionManager(makeDeps(baseDir));

    const id = mgr1.create("plans/test.md");
    mgr1.updateState(id, "paused");

    // Resume from a different manager instance
    const mgr2 = createSessionManager(makeDeps(baseDir));
    mgr2.updateState(id, "active");
    expect(readSession(id, baseDir)!.state).toBe("active");
  });
});

// ===========================================================================
// Stale session recovery
// ===========================================================================

describe("Stale session recovery", () => {
  it("recovers stale active work sessions to paused", () => {
    const baseDir = makeTmpDir();
    const mgr1 = createSessionManager(makeDeps(baseDir));

    // Create multiple work sessions (all start as active)
    const idA = mgr1.create("plans/a.md", "A");
    const idB = mgr1.create("plans/b.md", "B");
    const idC = mgr1.create("plans/c.md", "C");
    mgr1.updateState(idC, "paused");

    // Simulate restart with fresh manager
    const mgr2 = createSessionManager(makeDeps(baseDir));
    const recovered = mgr2.recoverStaleSessions();

    // A and B should be recovered (active -> paused)
    // C is already paused, should not be recovered
    expect(recovered).toBe(2);

    expect(readSession(idA, baseDir)!.state).toBe("paused");
    expect(readSession(idB, baseDir)!.state).toBe("paused");
    expect(readSession(idC, baseDir)!.state).toBe("paused");
  });

  it("recovers active chat sessions to completed", () => {
    const baseDir = makeTmpDir();
    const mgr1 = createSessionManager(makeDeps(baseDir));

    const id = mgr1.create("chat", "Chat Session", "chat");

    // Simulate restart
    const mgr2 = createSessionManager(makeDeps(baseDir));
    const recovered = mgr2.recoverStaleSessions();
    expect(recovered).toBe(1);

    expect(readSession(id, baseDir)!.state).toBe("completed");
  });

  it("recovery then resume works end-to-end", () => {
    const baseDir = makeTmpDir();
    const mgr1 = createSessionManager(makeDeps(baseDir));

    const id = mgr1.create("plans/test.md");

    // Simulate restart + recovery
    const mgr2 = createSessionManager(makeDeps(baseDir));
    mgr2.recoverStaleSessions();
    expect(readSession(id, baseDir)!.state).toBe("paused");

    // Resume
    mgr2.updateState(id, "active");
    expect(readSession(id, baseDir)!.state).toBe("active");
  });

  it("ignores non-active sessions during recovery", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "completed");

    const recovered = mgr.recoverStaleSessions();
    expect(recovered).toBe(0);
    expect(readSession(id, baseDir)!.state).toBe("completed");
  });
});

// ===========================================================================
// Output persistence integration
// ===========================================================================

describe("Output persistence integration", () => {
  it("persists and restores output blocks for a session", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");

    // Persist output blocks
    const persistence = createOutputPersistence({ sessionId: id, baseDir });
    const blocks: OutputSnapshot[] = [
      { kind: "text", content: "Hello from test", timestamp: Date.now() },
      { kind: "system", message: "Step completed", timestamp: Date.now() },
    ];
    persistence.save(blocks);

    // Pause the session
    mgr.updateState(id, "paused");

    // Restore via a fresh persistence reader
    const persistence2 = createOutputPersistence({ sessionId: id, baseDir });
    const loaded = fromSnapshot(await persistence2.load());
    expect(loaded).toHaveLength(2);
    expect(loaded[0].kind).toBe("text");
    expect(loaded[1].kind).toBe("system");
  });
});

// ===========================================================================
// Transition table validation
// ===========================================================================

describe("Transition table validation", () => {
  it("VALID_TRANSITIONS covers all 3 states", () => {
    const allStates: SessionState[] = ["active", "paused", "completed"];
    for (const state of allStates) {
      expect(VALID_TRANSITIONS).toHaveProperty(state);
    }
  });

  it("isValidTransition agrees with VALID_TRANSITIONS for all pairs", () => {
    const allStates: SessionState[] = ["active", "paused", "completed"];
    for (const from of allStates) {
      for (const to of allStates) {
        const expected = (VALID_TRANSITIONS[from] as readonly string[]).includes(to);
        expect(isValidTransition(from, to)).toBe(expected);
      }
    }
  });

  it("completed is fully terminal (no outbound transitions)", () => {
    expect(VALID_TRANSITIONS["completed"]).toEqual([]);
  });
});

// ===========================================================================
// Deletion
// ===========================================================================

describe("Session deletion", () => {
  it("can delete an active session", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.delete(id);

    expect(readSession(id, baseDir)).toBeNull();
    const { sessions } = mgr.list();
    expect(sessions.find((s) => s.id === id)).toBeUndefined();
  });

  it("can delete a paused session", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "paused");
    mgr.delete(id);

    expect(readSession(id, baseDir)).toBeNull();
  });

  it("can delete a completed session", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "completed");
    mgr.delete(id);

    expect(readSession(id, baseDir)).toBeNull();
  });
});
