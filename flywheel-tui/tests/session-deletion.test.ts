import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createSession,
  readSession,
  updateSession,
  deleteSessionWithCompanions,
  listSessions,
  type DeleteResult,
} from "../src/orchestration/session/persistence";
import type { Session } from "../src/orchestration/session/schemas";
import {
  createSessionManager,
  type SessionManagerDeps,
} from "../src/orchestration/session/manager";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-deletion-test-${process.pid}-${Date.now()}`,
);

/** Create an isolated tmp dir for a single test. */
function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal valid session data (required fields only). */
function minimalSession(overrides?: Partial<Session>): Session {
  return {
    label: "plans/test.md",
    planPath: "plans/test.md",
    worktreePath: "/tmp/worktrees/test",
    lastUpdated: new Date().toISOString(),
    budgetLimits: { max_invocations: 0, max_tokens: null, wall_clock_deadline: null },
    budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0 },
    kind: "workflow" as const,
    command: "work" as const,
    ...overrides,
  };
}

/**
 * Create a session with all companion files on disk.
 * Returns { id, baseDir, sessionDir, outputPath, jsonPath }.
 *
 * Uses the new directory-per-session layout:
 *   .flywheel/sessions/<id>/session.json
 *   .flywheel/sessions/<id>/output.json
 */
function createSessionWithCompanions(baseDir: string, overrides?: Partial<Session>) {
  const data = minimalSession({
    ...overrides,
  });

  const id = createSession(data, baseDir);

  // Session directory already created by createSession
  const sessionDir = path.join(baseDir, ".flywheel/sessions", id);

  // Create the output file using new directory-per-session path
  const outputPath = path.join(sessionDir, "output.json");
  fs.writeFileSync(outputPath, JSON.stringify([]));

  const jsonPath = path.join(sessionDir, "session.json");

  return {
    id,
    baseDir,
    sessionDir,
    outputPath,
    jsonPath,
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
// deleteSessionWithCompanions
// ---------------------------------------------------------------------------

describe("deleteSessionWithCompanions", () => {
  it("deletes session directory with all files", () => {
    const baseDir = makeTmpDir();
    const { id, sessionDir, outputPath, jsonPath } =
      createSessionWithCompanions(baseDir);

    // Verify all files exist before deletion
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);

    const result = deleteSessionWithCompanions(id, baseDir);

    // All files should be gone (entire directory removed)
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(sessionDir)).toBe(false);

    // Directory path should be in the deleted list
    expect(result.deleted.length).toBe(1);
    expect(result.deleted[0]).toContain(id);
    expect(result.errors).toHaveLength(0);
  });

  it("returns { deleted, errors } for partial failure reporting", () => {
    const baseDir = makeTmpDir();
    const { id } = createSessionWithCompanions(baseDir);

    const result = deleteSessionWithCompanions(id, baseDir);

    expect(result).toHaveProperty("deleted");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.deleted)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });

  it("deletes entire session directory including output", () => {
    const baseDir = makeTmpDir();
    const { id, outputPath } = createSessionWithCompanions(baseDir);

    const result = deleteSessionWithCompanions(id, baseDir);

    // The output file should be deleted as part of the directory removal
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(result.deleted.length).toBe(1);
  });

  it("deletes directory even with corrupt session.json", () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel/sessions");
    const id = crypto.randomUUID();
    const sessionDir = path.join(sessionsDir, id);
    fs.mkdirSync(sessionDir, { recursive: true });

    // Create a corrupt session.json
    fs.writeFileSync(path.join(sessionDir, "session.json"), "NOT VALID JSON {{{");

    // Also create an output file
    fs.writeFileSync(path.join(sessionDir, "output.json"), JSON.stringify([]));

    const result = deleteSessionWithCompanions(id, baseDir);

    // Entire directory should be deleted
    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(result.deleted.length).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("reports errors for directories that fail to delete", () => {
    const baseDir = makeTmpDir();
    const { id, sessionDir } =
      createSessionWithCompanions(baseDir);

    // Make parent directory read-only to cause delete failure
    const sessionsDir = path.dirname(sessionDir);
    fs.chmodSync(sessionsDir, 0o555);

    try {
      const result = deleteSessionWithCompanions(id, baseDir);

      // Deletion should have failed
      expect(result.errors.length).toBeGreaterThan(0);
    } finally {
      // Restore permissions so cleanup works
      fs.chmodSync(sessionsDir, 0o755);
    }
  });

  it("returns error if session ID matches active session", () => {
    const baseDir = makeTmpDir();
    const { id } = createSessionWithCompanions(baseDir);

    const result = deleteSessionWithCompanions(id, baseDir, id);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Cannot delete the currently active session");
    expect(result.deleted).toHaveLength(0);

    // Files should still exist
    const session = readSession(id, baseDir);
    expect(session).not.toBeNull();
  });

  it("handles session without companion files (still deletes directory)", () => {
    const baseDir = makeTmpDir();
    // Create session without output file on disk
    const data = minimalSession();
    const id = createSession(data, baseDir);

    const result = deleteSessionWithCompanions(id, baseDir);

    // Should still succeed — directory was deleted
    expect(result.errors).toHaveLength(0);
    expect(result.deleted.length).toBe(1);
    expect(result.deleted[0]).toContain(id);

    // Session should be gone
    expect(readSession(id, baseDir)).toBeNull();
  });

  it("handles session that does not exist at all", () => {
    const baseDir = makeTmpDir();
    const fakeId = crypto.randomUUID();

    const result = deleteSessionWithCompanions(fakeId, baseDir);

    // No directory to delete, no errors (just nothing happened)
    expect(result.deleted).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SessionManager.delete()
// ---------------------------------------------------------------------------

describe("SessionManager.delete()", () => {
  /** Build deps for SessionManager. */
  function makeDeps(
    baseDir: string,
    overrides?: Partial<SessionManagerDeps>,
  ): SessionManagerDeps {
    return {
      baseDir,
      ...overrides,
    };
  }

  it("deletes session files from disk immediately", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");

    // Verify session exists before deletion
    expect(readSession(id, baseDir)).not.toBeNull();

    mgr.delete(id);

    // Session should be gone from disk
    expect(readSession(id, baseDir)).toBeNull();
  });

  it("removes session from list after delete", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = mgr.create("plans/test.md");
    expect(mgr.list().sessions.find(s => s.id === id)?.state).toBe("active");

    mgr.delete(id);
    expect(mgr.list().sessions.find(s => s.id === id)).toBeUndefined();
  });

  it("does not affect other sessions", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id1 = mgr.create("plans/keep.md");
    const id2 = mgr.create("plans/delete-me.md");

    mgr.delete(id2);

    // Kept session should still exist
    expect(readSession(id1, baseDir)).not.toBeNull();
    // Deleted session should be gone
    expect(readSession(id2, baseDir)).toBeNull();

    const { sessions } = mgr.list();
    expect(sessions.find((s) => s.id === id1)).toBeTruthy();
    expect(sessions.find((s) => s.id === id2)).toBeUndefined();
  });

  it("can delete sessions in any lifecycle state", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Active
    const id1 = mgr.create("plans/a.md");
    mgr.delete(id1);
    expect(readSession(id1, baseDir)).toBeNull();

    // Paused
    const id2 = mgr.create("plans/b.md");
    mgr.updateState(id2, "paused");
    mgr.delete(id2);
    expect(readSession(id2, baseDir)).toBeNull();

    // Completed
    const id3 = mgr.create("plans/c.md");
    mgr.updateState(id3, "completed");
    mgr.delete(id3);
    expect(readSession(id3, baseDir)).toBeNull();
  });

  it("cleans up output files alongside session", () => {
    const baseDir = makeTmpDir();

    const data = minimalSession();
    const id = createSession(data, baseDir);

    // Create output file (directory-per-session layout)
    const sessionDir = path.join(baseDir, ".flywheel/sessions", id);
    const outputPath = path.join(sessionDir, "output.json");
    fs.writeFileSync(outputPath, JSON.stringify([]));

    const mgr = createSessionManager(makeDeps(baseDir));
    mgr.delete(id);

    // Session directory and all files should be gone
    expect(readSession(id, baseDir)).toBeNull();
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(fs.existsSync(sessionDir)).toBe(false);
  });
});
