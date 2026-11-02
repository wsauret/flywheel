import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import type { DebugLogRecordInput } from "../../../../src/infra/debug-log";
import { Log } from "../../../../src/infra/log";
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import { createSessionManager, type SessionMetadataChange } from "../../../../src/orchestration/session/manager";
import { readStoredSession } from "./_session-metadata-test-helpers";
import { removeOwnerPid } from "../../../../src/orchestration/session/pid-lock";
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer";
import { cleanupTmpRoot, finalizeTestSessionDeletion, makeDeps, makeDepsWithStore, makeTmpDir, publishTestWorkflow, startTestWorkflowMember } from "./_session-manager-fixtures";

afterEach(() => {
  cleanupTmpRoot();
});

// Counts persisted lifecycle facts so a TOCTOU race (two transitions both
// validating against the same stale snapshot) surfaces as a duplicate append.
function readLifecycleChangeCount(id: string, baseDir: string): number {
  const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
  try {
    return store.read({ aggregateId: `session:${id}`, types: ["session.lifecycle.changed"] }).length;
  } finally {
    store.close();
  }
}

async function commitUserTurn(baseDir: string, store: EventStore, sessionId: string): Promise<void> {
  const session = await readStoredSession(sessionId, baseDir);
  if (!session || session.kind !== "chat") throw new Error(`Expected chat session: ${sessionId}`);
  const writer = createConversationTreeWriterController({
    conversationId: session.conversationId,
    sessionId,
    projectRoot: baseDir,
    store: asAsyncEventReadSurface(store),
    projectionReader: asAsyncEventReadSurface(store),
    writer: asAsyncEventWriter(store),
  });
  try {
    await writer.commitUserTurn("hello");
  } finally {
    await writer.dispose();
  }
}

// ---------------------------------------------------------------------------
// updateLifecycleState()
// ---------------------------------------------------------------------------

