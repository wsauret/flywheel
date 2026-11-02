import { describe, it, expect, afterEach } from "bun:test";
import { CONTAINMENT_REFUSAL } from "../../../helpers/containment-refusal.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createStoredSession,
  deleteStoredSession,
  readStoredSession,
} from "./_session-metadata-test-helpers";
import type { Session } from "../../../../src/orchestration/session/schemas";
import {
  createSessionManager,
  type SessionManagerDeps,
} from "../../../../src/orchestration/session/manager";
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import type { EventStore } from "../../../../src/infra/event-store-types";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import { finalizeTestSessionDeletion } from "./_session-manager-fixtures";
import { writeArtifactBreadcrumb } from "../../../../src/orchestration/session/session-artifacts";
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-deletion-test-${process.pid}-${Date.now()}`,
);
const managerStores: EventStore[] = [];

/** Create an isolated tmp dir for a single test. */
function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal valid session data (required fields only). */
function minimalSession(overrides?: Partial<Extract<Session, { kind: "chat" }>>): Extract<Session, { kind: "chat" }> {
  return {
    label: "plans/test.md",
    name: "",
    lifecycleState: "active" as const,
    conversationId: "test-conversation",
    executionCwd: os.tmpdir(),
    lastUpdated: new Date().toISOString(),
    kind: "chat" as const,
    command: "chat" as const,
    ...overrides,
  };
}

/**
 * Create a session with all companion files on disk.
 * Returns { id, baseDir, sessionDir, outputPath }.
 *
 * Includes a legacy companion file to prove deletion removes the whole
 * session artifact directory.
 */
async function createSessionWithCompanions(baseDir: string, overrides?: Partial<Extract<Session, { kind: "chat" }>>) {
  const data = minimalSession({
    ...overrides,
  });

  const id = await createStoredSession(data, baseDir);

  // Session directory already created by createStoredSession
  const sessionDir = path.join(baseDir, ".flywheel/sessions", id);

  // Create the output file using new directory-per-session path
  const outputPath = path.join(sessionDir, "output.json");
  fs.writeFileSync(outputPath, JSON.stringify([]));

  return {
    id,
    baseDir,
    sessionDir,
    outputPath,
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  for (const store of managerStores.splice(0)) store.close();
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ---------------------------------------------------------------------------
// deleteStoredSession
// ---------------------------------------------------------------------------

describe("deleteStoredSession", () => {
  it("preserves global trace artifacts when deleting session directory", async () => {
    const baseDir = makeTmpDir();
    const { id, sessionDir } = await createSessionWithCompanions(baseDir);
    const traceDir = path.join(baseDir, ".flywheel", "traces", id);
    fs.mkdirSync(traceDir, { recursive: true });
    const tracePath = path.join(traceDir, "trace.jsonl");
    const logPath = path.join(traceDir, "session.log");
    const eventStorePath = resolveEventStoreDbFile(baseDir);
    fs.writeFileSync(tracePath, "{}\n");
    fs.writeFileSync(logPath, "session log\n");

    await deleteStoredSession(id, baseDir);

    expect(fs.existsSync(sessionDir)).toBe(false);
    expect(fs.existsSync(traceDir)).toBe(true);
    expect(fs.existsSync(tracePath)).toBe(true);
    expect(fs.existsSync(logPath)).toBe(true);
    expect(fs.existsSync(eventStorePath)).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// SessionManager deletion finalization
// ---------------------------------------------------------------------------

describe("SessionManager deletion finalization", () => {
  /** Build deps for SessionManager. */
  function makeDeps(
    projectRoot: string,
    overrides?: Partial<SessionManagerDeps>,
  ): SessionManagerDeps {
    if (overrides && "store" in overrides && overrides.store) return { projectRoot, executionCwd: projectRoot, ...overrides, store: overrides.store };
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot));
    managerStores.push(store);
    return {
      projectRoot,
      executionCwd: projectRoot,
      ...overrides,
      store,
    };
  }

  it("deletes the session's breadcrumb tree along with its session directory", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id = await mgr.createChat({ name: "Test" });
    // The runner is already disposed when the manager deletes, so nothing is
    // writing into either tree while it is walked.
    const breadcrumb = writeArtifactBreadcrumb({ projectRoot: baseDir, artifactScopeId: id, toolName: "search", content: "full output" });
    expect(fs.existsSync(breadcrumb)).toBe(true);

    await finalizeTestSessionDeletion(mgr, id);

    expect(fs.existsSync(breadcrumb)).toBe(false);
    expect(fs.existsSync(path.join(baseDir, ".flywheel", "agent-outputs", id))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, ".flywheel/sessions", id))).toBe(false);
  });

  it("does not affect other sessions", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id1 = await mgr.createChat({ name: "Keep" });
    const id2 = await mgr.createChat({ name: "Delete me" });

    await finalizeTestSessionDeletion(mgr, id2);

    expect(await readStoredSession(id1, baseDir)).not.toBeNull();
    expect(await readStoredSession(id2, baseDir)).toBeNull();

    const { sessions } = await mgr.listMetadata();
    expect(sessions.find((s) => s.id === id1)).toBeTruthy();
    expect(sessions.find((s) => s.id === id2)).toBeUndefined();
  });

  /** The tombstone and the disposable trees are one deletion in two durable
   *  steps, and only one order is recoverable. Trees first: a tombstone that
   *  landed first would strand trees no listed session names any more, while a
   *  session whose trees are gone is one a later start creates directories for
   *  again. */
  it("appends no tombstone when the session's disposable trees cannot be deleted", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));
    const id = await mgr.createChat({ name: "Test" });
    // A `sessions` component another writer replaced, which the deletion refuses
    // rather than following out of the project.
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    const moved = path.join(baseDir, "moved-sessions");
    fs.renameSync(sessionsDir, moved);
    fs.symlinkSync(moved, sessionsDir);

    await expect(finalizeTestSessionDeletion(mgr, id)).rejects.toThrow(CONTAINMENT_REFUSAL);

    expect((await mgr.listMetadata()).sessions.find((session) => session.id === id)).toBeTruthy();
    const verify = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
    try {
      expect(verify.read({ aggregateId: `session:${id}` }).map((event) => event.type)).not.toContain("session.deleted");
    } finally {
      verify.close();
    }
  });

  it("leaves the session durable when the tombstone cannot be appended after its trees are gone", async () => {
    const baseDir = makeTmpDir();
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
    managerStores.push(store);
    // Reads keep working; only the tombstone append is refused, which is the
    // exact failure the delete contract describes.
    let refuseAppends = false;
    const failing: typeof store = {
      ...store,
      append: (event) => {
        if (refuseAppends) throw new Error("append refused");
        return store.append(event);
      },
      appendBatch: (events) => {
        if (refuseAppends) throw new Error("append refused");
        return store.appendBatch(events);
      },
    };
    const mgr = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store: failing });
    const id = await mgr.createChat({ name: "Test" });
    const breadcrumb = writeArtifactBreadcrumb({ projectRoot: baseDir, artifactScopeId: id, toolName: "search", content: "full output" });
    refuseAppends = true;

    await expect(finalizeTestSessionDeletion(mgr, id)).rejects.toThrow("append refused");

    expect(fs.existsSync(path.join(baseDir, ".flywheel", "sessions", id))).toBe(false);
    expect(fs.existsSync(breadcrumb)).toBe(false);
    const verify = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
    try {
      const types = verify.read({ aggregateId: `session:${id}` }).map((event) => event.type);
      expect(types).toContain("session.created");
      expect(types).not.toContain("session.deleted");
    } finally {
      verify.close();
    }
  });
});
