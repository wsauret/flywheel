import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createSessionManager,
  type SessionManager,
  type SessionSummary,
  type SessionManagerDeps,
} from "../src/orchestration/session/manager";
import {
  createSession as persistCreateSession,
  readSession,
  listSessions,
} from "../src/orchestration/session/persistence";
import type { Session } from "../src/orchestration/session/schemas";
import type { SessionState } from "../src/orchestration/session/state-machine";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../src/orchestration/config/loader";

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
    kind: "workflow" as const,
    command: "work" as const,
    ...overrides,
  };
}

/** Build deps with mock create/destroy functions. */
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

  it("sets initial lifecycle state to 'active'", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    const persisted = readSession(id, baseDir);

    expect(persisted!.state).toBe("active");
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

  it("populates state cache on create", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    expect(mgr.getState(id)).toBe("active");
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
    expect(summary).toHaveProperty("state");
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

  it("defaults lifecycle state to 'active' for new sessions", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    mgr.create("plans/test.md");

    const result = mgr.list();
    expect(result.sessions[0].state).toBe("active");
  });

  it("handles sessions without lifecycle state gracefully", () => {
    const baseDir = makeTmpDir();
    // Manually create a legacy session without lifecycle state
    persistCreateSession(minimalSession({ label: "plans/legacy.md", planPath: "plans/legacy.md" }), baseDir);

    const mgr = createSessionManager(makeDeps(baseDir));
    const result = mgr.list();

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].planPath).toBe("plans/legacy.md");
    // Should default to "active"
    expect(result.sessions[0].state).toBe("active");
  });

  it("passes through errors from persistence layer", () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");

    // Write a corrupt session directory (directory-per-session layout)
    const corruptDir = path.join(sessionsDir, "corrupt");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(
      path.join(corruptDir, "session.json"),
      "NOT VALID JSON",
    );

    const mgr = createSessionManager(makeDeps(baseDir));
    const result = mgr.list();

    expect(result.sessions).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("populates state cache on list", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");

    // Create a second manager to test cache population from disk
    const mgr2 = createSessionManager(makeDeps(baseDir));
    expect(mgr2.getState(id)).toBeNull(); // not in cache yet

    mgr2.list(); // populates cache
    expect(mgr2.getState(id)).toBe("active");
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
    mgr.updateState(id, "paused");

    const persisted = readSession(id, baseDir);
    expect(persisted!.state).toBe("paused");
  });

  it("throws on invalid transition", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "completed");

    // "completed" -> "active" is not a valid transition
    expect(() => mgr.updateState(id, "active")).toThrow();
  });

  it("throws when session does not exist", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    expect(() => mgr.updateState("non-existent", "paused")).toThrow();
  });

  it("allows valid pause/resume cycle", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    // active -> paused -> active
    mgr.updateState(id, "paused");
    mgr.updateState(id, "active");

    const persisted = readSession(id, baseDir);
    expect(persisted!.state).toBe("active");
  });

  it("updates lastUpdated timestamp", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    const beforeUpdate = readSession(id, baseDir)!.lastUpdated;

    // Small delay to ensure different timestamp
    mgr.updateState(id, "paused");

    const afterUpdate = readSession(id, baseDir)!.lastUpdated;
    expect(afterUpdate >= beforeUpdate).toBe(true);
  });

  it("updates state cache on updateState", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    expect(mgr.getState(id)).toBe("active");

    mgr.updateState(id, "paused");
    expect(mgr.getState(id)).toBe("paused");

    mgr.updateState(id, "active");
    expect(mgr.getState(id)).toBe("active");
  });
});

// ---------------------------------------------------------------------------
// delete()
// ---------------------------------------------------------------------------