describe("SessionManager.updateLifecycleState()", () => {
  it("prunes superseded file review assertions on close and reopens with the latest value", async () => {
    const baseDir = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
    const id = await mgr.createChat({ name: "Review retention" })
    const writer = asAsyncEventWriter(store)
    const editToken = { position: 1, eventId: "edit-1" }
    for (const reviewed of [true, false, true]) {
      await writer.append({
        aggregateId: `session:${id}`, sessionId: id, type: "file.reviewed", version: 1,
        actor: "flywheel", timestamp: Date.now(), payload: { fileId: "file:retained", editToken, reviewed },
      })
    }
    expect(store.read({ aggregateId: `session:${id}`, types: ["file.reviewed"] })).toHaveLength(3)

    await mgr.updateLifecycleState(id, "inactive")
    store.close()
    const reopened = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    try {
      const rows = reopened.read({ aggregateId: `session:${id}`, types: ["file.reviewed"] })
      expect(rows).toHaveLength(1)
      expect(rows[0]?.payload).toEqual({ fileId: "file:retained", editToken, reviewed: true })
      expect(reopened.aggregateSeq(`session:${id}`)).toBeGreaterThan(rows[0]!.seq)
    } finally {
      reopened.close()
    }
  })

  it("identifies the changed session in metadata notifications", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));
    const changes: SessionMetadataChange[] = [];
    mgr.subscribe((change) => changes.push(change));

    const id = await mgr.createChat({ name: "Test" });
    changes.length = 0;
    await mgr.updateLifecycleState(id, "inactive");

    expect(changes).toEqual([{ kind: "changed", sessionIds: [id] }]);
  });

  it("throws when session does not exist", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    await expect(mgr.updateLifecycleState("non-existent", "inactive")).rejects.toThrow();
  });

  it("updateState persists state changes", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = await mgr.createChat({ name: "Test" });
    expect((await mgr.listMetadata()).sessions.find(s => s.id === id)?.lifecycleState).toBe("active");

    await mgr.updateLifecycleState(id, "inactive");
    expect((await mgr.listMetadata()).sessions.find(s => s.id === id)?.lifecycleState).toBe("inactive");

    await mgr.updateLifecycleState(id, "active");
    expect((await mgr.listMetadata()).sessions.find(s => s.id === id)?.lifecycleState).toBe("active");
  });

  it("converges under concurrent transitions from the same state", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = await mgr.createChat({ name: "Test" });
    // Two concurrent active->inactive transitions: the loser is a noop, not a
    // second append. The atomic store transition prevents both from validating
    // against the same stale "active" snapshot.
    await Promise.all([
      mgr.updateLifecycleState(id, "inactive"),
      mgr.updateLifecycleState(id, "inactive"),
    ]);

    expect((await readStoredSession(id, baseDir))!.lifecycleState).toBe("inactive");
    const lifecycleFacts = readLifecycleChangeCount(id, baseDir);
    expect(lifecycleFacts).toBe(1);
  });

  it("transitions recoverable metadata after strict replay quarantines it", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const manager = createSessionManager(deps)
    const id = await manager.createChat({ name: "Recoverable", initialState: "active" })
    store.append({
      aggregateId: `session:${id}`,
      type: "session.auth.profile.selected",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId: id,
      payload: { authProfileId: "work" },
      payloadJson: "{{not-json",
    })

    await manager.updateLifecycleState(id, "inactive")

    expect(await manager.read(id)).toMatchObject({ lifecycleState: "inactive" })
    expect((await manager.listForIds([id])).errors).toEqual([
      expect.objectContaining({ sessionId: id, scope: "metadata" }),
    ])
  })

  it("re-claims owner.pid when activating an already-active session (noop transition)", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // A hard-killed owner leaves metadata "active" with no (or a dead)
    // owner.pid; the next activation is a noop transition but must still
    // claim the ephemeral probe, or reconcile reads treat the session as
    // ownerless and adopt an in-flight turn's provisionals.
    const id = await mgr.createChat({ name: "Test" });
    removeOwnerPid(id, baseDir);

    await mgr.updateLifecycleState(id, "active");

    const pidPath = path.join(baseDir, ".flywheel", "sessions", id, "owner.pid");
    expect(fs.readFileSync(pidPath, "utf-8").split(" ")[0]).toBe(String(process.pid));
  });
});

// ---------------------------------------------------------------------------
// deletion finalization
// ---------------------------------------------------------------------------

