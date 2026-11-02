import { describe, it, expect, afterEach } from "bun:test";
import { safeParse } from "../../../helpers/schema-assertions.js";
import * as fs from "node:fs";
import * as path from "node:path";

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import { asAsyncEventReadSurface, asAsyncEventWriter, requireGuardedEventAppender, type EventStore } from "../../../../src/infra/event-store-types";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import { buildSessionMetadataAppend, createSessionMetadataStore } from "../../../../src/orchestration/session/session-metadata-store";
import { SessionSchema } from "../../../../src/orchestration/session/schemas";
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

describe("SessionMetadataStore", () => {
  it("creates and reads sessions from the SQLite metadata projection", async () => {
    const baseDir = makeTmpDir();
    const store = makeStore(baseDir);

    const id = await store.create(minimalSession());
    const read = await store.read(id);

    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(read?.kind).toBe("chat");
    if (read?.kind !== "chat") throw new Error("expected chat");
    expect(read.conversationId).toBe("test-conversation");
    expect(fs.existsSync(path.join(baseDir, ".flywheel", "sessions", id, "session.json"))).toBe(false);
  });

  it("stores optional metadata fields", async () => {
    const baseDir = makeTmpDir();
    const store = makeStore(baseDir);

    const id = await store.create(minimalSession({
      lifecycleState: "active",
      name: "My Session",
      createdAt: "2026-03-15T12:00:00.000Z",
      repo: "flywheel/flywheel-tui",
      branch: "main",
    }));
    const read = await store.read(id);

    expect(read?.lifecycleState).toBe("active");
    expect(read?.name).toBe("My Session");
    expect(read?.createdAt).toBe("2026-03-15T12:00:00.000Z");
    expect(read?.repo).toBe("flywheel/flywheel-tui");
    expect(read?.branch).toBe("main");
  });

  it("updates label and short label without touching session kind", async () => {
    const baseDir = makeTmpDir();
    const store = makeStore(baseDir);
    const id = await store.create(minimalSession());

    await store.updateLabel(id, { label: "New Label", shortLabel: "New" }, "user");
    await store.updateLabel(id, { shortLabel: "Tab only" }, "user");
    await store.updateLabel(id, { label: "Description only" }, "user");

    const reloaded = makeStore(baseDir);
    const read = await reloaded.readOrThrow(id);
    expect(read.label).toBe("Description only");
    expect(read.name).toBe("Description only");
    expect(read.shortLabel).toBe("Tab only");
    expect(read.userNamed).toBe(true);
    expect(read.kind).toBe("chat");
  });

  it("preserves the original compact title when only the description changes", async () => {
    const baseDir = makeTmpDir();
    const store = makeStore(baseDir);
    for (const shortLabel of [undefined, "", "An existing title longer than fourteen"]) {
      const id = await store.create(minimalSession({ label: "Original description", ...(shortLabel !== undefined ? { shortLabel } : {}) }));
      await store.updateLabel(id, { label: "New description" }, "user");
      expect((await store.readOrThrow(id)).shortLabel).toBe(shortLabel || "Original descr");
    }
  });

  it("merges overlapping partial edits against the latest SQLite metadata", async () => {
    const baseDir = makeTmpDir();
    const creator = makeStore(baseDir);
    const id = await creator.create(minimalSession({ label: "Original", shortLabel: "Old tab" }));
    const bothEntered = Promise.withResolvers<void>();
    let arrivals = 0;
    let conflicts = 0;
    const barrier = async () => {
      if (++arrivals === 2) bothEntered.resolve();
      await bothEntered.promise;
    };
    const stores = [0, 1].map(() => {
      const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
      ownedStores.push(eventStore);
      const writer = asAsyncEventWriter(eventStore);
      const guarded = requireGuardedEventAppender(writer, "test requires SQLite guarded writes");
      return createSessionMetadataStore({
        reader: asAsyncEventReadSurface(eventStore),
        writer: {
          ...writer,
          async appendGuarded(event) {
            await barrier();
            const result = await guarded.appendGuarded(event);
            if (result.kind === "conflict") conflicts++;
            return result;
          },
        },
      });
    });
    expect(await Promise.all([
      stores[0]!.updateLabel(id, { label: "New description" }, "user"),
      stores[1]!.updateLabel(id, { shortLabel: "New tab" }, "user"),
    ])).toEqual([true, true]);
    expect(conflicts).toBe(1);
    expect(await creator.readOrThrow(id)).toMatchObject({ label: "New description", shortLabel: "New tab", userNamed: true });
  });

  it("updates provider continuation metadata on ordinary conversations", async () => {
    const baseDir = makeTmpDir();
    const store = makeStore(baseDir);
    const id = await store.create({
      label: "Chat",
      name: "Chat",
      lifecycleState: "active",
      executionCwd: baseDir,
      lastUpdated: "2026-05-08T00:00:00.000Z",
      kind: "chat",
      command: "chat",
      conversationId: "tree-key-1",
    });

    await store.updateChatMetadata(id, { providerConversationId: "provider-1", seedContext: "seed" });

    const read = await store.readOrThrow(id);
    expect(read.kind).toBe("chat");
    if (read.kind !== "chat") throw new Error("expected chat");
    expect(read.conversationId).toBe("tree-key-1");
    expect(read.providerConversationId).toBe("provider-1");
    expect(read.seedContext).toBe("seed");
    const childId = await store.create({
      ...minimalSession(), kind: "subagent", command: "subagent",
      launchedFrom: { parentSessionId: id, conversationId: "tree-key-1", toolUseId: "dispatch" },
    });
    await store.updateChatMetadata(childId, { providerConversationId: "child-thread" });
    expect(await store.readOrThrow(childId)).toMatchObject({ kind: "subagent", providerConversationId: "child-thread", conversationId: "test-conversation" });
  });

  it("unlinks child sessions idempotently", async () => {
    const baseDir = makeTmpDir();
    const store = makeStore(baseDir);
    const childId = await store.create(minimalSession());
    const parentId = await store.create({
      label: "Chat",
      name: "Chat",
      lifecycleState: "active",
      executionCwd: baseDir,
      lastUpdated: "2026-05-08T00:00:00.000Z",
      kind: "chat",
      command: "chat",
      conversationId: "conv-parent",
      childSessionIds: [childId],
    });

    await store.unlinkChild(parentId, childId);
    await store.unlinkChild(parentId, childId);
    expect((await store.readOrThrow(parentId)).childSessionIds).toBeUndefined();
  });

  it("a session.deleted tombstone removes the row from the metadata projection", async () => {
    const baseDir = makeTmpDir();
    const store = makeStore(baseDir);
    const id = await store.create(minimalSession());

    // The production delete shape (SessionManager.delete): an unconditional
    // tombstone through the store's transactional append.
    await store.appendFacts([buildSessionMetadataAppend(id, {
      type: "session.deleted",
      version: 1,
      actor: "flywheel",
      payload: { lastUpdated: new Date().toISOString() },
    })]);

    expect(await store.read(id)).toBeNull();
    expect((await store.list()).entries).toEqual([]);
  });

  it("keeps schema validation strict", () => {
    expect(safeParse(SessionSchema, {
      ...minimalSession(),
      unknownField: "should fail",
    }).success).toBe(false);
  });
});
