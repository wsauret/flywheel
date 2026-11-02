import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import type { EventStore } from "../../../../src/infra/event-store-types";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import {
  createSessionManager,
  type SessionManagerDeps,
} from "../../../../src/orchestration/session/manager";
import { readStoredSession } from "./_session-metadata-test-helpers";
import { isValidTransition } from "../../../../src/orchestration/session/types";
import { finalizeTestSessionDeletion } from "./_session-manager-fixtures";

const TMP_ROOT = path.join(os.tmpdir(), `flywheel-lifecycle-integ-${process.pid}-${Date.now()}`);
const stores: EventStore[] = [];

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeDeps(projectRoot: string, overrides?: Partial<SessionManagerDeps> & { store?: EventStore }): SessionManagerDeps {
  if (overrides?.store) return { projectRoot, executionCwd: projectRoot, ...overrides, store: overrides.store };
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot));
  stores.push(store);
  return { projectRoot, executionCwd: projectRoot, ...overrides, store };
}


afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

describe("Session lifecycle", () => {
  it("recreates the ephemeral session directory when activating", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));
    const id = await mgr.createChat({ name: "Feature X" });

    await mgr.updateLifecycleState(id, "inactive");
    fs.rmSync(path.join(baseDir, ".flywheel", "sessions", id), { recursive: true, force: true });

    await mgr.updateLifecycleState(id, "active");
    expect((await readStoredSession(id, baseDir))!.lifecycleState).toBe("active");
    expect(fs.existsSync(path.join(baseDir, ".flywheel", "sessions", id, "owner.pid"))).toBe(true);
  });

});

describe("Multi-session lifecycle", () => {
  it("operations on one session do not affect others", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const id1 = await mgr.createChat({ name: "X" });
    const id2 = await mgr.createChat({ name: "Y" });
    await mgr.updateLifecycleState(id1, "inactive");

    expect((await readStoredSession(id1, baseDir))!.lifecycleState).toBe("inactive");
    expect((await readStoredSession(id2, baseDir))!.lifecycleState).toBe("active");
  });
});

describe("Inactive persistence and recovery", () => {
  it("inactive state persists across manager instances", async () => {
    const baseDir = makeTmpDir();
    const mgr1 = createSessionManager(makeDeps(baseDir));
    const id = await mgr1.createChat({ name: "Persist Test" });
    await mgr1.updateLifecycleState(id, "inactive");

    const mgr2 = createSessionManager(makeDeps(baseDir));
    expect((await mgr2.listMetadata()).sessions.find((s) => s.id === id)?.lifecycleState).toBe("inactive");
  });

  // Chat-session recovery (inactive with a committed user turn, tombstoned when
  // blank) is covered in session-manager-lifecycle.test.ts.
});


describe("Transition table validation", () => {
  it("covers the active/inactive state machine", () => {
    expect(isValidTransition("active", "inactive")).toBe(true);
    expect(isValidTransition("inactive", "active")).toBe(true);
    expect(isValidTransition("active", "active")).toBe(false);
    expect(isValidTransition("inactive", "inactive")).toBe(false);
  });
});

describe("Session deletion", () => {
  it("can delete sessions from either lifecycle state", async () => {
    const baseDir = makeTmpDir();
    const mgr = createSessionManager(makeDeps(baseDir));

    const activeId = await mgr.createChat({ name: "Active" });
    const inactiveId = await mgr.createChat({ name: "Inactive" });
    await mgr.updateLifecycleState(inactiveId, "inactive");

    await finalizeTestSessionDeletion(mgr, activeId);
    await finalizeTestSessionDeletion(mgr, inactiveId);

    expect(await readStoredSession(activeId, baseDir)).toBeNull();
    expect(await readStoredSession(inactiveId, baseDir)).toBeNull();
  });

  it("empties the deleted session's in-flight state and only that session's", async () => {
    const projectRoot = makeTmpDir();
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot));
    stores.push(store);
    const mgr = createSessionManager(makeDeps(projectRoot, { store }));
    const doomed = await mgr.createChat({ name: "Doomed" });
    const survivor = await mgr.createChat({ name: "Survivor" });

    store.putInFlight(doomed, "file.mutation", "m1", { path: "/scratch/a.ts" });
    store.putInFlight(doomed, "chat.queued_user_input", "q1", { text: "hello" });
    store.putInFlight(survivor, "file.mutation", "m2", { path: "/scratch/b.ts" });

    await finalizeTestSessionDeletion(mgr, doomed);

    // A deleted session has no operation left to resume: a surviving cell
    // would make the workspace recovery sweep append facts to its aggregate.
    expect(store.readInFlight(doomed, "file.mutation")).toHaveLength(0);
    expect(store.readInFlight(doomed, "chat.queued_user_input")).toHaveLength(0);
    expect(store.readInFlight(survivor, "file.mutation")).toHaveLength(1);
  });
});