describe("SessionManager.delete()", () => {
  it("removes session files from disk", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    expect(readSession(id, baseDir)).not.toBeNull();

    mgr.delete(id);

    expect(readSession(id, baseDir)).toBeNull();
  });

  it("removes session from cache", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    expect(mgr.getState(id)).toBe("active");

    mgr.delete(id);
    expect(mgr.getState(id)).toBeNull();
  });

  it("removes session from list", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    expect(mgr.list().sessions.find((s) => s.id === id)).toBeTruthy();

    mgr.delete(id);
    expect(mgr.list().sessions.find((s) => s.id === id)).toBeUndefined();
  });

  it("works from any lifecycle state", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // From active
    const id1 = mgr.create("plans/a.md");
    mgr.delete(id1);
    expect(readSession(id1, baseDir)).toBeNull();

    // From paused
    const id2 = mgr.create("plans/b.md");
    mgr.updateState(id2, "paused");
    mgr.delete(id2);
    expect(readSession(id2, baseDir)).toBeNull();

    // From completed
    const id3 = mgr.create("plans/c.md");
    mgr.updateState(id3, "completed");
    mgr.delete(id3);
    expect(readSession(id3, baseDir)).toBeNull();
  });

  it("does not throw for non-existent session (no files to delete)", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Should not throw — no files to delete, just a no-op
    expect(() => mgr.delete("non-existent")).not.toThrow();
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

// ---------------------------------------------------------------------------
// recoverStaleSessions()
// ---------------------------------------------------------------------------

describe("SessionManager.recoverStaleSessions()", () => {
  it("recovers active chat sessions to completed (no live runner)", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Create a chat session (starts as active)
    const id = mgr.create("plans/test.md", "Chat Session", "chat");

    // Verify it's active
    const before = readSession(id, baseDir);
    expect(before!.state).toBe("active");

    // Simulate startup recovery
    const recovered = mgr.recoverStaleSessions();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const after = readSession(id, baseDir);
    expect(after!.state).toBe("completed");
  });

  it("recovers active work sessions to paused", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Create a work session (starts as active)
    const id = mgr.create("plans/test.md", "Work Session");

    const recovered = mgr.recoverStaleSessions();
    expect(recovered).toBeGreaterThanOrEqual(1);

    const after = readSession(id, baseDir);
    expect(after!.state).toBe("paused");
  });

  it("recovers both chat and work active sessions in the same run", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Create chat session (active)
    const chatId = mgr.create("plans/chat.md", "Chat", "chat");

    // Create work session (active)
    const workId = mgr.create("plans/work.md", "Work");

    const recovered = mgr.recoverStaleSessions();
    expect(recovered).toBe(2);

    expect(readSession(chatId, baseDir)!.state).toBe("completed");
    expect(readSession(workId, baseDir)!.state).toBe("paused");
  });

  it("does not recover paused or completed sessions", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const pausedId = mgr.create("plans/paused.md", "Paused");
    mgr.updateState(pausedId, "paused");

    const completedId = mgr.create("plans/completed.md", "Completed");
    mgr.updateState(completedId, "completed");

    const recovered = mgr.recoverStaleSessions();
    expect(recovered).toBe(0);

    expect(readSession(pausedId, baseDir)!.state).toBe("paused");
    expect(readSession(completedId, baseDir)!.state).toBe("completed");
  });
});

describe("SessionManager.create() SessionKind parameter", () => {
  it("defaults kind to 'workflow' and command to 'work' when kind not specified", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    const persisted = readSession(id, baseDir);

    expect(persisted!.kind).toBe("workflow");
    expect(persisted!.command).toBe("work");
  });

  it("sets kind to 'workflow' and command to 'work' for workflow kind", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md", undefined, "workflow");
    const persisted = readSession(id, baseDir);

    expect(persisted!.kind).toBe("workflow");
    expect(persisted!.command).toBe("work");
  });

  it("sets kind to 'chat' and command to 'chat' for chat kind", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md", "My Session", "chat");
    const persisted = readSession(id, baseDir);

    expect(persisted!.kind).toBe("chat");
    expect(persisted!.command).toBe("chat");
  });
});

// ---------------------------------------------------------------------------
// getState() — state cache
// ---------------------------------------------------------------------------

describe("SessionManager.getState()", () => {
  it("returns null for unknown session", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    expect(mgr.getState("non-existent")).toBeNull();
  });

  it("returns cached state after create", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    expect(mgr.getState(id)).toBe("active");
  });

  it("reflects state changes after updateState", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    mgr.updateState(id, "paused");
    expect(mgr.getState(id)).toBe("paused");
  });
});
