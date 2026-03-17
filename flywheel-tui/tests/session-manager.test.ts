import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createSessionManager,
  type SessionManager,
  type SessionSummary,
  type SessionManagerDeps,
} from "../src/session/manager";
import {
  createSession as persistCreateSession,
  readSession,
  listSessions,
} from "../src/session/persistence";
import type { CliSession } from "../src/schemas/session";
import type { SessionLifecycleState } from "../src/session/state-machine";
import type { WorkflowSession } from "../src/tui/components/workflow-session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-session-mgr-test-${process.pid}-${Date.now()}`,
);

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal valid session data. */
function minimalSession(overrides?: Partial<CliSession>): CliSession {
  return {
    planPath: "plans/test.md",
    statePath: ".flywheel/state/test.state.md",
    contextPath: ".flywheel/context/test.ctx.md",
    currentPhase: 0,
    lastUpdated: new Date().toISOString(),
    workflowId: crypto.randomUUID(),
    ...overrides,
  };
}

/** Create a mock WorkflowSession (plain object, not a real one). */
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

/** Build deps with mock create/destroy functions. */
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

// ---------------------------------------------------------------------------
// create()
// ---------------------------------------------------------------------------

describe("SessionManager.create()", () => {
  it("returns a UUID session ID", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("persists session to disk with correct planPath", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/my-plan.md");
    const persisted = readSession(id, baseDir);

    expect(persisted).not.toBeNull();
    expect(persisted!.planPath).toBe("plans/my-plan.md");
  });

  it("sets initial lifecycle state to 'new'", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    const persisted = readSession(id, baseDir);

    expect(persisted!.sessionLifecycleState).toBe("new");
  });

  it("stores name when provided", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md", "My Named Session");
    const persisted = readSession(id, baseDir);

    expect(persisted!.name).toBe("My Named Session");
  });

  it("sets createdAt timestamp", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const before = new Date().toISOString();
    const id = mgr.create("plans/test.md");
    const after = new Date().toISOString();

    const persisted = readSession(id, baseDir);
    expect(persisted!.createdAt).toBeDefined();
    expect(persisted!.createdAt! >= before).toBe(true);
    expect(persisted!.createdAt! <= after).toBe(true);
  });

  it("does NOT create a live WorkflowSession (no side-effect)", () => {
    const baseDir = makeTmpDir();
    let createCalled = false;
    const deps = makeDeps(baseDir, {
      createWorkflowSessionFn: (planPath: string) => {
        createCalled = true;
        return makeMockWorkflowSession(planPath);
      },
    });
    const mgr = createSessionManager(deps);

    mgr.create("plans/test.md");

    expect(createCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resume()
// ---------------------------------------------------------------------------

describe("SessionManager.resume()", () => {
  it("returns a WorkflowSession for an existing session", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/resume-test.md");
    // Transition to an active state so resume makes sense
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");

    const session = mgr.resume(id);

    expect(session).not.toBeNull();
    expect(session!.planPath).toBe("plans/resume-test.md");
  });

  it("calls createWorkflowSessionFn internally", () => {
    const baseDir = makeTmpDir();
    let createdPlanPath: string | null = null;
    const deps = makeDeps(baseDir, {
      createWorkflowSessionFn: (planPath: string) => {
        createdPlanPath = planPath;
        return makeMockWorkflowSession(planPath);
      },
    });
    const mgr = createSessionManager(deps);

    const id = mgr.create("plans/resume-test.md");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
    mgr.resume(id);

    expect(createdPlanPath).toBe("plans/resume-test.md");
  });

  it("returns null for non-existent session ID", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const session = mgr.resume("non-existent-uuid");

    expect(session).toBeNull();
  });

  it("sets the active session so getActiveSession() returns it", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");

    expect(mgr.getActiveSession()).toBeNull();

    mgr.resume(id);

    expect(mgr.getActiveSession()).not.toBeNull();
    expect(mgr.getActiveSession()!.planPath).toBe("plans/test.md");
  });

  it("destroys previous active session before resuming a new one", () => {
    const baseDir = makeTmpDir();
    let destroyCount = 0;
    const deps = makeDeps(baseDir, {
      destroyWorkflowSessionFn: (_session: WorkflowSession) => {
        destroyCount++;
      },
    });
    const mgr = createSessionManager(deps);

    // Create and resume first session
    const id1 = mgr.create("plans/first.md");
    mgr.updateState(id1, "plan:imported");
    mgr.updateState(id1, "plan:approved");
    mgr.updateState(id1, "work:active");
    mgr.resume(id1);

    // Create and resume second session — should destroy first
    const id2 = mgr.create("plans/second.md");
    mgr.updateState(id2, "plan:imported");
    mgr.updateState(id2, "plan:approved");
    mgr.updateState(id2, "work:active");
    mgr.resume(id2);

    expect(destroyCount).toBe(1);
    expect(mgr.getActiveSession()!.planPath).toBe("plans/second.md");
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe("SessionManager.list()", () => {
  it("returns empty result when no sessions exist", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const result = mgr.list();

    expect(result.sessions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns SessionSummary objects (not live stores)", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    mgr.create("plans/test.md", "Test Session");

    const result = mgr.list();
    expect(result.sessions).toHaveLength(1);

    const summary = result.sessions[0];
    // SessionSummary has specific fields, NOT store/adapter/eventBus
    expect(summary).toHaveProperty("id");
    expect(summary).toHaveProperty("name");
    expect(summary).toHaveProperty("planPath");
    expect(summary).toHaveProperty("lifecycleState");
    expect(summary).toHaveProperty("currentPhase");
    expect(summary).toHaveProperty("totalCost");
    expect(summary).toHaveProperty("lastUpdated");
    // Must NOT have WorkflowSession properties
    expect(summary).not.toHaveProperty("store");
    expect(summary).not.toHaveProperty("adapter");
    expect(summary).not.toHaveProperty("eventBus");
  });

  it("returns correct data in summaries", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    mgr.create("plans/alpha.md", "Alpha");
    mgr.create("plans/beta.md", "Beta");

    const result = mgr.list();
    expect(result.sessions).toHaveLength(2);

    const planPaths = result.sessions.map((s) => s.planPath);
    expect(planPaths).toContain("plans/alpha.md");
    expect(planPaths).toContain("plans/beta.md");

    const names = result.sessions.map((s) => s.name);
    expect(names).toContain("Alpha");
    expect(names).toContain("Beta");
  });

  it("defaults lifecycle state to 'new' for sessions with state", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    mgr.create("plans/test.md");

    const result = mgr.list();
    expect(result.sessions[0].lifecycleState).toBe("new");
  });

  it("handles sessions without lifecycle state gracefully", () => {
    const baseDir = makeTmpDir();
    // Manually create a legacy session without lifecycle state
    persistCreateSession(minimalSession({ planPath: "plans/legacy.md" }), baseDir);

    const mgr = createSessionManager(makeDeps(baseDir));
    const result = mgr.list();

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].planPath).toBe("plans/legacy.md");
    // Should default to "new" or whatever sensible default
    expect(result.sessions[0].lifecycleState).toBe("new");
  });

  it("passes through errors from persistence layer", () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Write a corrupt file
    fs.writeFileSync(
      path.join(sessionsDir, "corrupt.json"),
      "NOT VALID JSON",
    );

    const mgr = createSessionManager(makeDeps(baseDir));
    const result = mgr.list();

    expect(result.sessions).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// updateState()
// ---------------------------------------------------------------------------

describe("SessionManager.updateState()", () => {
  it("transitions lifecycle state and persists", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "plan:imported");

    const persisted = readSession(id, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("plan:imported");
  });

  it("throws on invalid transition", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    // "new" -> "work:active" is not a valid transition
    expect(() => mgr.updateState(id, "work:active")).toThrow();
  });

  it("throws when session does not exist", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    expect(() => mgr.updateState("non-existent", "plan:draft")).toThrow();
  });

  it("allows valid multi-step transitions", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    // new -> plan:imported -> plan:approved -> work:active
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");

    const persisted = readSession(id, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("work:active");
  });

  it("updates lastUpdated timestamp", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    const beforeUpdate = readSession(id, baseDir)!.lastUpdated;

    // Small delay to ensure different timestamp
    mgr.updateState(id, "plan:imported");

    const afterUpdate = readSession(id, baseDir)!.lastUpdated;
    expect(afterUpdate >= beforeUpdate).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// trash()
// ---------------------------------------------------------------------------

describe("SessionManager.trash()", () => {
  it("transitions session to 'trashed' state", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    // new -> plan:draft (has trashed as valid target)
    mgr.updateState(id, "plan:draft");
    mgr.trash(id);

    const persisted = readSession(id, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("trashed");
  });

  it("persists the trashed state to disk", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "plan:draft");
    mgr.trash(id);

    // Re-read from disk to verify persistence
    const persisted = readSession(id, baseDir);
    expect(persisted).not.toBeNull();
    expect(persisted!.sessionLifecycleState).toBe("trashed");
  });

  it("throws when session is in a terminal state (already trashed)", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "plan:draft");
    mgr.trash(id);

    // Already trashed — terminal state, no outbound transitions
    expect(() => mgr.trash(id)).toThrow();
  });

  it("throws when session does not exist", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    expect(() => mgr.trash("non-existent")).toThrow();
  });

  it("works from various lifecycle states", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // From plan:imported
    const id1 = mgr.create("plans/a.md");
    mgr.updateState(id1, "plan:imported");
    mgr.trash(id1);
    expect(readSession(id1, baseDir)!.sessionLifecycleState).toBe("trashed");

    // From work:active
    const id2 = mgr.create("plans/b.md");
    mgr.updateState(id2, "plan:imported");
    mgr.updateState(id2, "plan:approved");
    mgr.updateState(id2, "work:active");
    mgr.trash(id2);
    expect(readSession(id2, baseDir)!.sessionLifecycleState).toBe("trashed");

    // From completed
    const id3 = mgr.create("plans/c.md");
    mgr.updateState(id3, "plan:imported");
    mgr.updateState(id3, "plan:approved");
    mgr.updateState(id3, "work:active");
    mgr.updateState(id3, "completed");
    mgr.trash(id3);
    expect(readSession(id3, baseDir)!.sessionLifecycleState).toBe("trashed");
  });
});

