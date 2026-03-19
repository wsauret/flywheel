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
} from "../src/session/persistence";
import type { CliSession } from "../src/schemas/session";
import type { SessionLifecycleState } from "../src/session/state-machine";
import {
  createSessionManager,
  type SessionManagerDeps,
} from "../src/session/manager";
import type { WorkflowSession } from "../src/tui/components/workflow-session";

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

/**
 * Create a session with all companion files on disk.
 * Returns { id, baseDir, statePath, contextPath, outputPath, jsonPath }.
 */
function createSessionWithCompanions(baseDir: string, overrides?: Partial<CliSession>) {
  const stateRelPath = `.flywheel/state/${crypto.randomUUID()}.state.md`;
  const contextRelPath = `.flywheel/context/${crypto.randomUUID()}.ctx.md`;

  const data = minimalSession({
    statePath: stateRelPath,
    contextPath: contextRelPath,
    ...overrides,
  });

  const id = createSession(data, baseDir);

  // Create the companion files on disk
  const statePath = path.join(baseDir, stateRelPath);
  const contextPath = path.join(baseDir, contextRelPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.mkdirSync(path.dirname(contextPath), { recursive: true });
  fs.writeFileSync(statePath, "# State file");
  fs.writeFileSync(contextPath, "# Context file");

  // Create the output file using convention-based path
  const outputPath = path.join(baseDir, ".flywheel/sessions", `${id}.output.json`);
  fs.writeFileSync(outputPath, JSON.stringify([]));

  // Update session to record outputPath
  // (We just write it directly since we know the schema)
  const jsonPath = path.join(baseDir, ".flywheel/sessions", `${id}.json`);
  const sessionData = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  sessionData.outputPath = `${id}.output.json`;
  sessionData.lastUpdated = new Date().toISOString();
  fs.writeFileSync(jsonPath, JSON.stringify(sessionData, null, 2));

  return {
    id,
    baseDir,
    statePath,
    contextPath,
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
  it("deletes session JSON + state + context + output files", () => {
    const baseDir = makeTmpDir();
    const { id, statePath, contextPath, outputPath, jsonPath } =
      createSessionWithCompanions(baseDir);

    // Verify all files exist before deletion
    expect(fs.existsSync(jsonPath)).toBe(true);
    expect(fs.existsSync(statePath)).toBe(true);
    expect(fs.existsSync(contextPath)).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);

    const result = deleteSessionWithCompanions(id, baseDir);

    // All files should be gone
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.existsSync(contextPath)).toBe(false);
    expect(fs.existsSync(outputPath)).toBe(false);

    // All files should be in the deleted list
    expect(result.deleted.length).toBe(4);
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

  it("reads session JSON to find companion paths", () => {
    const baseDir = makeTmpDir();
    // Use a non-standard statePath to prove it's read from JSON
    const customStatePath = `.flywheel/custom-states/unique-${crypto.randomUUID()}.md`;
    const customStateAbsPath = path.join(baseDir, customStatePath);
    fs.mkdirSync(path.dirname(customStateAbsPath), { recursive: true });
    fs.writeFileSync(customStateAbsPath, "# Custom state");

    const data = minimalSession({ statePath: customStatePath });
    const id = createSession(data, baseDir);

    const result = deleteSessionWithCompanions(id, baseDir);

    // The custom statePath should have been resolved from JSON and deleted
    expect(fs.existsSync(customStateAbsPath)).toBe(false);
    expect(result.deleted).toContain(customStateAbsPath);
  });

  it("falls back to convention-based output path if JSON read fails", () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel/sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create a session JSON that is corrupt (unreadable by readSession)
    const id = crypto.randomUUID();
    const jsonPath = path.join(sessionsDir, `${id}.json`);
    fs.writeFileSync(jsonPath, "NOT VALID JSON {{{");

    // But the output file does exist at the convention path
    const outputPath = path.join(sessionsDir, `${id}.output.json`);
    fs.writeFileSync(outputPath, JSON.stringify([]));

    const result = deleteSessionWithCompanions(id, baseDir);

    // Convention-based output file should be deleted
    expect(fs.existsSync(outputPath)).toBe(false);
    expect(result.deleted).toContain(outputPath);

    // The corrupt JSON should also be deleted
    expect(fs.existsSync(jsonPath)).toBe(false);
    expect(result.deleted).toContain(jsonPath);
  });

  it("reports errors for files that fail to delete but continues", () => {
    const baseDir = makeTmpDir();
    const { id, statePath, contextPath, jsonPath } =
      createSessionWithCompanions(baseDir);

    // Make statePath's directory read-only to cause delete failure
    // (On macOS/Linux, making the parent dir read-only prevents unlinking)
    const stateDir = path.dirname(statePath);
    fs.chmodSync(stateDir, 0o555);

    try {
      const result = deleteSessionWithCompanions(id, baseDir);

      // State file deletion should have failed
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some((e) => e.includes("state"))).toBe(true);

      // But context + output + JSON should still have been attempted
      // (context and JSON should succeed since their dirs are writable)
      expect(result.deleted.length).toBeGreaterThan(0);
    } finally {
      // Restore permissions so cleanup works
      fs.chmodSync(stateDir, 0o755);
    }
  });

  it("deletes session JSON last (after companions)", () => {
    const baseDir = makeTmpDir();
    const { id, jsonPath } = createSessionWithCompanions(baseDir);

    const result = deleteSessionWithCompanions(id, baseDir);

    // Session JSON should be the last item in the deleted list
    const jsonIndex = result.deleted.indexOf(jsonPath);
    expect(jsonIndex).toBe(result.deleted.length - 1);
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

  it("handles missing companion files gracefully (still deletes what exists)", () => {
    const baseDir = makeTmpDir();
    // Create session but don't create companion files on disk
    const data = minimalSession({
      statePath: ".flywheel/state/nonexistent.state.md",
      contextPath: ".flywheel/context/nonexistent.ctx.md",
    });
    const id = createSession(data, baseDir);

    const result = deleteSessionWithCompanions(id, baseDir);

    // Should still succeed — only the JSON file existed
    expect(result.errors).toHaveLength(0);
    // Only session JSON was deleted (companions didn't exist)
    expect(result.deleted.length).toBe(1);
    expect(result.deleted[0]).toContain(`${id}.json`);

    // Session should be gone
    expect(readSession(id, baseDir)).toBeNull();
  });

  it("handles session that does not exist at all", () => {
    const baseDir = makeTmpDir();
    const fakeId = crypto.randomUUID();

    const result = deleteSessionWithCompanions(fakeId, baseDir);

    // No files to delete, no errors (just nothing happened)
    expect(result.deleted).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Startup sweep for trashed sessions
// ---------------------------------------------------------------------------

describe("SessionManager.sweepTrashed", () => {
  /** Create a mock WorkflowSession. */
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

  /** Build deps for SessionManager. */
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

  it("deletes trashed sessions from disk", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Create two sessions, trash one
    const id1 = mgr.create("plans/keep.md");
    mgr.updateState(id1, "plan:imported");

    const id2 = mgr.create("plans/trash-me.md");
    mgr.updateState(id2, "plan:draft");
    mgr.trash(id2);

    // Verify trashed session exists on disk before sweep
    expect(readSession(id2, baseDir)).not.toBeNull();

    // Run sweep
    const swept = mgr.sweepTrashed();

    // Trashed session should be deleted from disk
    expect(readSession(id2, baseDir)).toBeNull();
    // Non-trashed session should still exist
    expect(readSession(id1, baseDir)).not.toBeNull();
    // Sweep result reports what was cleaned
    expect(swept).toBeGreaterThanOrEqual(1);
  });

  it("returns 0 when no trashed sessions exist", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id1 = mgr.create("plans/active.md");
    mgr.updateState(id1, "plan:imported");

    const swept = mgr.sweepTrashed();
    expect(swept).toBe(0);
  });

  it("does not delete non-trashed sessions", () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Create sessions in various states
    const id1 = mgr.create("plans/new.md");
    const id2 = mgr.create("plans/imported.md");
    mgr.updateState(id2, "plan:imported");
    const id3 = mgr.create("plans/active.md");
    mgr.updateState(id3, "plan:imported");
    mgr.updateState(id3, "plan:approved");
    mgr.updateState(id3, "work:active");

    mgr.sweepTrashed();

    // All sessions should still exist
    expect(readSession(id1, baseDir)).not.toBeNull();
    expect(readSession(id2, baseDir)).not.toBeNull();
    expect(readSession(id3, baseDir)).not.toBeNull();
  });

  it("cleans up companion files for trashed sessions", () => {
    const baseDir = makeTmpDir();

    // Create a session with companion files, then trash it
    const stateRelPath = `.flywheel/state/${crypto.randomUUID()}.state.md`;
    const contextRelPath = `.flywheel/context/${crypto.randomUUID()}.ctx.md`;

    const data = minimalSession({
      statePath: stateRelPath,
      contextPath: contextRelPath,
    });
    const id = createSession(data, baseDir);

    // Create companion files
    const statePath = path.join(baseDir, stateRelPath);
    const contextPath = path.join(baseDir, contextRelPath);
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.mkdirSync(path.dirname(contextPath), { recursive: true });
    fs.writeFileSync(statePath, "# State");
    fs.writeFileSync(contextPath, "# Context");

    // Transition to trashed
    updateSession(id, { sessionLifecycleState: "plan:draft" as SessionLifecycleState }, baseDir);
    updateSession(id, { sessionLifecycleState: "trashed" as SessionLifecycleState, lastTrashedAt: Date.now() }, baseDir);

    const mgr = createSessionManager(makeDeps(baseDir));
    mgr.sweepTrashed();

    // Companion files should be gone
    expect(fs.existsSync(statePath)).toBe(false);
    expect(fs.existsSync(contextPath)).toBe(false);
  });
});
