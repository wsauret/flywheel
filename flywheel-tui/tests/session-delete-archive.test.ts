/**
 * Integration tests for session deletion and archival (Phase 4.3).
 *
 * Exercises:
 * 1. Delete session -> session files removed from disk, session disappears from list
 * 2. Cannot delete a session matching the activeSessionId guard
 * 3. Archive a completed session -> session transitions to "archived"
 * 4. Orchestrator handleDeleteSession -> trash + delete files + refresh
 * 5. Cannot archive a session in a non-archivable state
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
import { safeUpdateState } from "../src/orchestration/session/safe-transition";
import { createOutputPersistence } from "../src/orchestration/session/output-persistence";
import { createQueuePersistence } from "../src/workflows/queue/persistence";
import {
  createSessionOrchestrator,
  type SessionOrchestratorDeps,
} from "../src/orchestration/session-orchestrator";
import { fromSnapshot } from "../src/orchestration/session/output-schemas";
import type { SessionLifecycleState } from "../src/orchestration/session/state-machine";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-delete-archive-integ-${process.pid}-${Date.now()}`,
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

    // Create a session and transition to a trashable state
    const sessionId = manager.create("plan", "Delete Me", "work");
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "work:active",
    );
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "work:paused",
    );

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

    // Trash the session (state transition)
    manager.trash(sessionId);

    // Delete session files from disk
    const result = deleteSessionWithCompanions(sessionId, baseDir);
    expect(result.errors).toHaveLength(0);
    expect(result.deleted.length).toBe(1);

    // Session directory should be gone
    expect(fs.existsSync(sessionDir)).toBe(false);

    // Session should not appear in readSession
    expect(readSession(sessionId, baseDir)).toBeNull();

    // Session should disappear from list
    const listAfter = manager.list();
    expect(listAfter.sessions.find((s) => s.id === sessionId)).toBeUndefined();
  });

  it("cannot delete session matching activeSessionId guard", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("plan", "Active Session", "work");
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "work:active",
    );

    // Pass the same sessionId as the activeSessionId — deletion should be refused
    const result = deleteSessionWithCompanions(sessionId, baseDir, sessionId);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Cannot delete the currently active session");
    expect(result.deleted).toHaveLength(0);

    // Session should still exist
    expect(readSession(sessionId, baseDir)).not.toBeNull();
  });

  it("allows deletion when activeSessionId is a different session", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const activeId = manager.create("plan", "Active Session", "work");
    const deleteId = manager.create("plan", "Delete Target", "work");

    // Transition deleteId to a trashable state
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      deleteId,
      "work:active",
    );
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      deleteId,
      "work:paused",
    );
    manager.trash(deleteId);

    // Delete the target while a different session is active
    const result = deleteSessionWithCompanions(deleteId, baseDir, activeId);

    expect(result.errors).toHaveLength(0);
    expect(result.deleted.length).toBe(1);
    expect(readSession(deleteId, baseDir)).toBeNull();
    // Active session should still exist
    expect(readSession(activeId, baseDir)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Test 2: Orchestrator handleDeleteSession
// ---------------------------------------------------------------------------

describe("session deletion via orchestrator", () => {
  it("trash -> delete files -> refresh list in one call", async () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("plan", "Orchestrated Delete", "work");
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "work:active",
    );
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "work:paused",
    );

    let refreshCalled = false;

    const orchestrator = createSessionOrchestrator({
      readSession: (id) => readSession(id, baseDir),
      createOutputPersistence: (id) =>
        createOutputPersistence({ sessionId: id, baseDir }),
      createQueuePersistence: (id) =>
        createQueuePersistence({ sessionId: id, baseDir }),
      fromSnapshot,
      manager,
      refreshList: () => {
        refreshCalled = true;
      },
      deleteSessionFiles: (id) => deleteSessionWithCompanions(id, baseDir),
    });

    await orchestrator.handleDeleteSession(sessionId);

    // Session should be gone from disk
    expect(readSession(sessionId, baseDir)).toBeNull();

    // Session directory should be removed
    const sessionDir = path.join(baseDir, ".flywheel/sessions", sessionId);
    expect(fs.existsSync(sessionDir)).toBe(false);

    // refreshList should have been called
    expect(refreshCalled).toBe(true);
  });

  it("orchestrator trash fails on already-trashed session", async () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("plan", "Already Trashed", "work");
    // Trash the session first (new -> trashed is valid via plan:draft)
    manager.updateState(sessionId, "plan:draft");
    manager.trash(sessionId);

    const orchestrator = createSessionOrchestrator({
      readSession: (id) => readSession(id, baseDir),
      createOutputPersistence: (id) =>
        createOutputPersistence({ sessionId: id, baseDir }),
      fromSnapshot,
      manager,
      refreshList: () => {},
    });

    // Attempting to trash an already-trashed session should throw
    // because trashed is a terminal state with no outbound transitions
    await expect(
      orchestrator.handleDeleteSession(sessionId),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Test 3: Archive a completed session
// ---------------------------------------------------------------------------

describe("session archival", () => {
  it("archives a completed session — state transitions to archived", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("plan", "Archive Me", "work");

    // Transition to completed
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "work:active",
    );
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "completed",
    );

    // Verify it's completed
    const beforeArchive = readSession(sessionId, baseDir);
    expect(beforeArchive!.sessionLifecycleState).toBe("completed");

    // Archive
    manager.archive(sessionId);

    // Verify transition
    const afterArchive = readSession(sessionId, baseDir);
    expect(afterArchive).not.toBeNull();
    expect(afterArchive!.sessionLifecycleState).toBe("archived");

    // Verify it shows in list with archived state
    const { sessions } = manager.list();
    const found = sessions.find((s) => s.id === sessionId);
    expect(found).toBeTruthy();
    expect(found!.lifecycleState).toBe("archived");
  });

  it("archives a paused session — work:paused -> archived is valid", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("plan", "Paused Archive", "work");
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "work:active",
    );
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "work:paused",
    );

    // work:paused -> archived is a valid transition
    manager.archive(sessionId);

    const session = readSession(sessionId, baseDir);
    expect(session!.sessionLifecycleState).toBe("archived");
  });

  it("cannot archive a session in work:active state", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("plan", "Active No Archive", "work");
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "work:active",
    );

    // work:active -> archived is NOT a valid transition
    expect(() => manager.archive(sessionId)).toThrow(
      /Invalid state transition/,
    );

    // Session should still be work:active
    const session = readSession(sessionId, baseDir);
    expect(session!.sessionLifecycleState).toBe("work:active");
  });

  it("cannot archive an already-archived session (terminal state)", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("plan", "Double Archive", "work");
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "completed",
    );
    manager.archive(sessionId);

    // archived -> archived should fail (archived is terminal, no outbound transitions)
    expect(() => manager.archive(sessionId)).toThrow(
      /Invalid state transition/,
    );
  });

  it("cannot archive a new session directly", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("plan", "New No Archive", "work");

    // new -> archived is NOT a valid transition
    expect(() => manager.archive(sessionId)).toThrow(
      /Invalid state transition/,
    );

    const session = readSession(sessionId, baseDir);
    expect(session!.sessionLifecycleState).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// Test 4: Delete + archive interaction
// ---------------------------------------------------------------------------

describe("delete and archive interaction", () => {
  it("delete after archive — archived session can be trashed then deleted", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const sessionId = manager.create("plan", "Archive Then Delete", "work");
    safeUpdateState(
      (id, state) => manager.updateState(id, state),
      sessionId,
      "completed",
    );
    manager.archive(sessionId);

    // archived -> trashed is NOT valid (archived is terminal)
    // So we cannot trash an archived session through the state machine
    expect(() => manager.trash(sessionId)).toThrow(
      /Invalid state transition/,
    );

    // But we can force-delete the files directly
    const result = deleteSessionWithCompanions(sessionId, baseDir);
    expect(result.errors).toHaveLength(0);
    expect(readSession(sessionId, baseDir)).toBeNull();
  });

  it("multiple sessions — delete one, archive another, third stays", () => {
    const baseDir = makeTmpDir();
    const manager = createSessionManager(makeDeps(baseDir));

    const id1 = manager.create("plan1", "Delete Target", "work");
    const id2 = manager.create("plan2", "Archive Target", "work");
    const id3 = manager.create("plan3", "Keep This", "work");

    // Set up states
    for (const id of [id1, id2, id3]) {
      safeUpdateState(
        (sid, state) => manager.updateState(sid, state),
        id,
        "work:active",
      );
      safeUpdateState(
        (sid, state) => manager.updateState(sid, state),
        id,
        "completed",
      );
    }

    // Delete session 1
    manager.trash(id1);
    deleteSessionWithCompanions(id1, baseDir);

    // Archive session 2
    manager.archive(id2);

    // Verify final states
    const { sessions } = manager.list();

    expect(sessions.find((s) => s.id === id1)).toBeUndefined(); // deleted
    expect(sessions.find((s) => s.id === id2)?.lifecycleState).toBe("archived");
    expect(sessions.find((s) => s.id === id3)?.lifecycleState).toBe("completed");
  });
});