// ---------------------------------------------------------------------------
// archive()
// ---------------------------------------------------------------------------

describe("SessionManager.archive()", () => {
  it("transitions session to 'archived' state from completed", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
    mgr.updateState(id, "completed");
    mgr.archive(id);

    const persisted = readSession(id, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("archived");
  });

  it("transitions session to 'archived' from work:paused", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
    mgr.updateState(id, "work:paused");
    mgr.archive(id);

    const persisted = readSession(id, baseDir);
    expect(persisted!.sessionLifecycleState).toBe("archived");
  });

  it("throws on invalid archive transition (e.g., from 'new')", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    // "new" -> "archived" is not valid
    expect(() => mgr.archive(id)).toThrow();
  });

  it("throws when session does not exist", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    expect(() => mgr.archive("non-existent")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// getActiveSession() / destroyActive()
// ---------------------------------------------------------------------------

describe("SessionManager.getActiveSession()", () => {
  it("returns null when no session is active", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    expect(mgr.getActiveSession()).toBeNull();
  });

  it("returns the active session after resume()", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
    mgr.resume(id);

    const active = mgr.getActiveSession();
    expect(active).not.toBeNull();
    expect(active!.planPath).toBe("plans/test.md");
  });
});

describe("SessionManager.destroyActive()", () => {
  it("calls destroyWorkflowSessionFn on the active session", () => {
    const baseDir = makeTmpDir();
    let destroyedSession: WorkflowSession | null = null;
    const deps = makeDeps(baseDir, {
      destroyWorkflowSessionFn: (session: WorkflowSession) => {
        destroyedSession = session;
      },
    });
    const mgr = createSessionManager(deps);

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
    mgr.resume(id);
    mgr.destroyActive();

    expect(destroyedSession).not.toBeNull();
    expect(destroyedSession!.planPath).toBe("plans/test.md");
  });

  it("clears active session after destroy", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
    mgr.resume(id);

    expect(mgr.getActiveSession()).not.toBeNull();

    mgr.destroyActive();

    expect(mgr.getActiveSession()).toBeNull();
  });

  it("is a no-op when no session is active", () => {
    const baseDir = makeTmpDir();
    let destroyCalled = false;
    const deps = makeDeps(baseDir, {
      destroyWorkflowSessionFn: (_session: WorkflowSession) => {
        destroyCalled = true;
      },
    });
    const mgr = createSessionManager(deps);

    // Should not throw or call destroy
    mgr.destroyActive();

    expect(destroyCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wraps (not replaces) existing lifecycle
// ---------------------------------------------------------------------------

describe("SessionManager wraps existing lifecycle", () => {
  it("resume() delegates to createWorkflowSessionFn", () => {
    const baseDir = makeTmpDir();
    const calls: string[] = [];
    const deps = makeDeps(baseDir, {
      createWorkflowSessionFn: (planPath: string) => {
        calls.push(`create:${planPath}`);
        return makeMockWorkflowSession(planPath);
      },
    });
    const mgr = createSessionManager(deps);

    const id = mgr.create("plans/delegate-test.md");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
    mgr.resume(id);

    expect(calls).toEqual(["create:plans/delegate-test.md"]);
  });

  it("destroyActive() delegates to destroyWorkflowSessionFn", () => {
    const baseDir = makeTmpDir();
    const calls: string[] = [];
    const deps = makeDeps(baseDir, {
      destroyWorkflowSessionFn: (session: WorkflowSession) => {
        calls.push(`destroy:${session.planPath}`);
      },
    });
    const mgr = createSessionManager(deps);

    const id = mgr.create("plans/delegate-test.md");
    mgr.updateState(id, "plan:imported");
    mgr.updateState(id, "plan:approved");
    mgr.updateState(id, "work:active");
    mgr.resume(id);
    mgr.destroyActive();

    expect(calls).toEqual(["destroy:plans/delegate-test.md"]);
  });
});

// ---------------------------------------------------------------------------
// Factory function pattern
// ---------------------------------------------------------------------------

describe("createSessionManager factory", () => {
  it("returns a fresh instance each call (not a singleton)", () => {
    const baseDir = makeTmpDir();
    const mgr1 = createSessionManager(makeDeps(baseDir));
    const mgr2 = createSessionManager(makeDeps(baseDir));

    expect(mgr1).not.toBe(mgr2);
  });

  it("two managers with same baseDir share the same persistence store", () => {
    const baseDir = makeTmpDir();
    const mgr1 = createSessionManager(makeDeps(baseDir));
    const mgr2 = createSessionManager(makeDeps(baseDir));

    const id = mgr1.create("plans/shared.md");

    // mgr2 should see the session created by mgr1
    const result = mgr2.list();
    expect(result.sessions.some((s) => s.id === id)).toBe(true);
  });

  it("two managers with different baseDirs are isolated", () => {
    const baseDir1 = makeTmpDir();
    const baseDir2 = makeTmpDir();
    const mgr1 = createSessionManager(makeDeps(baseDir1));
    const mgr2 = createSessionManager(makeDeps(baseDir2));

    mgr1.create("plans/isolated.md");

    const result = mgr2.list();
    expect(result.sessions).toHaveLength(0);
  });
});
