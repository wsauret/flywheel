import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import { createSessionMetadataStore } from "../../../../src/orchestration/session/session-metadata-store";
import { cleanupTmpRoot, makeTmpDir, minimalSession } from "./_session-persistence-fixtures";

const ownedStores: EventStore[] = [];

afterEach(() => {
  for (const store of ownedStores.splice(0)) store.close();
  cleanupTmpRoot();
});

function makeStore(baseDir: string): ReturnType<typeof createSessionMetadataStore> {
  const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
  ownedStores.push(eventStore);
  return createSessionMetadataStore({ reader: asAsyncEventReadSurface(eventStore), writer: asAsyncEventWriter(eventStore) });
}

// A directory authority decodes only when it is canonical for the running
// platform: a POSIX literal resolves onto the current drive on Windows.


describe("SessionMetadataStore.list", () => {
  it("lists sessions with their ids and metadata", async () => {
    const baseDir = makeTmpDir();
    const store = makeStore(baseDir);

    const id1 = await store.create(minimalSession({ label: "plan-A.md" }));
    const id2 = await store.create(minimalSession({ label: "plan-B.md" }));

    const result = await store.list();
    expect(result.errors).toEqual([]);
    expect(result.entries.map((s) => s.id)).toEqual(expect.arrayContaining([id1, id2]));
    expect(result.entries.map((s) => s.data.label)).toEqual(expect.arrayContaining(["plan-A.md", "plan-B.md"]));
  });

  it("groups sessions by lifecycle state from projected facts", async () => {
    const baseDir = makeTmpDir();
    const store = makeStore(baseDir);

    await store.create(minimalSession({ lifecycleState: "active" }));
    await store.create(minimalSession({ lifecycleState: "inactive" }));
    await store.create(minimalSession());

    const result = await store.list();
    expect(result.entries.filter((s) => s.data.lifecycleState === "active")).toHaveLength(2);
    expect(result.entries.filter((s) => s.data.lifecycleState === "inactive")).toHaveLength(1);
  });

  it("ignores orphan artifact directories because metadata is SQLite-sourced", async () => {
    const baseDir = makeTmpDir();
    const store = makeStore(baseDir);
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.mkdirSync(path.join(sessionsDir, "orphan", "handoffs"), { recursive: true });
    fs.writeFileSync(path.join(sessionsDir, "orphan", "session.log"), "orphan log");

    expect((await store.list()).entries).toEqual([]);
    expect(fs.existsSync(path.join(sessionsDir, "orphan"))).toBe(true);
  });
});