describe("SessionManager deletion finalization", () => {
  it("removes session from list", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = await mgr.createChat({ name: "Test" });
    expect((await mgr.listMetadata()).sessions.find(s => s.id === id)?.lifecycleState).toBe("active");

    await finalizeTestSessionDeletion(mgr, id);
    expect((await mgr.listMetadata()).sessions.find(s => s.id === id)).toBeUndefined();
  });

  it("removes session from list", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = await mgr.createChat({ name: "Test" });
    expect((await mgr.listMetadata()).sessions.find((s) => s.id === id)).toBeTruthy();

    await finalizeTestSessionDeletion(mgr, id);
    expect((await mgr.listMetadata()).sessions.find((s) => s.id === id)).toBeUndefined();
  });

  it("works from any lifecycle state", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // From active
    const id1 = await mgr.createChat({ name: "A" });
    await finalizeTestSessionDeletion(mgr, id1);
    expect(await readStoredSession(id1, baseDir)).toBeNull();

    // From inactive
    const id2 = await mgr.createChat({ name: "B" });
    await mgr.updateLifecycleState(id2, "inactive");
    await finalizeTestSessionDeletion(mgr, id2);
    expect(await readStoredSession(id2, baseDir)).toBeNull();

    // Delete remains idempotent after the inactive state replaces completed.
  });

  it("does not throw for non-existent session (no files to delete)", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // Should not throw — no files to delete, just a no-op
    await expect(finalizeTestSessionDeletion(mgr, "non-existent")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// recoverStaleSessions()
// ---------------------------------------------------------------------------

describe("SessionManager.recoverStaleSessions()", () => {
  it("recovers active chat sessions to inactive (no live runner)", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const mgr = createSessionManager(deps);

    const id = await mgr.createChat({ name: "Chat Session" });
    await commitUserTurn(baseDir, store, id);
    removeOwnerPid(id, baseDir); // simulate crashed process

    const before = await readStoredSession(id, baseDir);
    expect(before!.lifecycleState).toBe("active");

    // Simulate startup recovery
    const records: DebugLogRecordInput[] = [];
    await Log.init({ forward: (record) => { records.push(record); } });
    let recovered: number;
    try {
      recovered = await mgr.recoverStaleSessions();
    } finally {
      await Log.closeGlobal();
    }
    expect(recovered).toBeGreaterThanOrEqual(1);

    const after = await readStoredSession(id, baseDir);
    expect(after!.lifecycleState).toBe("inactive");
    // The session name is a title the person or the model wrote, so the
    // record names the session by id only.
    expect(records).toContainEqual({ type: "log.info", sessionId: id, payload: { service: "session.manager", message: "recovered stale session", to: "inactive" } });
    expect(JSON.stringify(records)).not.toContain("Chat Session");
  });

  it("keeps a stale blank chat for the tab that attaches it again", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = await mgr.createChat({ name: "New Chat" });
    // The service that owned it is gone; no client has attached again yet.
    removeOwnerPid(id, baseDir);

    const recovered = await mgr.recoverStaleSessions();

    expect(recovered).toBe(1);
    expect((await readStoredSession(id, baseDir))?.lifecycleState).toBe("inactive");
  });

  it("ignores orphan artifact directories during startup recovery", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    const orphanDir = path.join(sessionsDir, "orphan");
    fs.mkdirSync(path.join(orphanDir, "handoffs"), { recursive: true });

    const validId = await mgr.createChat({ name: "Work Session" });
    removeOwnerPid(validId, baseDir); // simulate crashed process

    const recovered = await mgr.recoverStaleSessions();

    expect(recovered).toBe(1);
    expect((await readStoredSession(validId, baseDir))!.lifecycleState).toBe("inactive");
    expect(fs.existsSync(orphanDir)).toBe(true);
  });

  it("recovers both chat and workflow member active sessions in the same run", async () => {
    const baseDir = makeTmpDir();
    const { deps, store } = makeDepsWithStore(baseDir);
    const mgr = createSessionManager(deps);

    const chatId = await mgr.createChat({ name: "Chat" });
    await commitUserTurn(baseDir, store, chatId);
    removeOwnerPid(chatId, baseDir); // simulate crashed process

    const workflowId = await publishTestWorkflow(mgr, { workflowDefinitionId: "plans/work.md", name: "Work" });
    const workId = await startTestWorkflowMember(mgr, store, workflowId);
    await mgr.updateLifecycleState(workId, "active");
    removeOwnerPid(workId, baseDir); // simulate crashed process

    const recovered = await mgr.recoverStaleSessions();
    expect(recovered).toBe(2);

    expect((await readStoredSession(chatId, baseDir))!.lifecycleState).toBe("inactive");
    expect((await readStoredSession(workId, baseDir))!.lifecycleState).toBe("inactive");
  });

  it("does not recover already inactive sessions", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const inactiveId = await mgr.createChat({ name: "Inactive" });
    await mgr.updateLifecycleState(inactiveId, "inactive");

    const recovered = await mgr.recoverStaleSessions();
    expect(recovered).toBe(0);

    expect((await readStoredSession(inactiveId, baseDir))!.lifecycleState).toBe("inactive");
  });

  it("does not recover sessions whose owner process is still alive", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    // PID file written by create() points to the current (alive) process
    const id = await mgr.createChat({ name: "Alive Session" });

    const recovered = await mgr.recoverStaleSessions();
    expect(recovered).toBe(0);
    expect((await readStoredSession(id, baseDir))!.lifecycleState).toBe("active");
  });
});
