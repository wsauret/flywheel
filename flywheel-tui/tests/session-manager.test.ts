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
import type { Session } from "../src/schemas/session";
import type { SessionLifecycleState } from "../src/session/state-machine";
import type { WorkflowSession } from "../src/tui/components/workflow-session";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../src/config/loader";

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
function minimalSession(overrides?: Partial<Session>): Session {
  return {
    label: "plans/test.md",
    planPath: "plans/test.md",
    lastUpdated: new Date().toISOString(),
    budgetLimits: { max_invocations: 0, max_tokens: null, wall_clock_deadline: null },
    budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0 },
    workflowType: "work",
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

  it("sets label from name when provided", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md", "My Named Session");
    const persisted = readSession(id, baseDir);

    expect(persisted!.label).toBe("My Named Session");
  });

  it("sets label from planPath when name not provided", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    const persisted = readSession(id, baseDir);

    expect(persisted!.label).toBe("plans/test.md");
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
    expect(summary).toHaveProperty("label");
    expect(summary).toHaveProperty("lifecycleState");
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

    const labels = result.sessions.map((s) => s.label);
    expect(labels).toContain("Alpha");
    expect(labels).toContain("Beta");

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
    persistCreateSession(minimalSession({ label: "plans/legacy.md", planPath: "plans/legacy.md" }), baseDir);

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

// ---------------------------------------------------------------------------
// Config injection + budget initialization (Step 3)
// ---------------------------------------------------------------------------

describe("SessionManager config injection", () => {
  it("accepts config in SessionManagerDeps", () => {
    const baseDir = makeTmpDir();
    const config: FlywheelConfig = {
      ...CONFIG_DEFAULTS,
      budget: { max_invocations: 10, max_tokens: 5000, max_wall_clock_minutes: 30 },
    };
    const mgr = createSessionManager(makeDeps(baseDir, { config }));

    // Should create without error
    const id = mgr.create("plans/test.md");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("uses default config when config is not provided in deps", () => {
    const baseDir = makeTmpDir();
    // No config in deps — should use CONFIG_DEFAULTS
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    const persisted = readSession(id, baseDir);

    // Default budget: all zeros → unlimited
    expect(persisted!.budgetLimits.max_invocations).toBe(0);
    expect(persisted!.budgetLimits.max_tokens).toBeNull();
    expect(persisted!.budgetLimits.wall_clock_deadline).toBeNull();
  });
});

describe("SessionManager.create() budget initialization from config", () => {
  it("populates budgetLimits from config.budget", () => {
    const baseDir = makeTmpDir();
    const config: FlywheelConfig = {
      ...CONFIG_DEFAULTS,
      budget: { max_invocations: 10, max_tokens: 50000, max_wall_clock_minutes: 45 },
    };
    const mgr = createSessionManager(makeDeps(baseDir, { config }));

    const before = Date.now();
    const id = mgr.create("plans/test.md");
    const after = Date.now();

    const persisted = readSession(id, baseDir);
    expect(persisted!.budgetLimits.max_invocations).toBe(10);
    expect(persisted!.budgetLimits.max_tokens).toBe(50000);

    // wall_clock_deadline should be ~45 minutes from now
    const deadline = new Date(persisted!.budgetLimits.wall_clock_deadline!).getTime();
    const expectedMin = before + 45 * 60_000;
    const expectedMax = after + 45 * 60_000;
    expect(deadline).toBeGreaterThanOrEqual(expectedMin);
    expect(deadline).toBeLessThanOrEqual(expectedMax);
  });

  it("maps config.budget with all zeros to unlimited budget (null sentinels)", () => {
    const baseDir = makeTmpDir();
    const config: FlywheelConfig = {
      ...CONFIG_DEFAULTS,
      budget: { max_invocations: 0, max_tokens: 0, max_wall_clock_minutes: 0 },
    };
    const mgr = createSessionManager(makeDeps(baseDir, { config }));

    const id = mgr.create("plans/test.md");
    const persisted = readSession(id, baseDir);

    // 0 means unlimited — max_invocations stays 0, others map to null
    expect(persisted!.budgetLimits.max_invocations).toBe(0);
    expect(persisted!.budgetLimits.max_tokens).toBeNull();
    expect(persisted!.budgetLimits.wall_clock_deadline).toBeNull();
  });

  it("initializes budgetUsage to zeros", () => {
    const baseDir = makeTmpDir();
    const config: FlywheelConfig = {
      ...CONFIG_DEFAULTS,
      budget: { max_invocations: 5, max_tokens: 10000, max_wall_clock_minutes: 10 },
    };
    const mgr = createSessionManager(makeDeps(baseDir, { config }));

    const id = mgr.create("plans/test.md");
    const persisted = readSession(id, baseDir);

    expect(persisted!.budgetUsage.invocations_used).toBe(0);
    expect(persisted!.budgetUsage.tokens_used).toBe(0);
    expect(persisted!.budgetUsage.cost_usd).toBe(0);
  });

  it("sets wall_clock_deadline based on config.budget.max_wall_clock_minutes", () => {
    const baseDir = makeTmpDir();
    const config: FlywheelConfig = {
      ...CONFIG_DEFAULTS,
      budget: { max_invocations: 0, max_tokens: 0, max_wall_clock_minutes: 60 },
    };
    const mgr = createSessionManager(makeDeps(baseDir, { config }));

    const before = Date.now();
    const id = mgr.create("plans/test.md");
    const after = Date.now();

    const persisted = readSession(id, baseDir);
    expect(persisted!.budgetLimits.wall_clock_deadline).not.toBeNull();

    const deadline = new Date(persisted!.budgetLimits.wall_clock_deadline!).getTime();
    expect(deadline).toBeGreaterThanOrEqual(before + 60 * 60_000);
    expect(deadline).toBeLessThanOrEqual(after + 60 * 60_000);
  });

  it("sets wall_clock_deadline to null when max_wall_clock_minutes is 0", () => {
    const baseDir = makeTmpDir();
    const config: FlywheelConfig = {
      ...CONFIG_DEFAULTS,
      budget: { max_invocations: 0, max_tokens: 0, max_wall_clock_minutes: 0 },
    };
    const mgr = createSessionManager(makeDeps(baseDir, { config }));

    const id = mgr.create("plans/test.md");
    const persisted = readSession(id, baseDir);

    expect(persisted!.budgetLimits.wall_clock_deadline).toBeNull();
  });
});

describe("SessionManager.create() workflowType parameter", () => {
  it("defaults workflowType to 'work' when not specified", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    const persisted = readSession(id, baseDir);

    expect(persisted!.workflowType).toBe("work");
  });

  it("sets workflowType to 'plan' when specified", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md", undefined, "plan");
    const persisted = readSession(id, baseDir);

    expect(persisted!.workflowType).toBe("plan");
  });

  it("sets workflowType to 'review' when specified", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md", "My Session", "review");
    const persisted = readSession(id, baseDir);

    expect(persisted!.workflowType).toBe("review");
  });

  it("sets workflowType to 'debug' when specified", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md", undefined, "debug");
    const persisted = readSession(id, baseDir);

    expect(persisted!.workflowType).toBe("debug");
  });
});
