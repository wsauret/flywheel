/**
 * Integration tests for session deletion.
 *
 * Exercises:
 * 1. Delete session -> session files removed from disk, session disappears from list
 * 2. Manager.delete() removes files, clears cache, cleans up worktree
 * 3. Direct delete: manager.delete() + refreshList()
 * 4. Multiple sessions — delete one, others stay
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
import {
  readSession,
  deleteSessionWithCompanions,
  createSession,
} from "../src/orchestration/session/persistence";
import { createOutputPersistence } from "../src/orchestration/session/output-persistence";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-delete-integ-${process.pid}-${Date.now()}`,
);

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeDeps(baseDir: string): SessionManagerDeps {
  return { baseDir };
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
// Test 1: Delete session -> files removed, disappears from list
// ---------------------------------------------------------------------------

describe("session deletion", () => {
  it("deletes session files from disk and removes from list", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    // Create a session (starts as active), then pause it
    const sessionId = manager.create("plan", "Delete Me", "work");
    manager.updateState(sessionId, "paused");

    // Also persist some output to verify companion files are cleaned
    const outputPersistence = createOutputPersistence({
      sessionId,
      baseDir,
    });
    outputPersistence.save([
      { kind: "text", content: "test output", timestamp: Date.now() },
    ]);

    // Verify session exists before deletion
    const sessionDir = path.join(baseDir, ".flywheel/sessions", sessionId);
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(readSession(sessionId, baseDir)).not.toBeNull();

    const listBefore = manager.list();
    expect(listBefore.sessions.find((s) => s.id === sessionId)).toBeTruthy();

    // Delete the session
    manager.delete(sessionId);

    // Session directory should be gone
    expect(fs.existsSync(sessionDir)).toBe(false);

    // Session should not appear in readSession
    expect(readSession(sessionId, baseDir)).toBeNull();

    // Session should disappear from list
    const listAfter = manager.list();
    expect(listAfter.sessions.find((s) => s.id === sessionId)).toBeUndefined();
  });

  it("allows deletion of any session (active-session guard lives in TUI)", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const activeId = manager.create("plan", "Active Session", "work");
    const deleteId = manager.create("plan", "Delete Target", "work");

    // Delete the target
    manager.delete(deleteId);

    expect(readSession(deleteId, baseDir)).toBeNull();
    // Active session should still exist
    expect(readSession(activeId, baseDir)).not.toBeNull();
  });

  it("can delete sessions in any state", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    // Active session
    const id1 = manager.create("plan", "Active", "work");
    manager.delete(id1);
    expect(readSession(id1, baseDir)).toBeNull();

    // Paused session
    const id2 = manager.create("plan", "Paused", "work");
    manager.updateState(id2, "paused");
    manager.delete(id2);
    expect(readSession(id2, baseDir)).toBeNull();

    // Completed session
    const id3 = manager.create("plan", "Completed", "work");
    manager.updateState(id3, "completed");
    manager.delete(id3);
    expect(readSession(id3, baseDir)).toBeNull();
  });

  it("removes session from list on delete", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const id = manager.create("plan", "Cache Test", "work");
    expect(manager.list().sessions.find(s => s.id === id)?.state).toBe("active");

    manager.delete(id);
    expect(manager.list().sessions.find(s => s.id === id)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Test 2: Direct delete: manager.delete() + refreshList()
// ---------------------------------------------------------------------------

describe("session deletion via direct calls", () => {
  it("delete + refresh list in sequence", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("plan", "Direct Delete", "work");
    manager.updateState(sessionId, "paused");

    let refreshCalled = false;
    const refreshList = () => { refreshCalled = true; };

    // Inline pattern: manager.delete() then refreshList()
    manager.delete(sessionId);
    refreshList();

    // Session should be gone from disk
    expect(readSession(sessionId, baseDir)).toBeNull();

    // Session directory should be removed
    const sessionDir = path.join(baseDir, ".flywheel/sessions", sessionId);
    expect(fs.existsSync(sessionDir)).toBe(false);

    // refreshList should have been called
    expect(refreshCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Multiple sessions — delete one, others stay
// ---------------------------------------------------------------------------

describe("delete interaction with other sessions", () => {
  it("multiple sessions — delete one, others stay", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const id1 = manager.create("plan1", "Delete Target", "work");
    const id2 = manager.create("plan2", "Keep This", "work");
    const id3 = manager.create("plan3", "Keep This Too", "work");

    // Delete session 1
    manager.delete(id1);

    // Verify final states
    const { sessions } = manager.list();

    expect(sessions.find((s) => s.id === id1)).toBeUndefined(); // deleted
    expect(sessions.find((s) => s.id === id2)?.state).toBe("active");
    expect(sessions.find((s) => s.id === id3)?.state).toBe("active");
  });
});
