import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type StoredFact } from "../../../../../src/infra/event-store-types.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import {
  collectSkillLoadRecords,
  collectSkillLoadStats,
  collectSkillWriteRecords,
  refreshSkillLoadStatsSnapshot,
  reviewForkInstruction,
  skillActivitySource,
} from "../../../../../src/orchestration/modules/learning/skill-load-stats.js";
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js";
import { countStateRequests, factsRead } from "../../../../helpers/state-requests.js";
interface UnknownObject {
  [key: string]: unknown;
}

function stored(type: string, payload: UnknownObject, overrides: Partial<StoredFact> = {}): StoredFact {
  return {
    position: 1,
    id: "e-1",
    aggregateId: "session:s-1",
    seq: 1,
    type,
    version: 1,
    timestamp: 1000,
    actor: "agent",
    sessionId: "s-1",
    payload,
    ...overrides,
  };
}

function toolInput(input: UnknownObject, overrides: Partial<StoredFact> = {}): StoredFact {
  return stored("tool.input.completed", {
    toolUseId: "use-1",
    toolName: "skill",
    input,
    inputBytes: 10,
    inputSha256: "x",
    inputPreview: "",
    executionMode: "sync",
    traceKind: "tool",
    childHasOwnViewport: false,
    modelRequestId: "req-1",
  }, overrides);
}

/** Each fact fixture carries the version the registry parses, because
 *  telemetry decodes Flywheel-owned facts strictly. */
const WRITTEN_V2 = { version: 2 } as const;

function reader(events: StoredFact[]): AsyncEventStateReadSurface {
  return asAsyncEventReadSurface(inMemoryEventReader(events));
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("collectSkillLoadStats", () => {
  it("counts loads per skill and keeps the newest timestamp", async () => {
    const stats = await collectSkillLoadStats(reader([
      toolInput({ action: "load", skill_id: "tui-scroll-regressions" }, { timestamp: 100 }),
      toolInput({ action: "load", skill_id: "tui-scroll-regressions" }, { timestamp: 300, sessionId: "s-2" }),
      toolInput({ action: "load", skill_id: "planning" }, { timestamp: 200 }),
    ]));
    expect(stats.get("tui-scroll-regressions")).toEqual({ loads: 2, lastLoadedAt: 300 });
    expect(stats.get("planning")).toEqual({ loads: 1, lastLoadedAt: 200 });
  });

  it("ignores non-load actions, other tools, and malformed inputs", async () => {
    const stats = await collectSkillLoadStats(reader([
      toolInput({ action: "list" }),
      toolInput({ action: "resource", skill_id: "planning", path: "references/x.md" }),
      toolInput({ action: "load" }),
      stored("tool.input.completed", { toolUseId: "u", toolName: "bash", input: { action: "load", skill_id: "planning" } }),
    ]));
    expect(stats.size).toBe(0);
  });
});

describe("incremental skill load stats", () => {
  it("starts from the latest snapshot and folds only later tool inputs", async () => {
    const snapshot = stored("skill.loads.snapshotted", {
      throughPosition: 100,
      stats: [{ skillId: "planning", loads: 4, lastLoadedAt: 90 }],
    }, { aggregateId: "session:skill-pruner", position: 101, version: 1, actor: "flywheel", sessionId: "skill-pruner" });
    const tail = toolInput({ action: "load", skill_id: "planning" }, { position: 120, timestamp: 110 });
    let readAfter = -1;
    const store: AsyncEventStateReadSurface = {
      ...reader([]),
      capturePosition: async () => 120,
      readLatestByAggregateAndTypes: async () => [snapshot],
      readPage: async (_query, upperPosition, afterPosition) => {
        readAfter = afterPosition;
        return { facts: [tail], upperPosition: upperPosition ?? 120, continuationPosition: null, toolContent: { resolve: () => null } };
      },
    };

    expect((await collectSkillLoadStats(store)).get("planning")).toEqual({ loads: 5, lastLoadedAt: 110 });
    expect(readAfter).toBe(100);
  });

  it("retains a serialized high-water mark and stable results between overlapping reads", async () => {
    const events = [toolInput({ action: "load", skill_id: "planning" }, { position: 10, timestamp: 10 })];
    const readPositions: number[] = [];
    const paused = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let captures = 0;
    const store: AsyncEventStateReadSurface = {
      ...reader([]),
      capturePosition: async () => { captures += 1; return events.at(-1)?.position ?? 0; },
      readPage: async (_query, upperPosition, afterPosition) => {
        const ceiling = upperPosition ?? await store.capturePosition();
        readPositions.push(afterPosition);
        const facts = events.filter((event) => event.position > afterPosition && event.position <= ceiling);
        if (readPositions.length === 2) {
          paused.resolve();
          await release.promise;
        }
        return { facts, upperPosition: ceiling, continuationPosition: null, toolContent: { resolve: () => null } };
      },
    };

    const initial = await collectSkillLoadStats(store);
    expect(initial.get("planning")?.loads).toBe(1);
    events.push(toolInput({ action: "load", skill_id: "planning" }, { position: 20, timestamp: 20 }));
    const first = collectSkillLoadStats(store);
    await paused.promise;
    const second = collectSkillLoadStats(store);
    expect(captures).toBe(2);
    events.push(toolInput({ action: "load", skill_id: "planning" }, { position: 30, timestamp: 30 }));
    release.resolve();
    const firstResult = await first;
    expect(firstResult.get("planning")).toEqual({ loads: 2, lastLoadedAt: 20 });
    expect((await second).get("planning")).toEqual({ loads: 3, lastLoadedAt: 30 });
    expect(initial.get("planning")).toEqual({ loads: 1, lastLoadedAt: 10 });
    expect(firstResult.get("planning")).toEqual({ loads: 2, lastLoadedAt: 20 });
    expect(readPositions).toEqual([0, 10, 20]);
    events.push(toolInput({ action: "load", skill_id: "planning" }, { position: 40, timestamp: 40 }));
    expect((await collectSkillLoadStats(store)).get("planning")?.loads).toBe(4);
    expect(readPositions).toEqual([0, 10, 20, 30]);
  });

  it.each([101, 102])("rejects a snapshot that claims position %i at or after its own position", async (throughPosition) => {
    const invalid = stored("skill.loads.snapshotted", {
      throughPosition,
      stats: [{ skillId: "planning", loads: 1, lastLoadedAt: 90 }],
    }, { aggregateId: "session:skill-pruner", position: 101, version: 1, actor: "flywheel", sessionId: "skill-pruner" });
    const store: AsyncEventStateReadSurface = {
      ...reader([]),
      readLatestByAggregateAndTypes: async () => [invalid],
    };

    await expect(collectSkillLoadStats(store)).rejects.toThrow("at or after its own position");
  });

  it("rejects duplicate ids in a snapshot", async () => {
    const invalid = stored("skill.loads.snapshotted", {
      throughPosition: 100,
      stats: [
        { skillId: "planning", loads: 1, lastLoadedAt: 90 },
        { skillId: "planning", loads: 2, lastLoadedAt: 100 },
      ],
    }, { aggregateId: "session:skill-pruner", position: 101, version: 1, actor: "flywheel", sessionId: "skill-pruner" });
    const store: AsyncEventStateReadSurface = {
      ...reader([]),
      readLatestByAggregateAndTypes: async () => [invalid],
    };

    await expect(collectSkillLoadStats(store)).rejects.toThrow("duplicate skill ids");
  });

  it("writes one replaceable snapshot and later refreshes fold only the tail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-skill-load-snapshot-"));
    tempDirs.push(dir);
    const store = createSqliteEventStore(join(dir, "events.sqlite"));
    const events = asAsyncEventWriter(store);
    const writer = createSessionFactWriter({ sessionId: "skill-pruner", writer: events });
    const appendLoad = (skillId: string, timestamp: number): void => {
      store.append({
        aggregateId: "session:s-1",
        type: "tool.input.completed",
        version: 1,
        timestamp,
        actor: "agent",
        sessionId: "s-1",
        payload: { toolUseId: `use-${timestamp}`, toolName: "skill", input: { action: "load", skill_id: skillId } },
      });
    };

    try {
      appendLoad("planning", 100);
      appendLoad("planning", 200);
      expect((await refreshSkillLoadStatsSnapshot(asAsyncEventReadSurface(store), writer, events)).get("planning")?.loads).toBe(2);

      appendLoad("planning", 300);
      expect((await refreshSkillLoadStatsSnapshot(asAsyncEventReadSurface(store), writer, events)).get("planning")?.loads).toBe(3);
      expect(store.read({ aggregateId: "session:skill-pruner", types: ["skill.loads.snapshotted"] })).toHaveLength(1);
    } finally {
      writer.dispose();
      store.close();
    }
  });

  it("counts 20,000 loads exactly, folds a 2,000-load tail, and reads the latest snapshot cold after a reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-skill-load-volume-"));
    tempDirs.push(dir);
    const file = join(dir, "events.sqlite");
    const store = createSqliteEventStore(file);
    const events = asAsyncEventWriter(store);
    const writer = createSessionFactWriter({ sessionId: "skill-pruner", writer: events });
    try {
      appendLoads(store, 0, 20_000);
      const surface = asAsyncEventReadSurface(store);
      expect((await collectSkillLoadStats(surface)).get("planning")).toEqual({ loads: 20_000, lastLoadedAt: 20_000 });
      await refreshSkillLoadStatsSnapshot(surface, writer, events);
      appendLoads(store, 20_000, 2_000);
      expect((await collectSkillLoadStats(surface)).get("planning")).toEqual({ loads: 22_000, lastLoadedAt: 22_000 });
    } finally {
      writer.dispose();
      store.close();
    }

    // A reopened store has a new read surface, so no in-process projection survives.
    const reopened = createSqliteEventStore(file);
    try {
      const surface = asAsyncEventReadSurface(reopened);
      const readAfter: number[] = [];
      const cold: AsyncEventStateReadSurface = {
        ...surface,
        readPage: (query, upperPosition, afterPosition, ...rest) => {
          readAfter.push(afterPosition);
          return surface.readPage(query, upperPosition, afterPosition, ...rest);
        },
      };
      expect((await collectSkillLoadStats(cold)).get("planning")).toEqual({ loads: 22_000, lastLoadedAt: 22_000 });
      expect(readAfter[0]).toBeGreaterThanOrEqual(20_000);
    } finally {
      reopened.close();
    }
  });

  it("yields between history pages and leaves a load committed during that yield to the next catch-up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-skill-load-yield-"));
    tempDirs.push(dir);
    const store = createSqliteEventStore(join(dir, "events.sqlite"));
    try {
      appendLoads(store, 0, 600);
      const surface = asAsyncEventReadSurface(store);
      let settled = false;
      const appendedDuringCatchUp = Promise.withResolvers<boolean>();
      // The direct adapter answers every page in microtasks, so this callback
      // runs before the catch-up settles only when the catch-up yields a task.
      setImmediate(() => {
        appendLoads(store, 600, 1);
        appendedDuringCatchUp.resolve(!settled);
      });
      const captured = await collectSkillLoadStats(surface).finally(() => { settled = true; });
      expect(await appendedDuringCatchUp.promise).toBe(true);
      expect(captured.get("planning")?.loads).toBe(600);
      expect((await collectSkillLoadStats(surface)).get("planning")?.loads).toBe(601);
      expect((await collectSkillLoadStats(surface)).get("planning")?.loads).toBe(601);
    } finally {
      store.close();
    }
  });
});

/** One batch is one SQLite transaction, which keeps volume fixtures fast. */
function appendLoads(store: ReturnType<typeof createSqliteEventStore>, start: number, count: number): void {
  store.appendBatch(Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return {
      aggregateId: "session:s-1",
      type: "tool.input.completed",
      version: 1,
      timestamp: index + 1,
      actor: "agent",
      sessionId: "s-1",
      payload: { toolUseId: `use-${index}`, toolName: "skill", input: { action: "load", skill_id: "planning" } },
    };
  }));
}

describe("skillActivitySource", () => {
  it.each([3, 60])("reads only changed activity while rechecking %i retained skills", async (history) => {
    const events = Array.from({ length: history }, (_, index) => stored("skill.loaded", {
      name: `skill-${index}`,
    }, { position: index + 1, timestamp: 1000 }));
    const counter = countStateRequests(reader(events));
    const source = await skillActivitySource(counter.reader);
    counter.take();

    events.push(stored("skill.loaded", {
      name: "skill-0",
    }, { position: history + 1, timestamp: 5000 }));
    expect(await source.latestActivity("skill-0")).toBe(5000);
    expect(source.activity.get("skill-0")).toBe(1000);
    const requests = counter.take();
    expect(factsRead(requests)).toBe(1);
    expect(requests).toHaveLength(1);
    expect(await source.latestActivity("skill-1")).toBe(1000);
    expect(factsRead(counter.take())).toBe(0);
  });

  it("advances snapshot loads and non-pruner writes without changing the opening map", async () => {
    const events = [stored("skill.loads.snapshotted", {
      throughPosition: 1, stats: [{ skillId: "alpha", loads: 1, lastLoadedAt: 1000 }],
    }, { aggregateId: "session:skill-pruner", position: 2, actor: "flywheel" })];
    const source = await skillActivitySource(reader(events));

    expect(source.activity.get("alpha")).toBe(1000);

    // The load a live session records after the pass opened.
    events.push(toolInput({ action: "load", skill_id: "alpha" }, { position: 3, seq: 2, timestamp: 5000 }));

    expect(await source.latestActivity("alpha")).toBe(5000);
    const write = {
      name: "alpha", action: "patched", reach: "project",
      origin: { kind: "user" },
      identity: { kind: "recorded", writeId: "write", proposalId: "proposal", packageIdentity: { sha256: "hash", bytes: 10 } },
      contentHash: "hash", description: "description",
    };
    events.push(stored("skill.written", write, { ...WRITTEN_V2, position: 4, timestamp: 6000 }));
    expect(await source.latestActivity("alpha")).toBe(6000);
    events.push(stored("skill.written", { ...write, action: "archived", origin: { kind: "pruner" } }, { ...WRITTEN_V2, position: 5, timestamp: 7000 }));
    expect(await source.latestActivity("alpha")).toBe(6000);
    // The opening map stays the plan the pass was measured against.
    expect(source.activity.get("alpha")).toBe(1000);
  });
});

describe("collectSkillLoadRecords", () => {
  it("returns the named skill's loads with session and request identities, newest first", async () => {
    const records = await collectSkillLoadRecords(reader([
      toolInput({ action: "load", skill_id: "planning" }, { timestamp: 100, sessionId: "s-1" }),
      toolInput({ action: "load", skill_id: "planning" }, { timestamp: 300, sessionId: "s-2" }),
      toolInput({ action: "load", skill_id: "other" }, { timestamp: 200 }),
    ]), "planning");
    expect(records).toEqual([
      { sessionId: "s-2", timestamp: 300, modelRequestId: "req-1" },
      { sessionId: "s-1", timestamp: 100, modelRequestId: "req-1" },
    ]);
  });
});

describe("collectSkillWriteRecords", () => {
  it("returns the named skill's writes with reach, origin, and package identity, newest first", async () => {
    const records = await collectSkillWriteRecords(reader([
      stored("skill.written", {
        name: "planning",
        action: "patched",
        reach: "project",
        origin: { kind: "review", reviewRunId: "rev-1" },
        identity: { kind: "recorded", writeId: "w-1", proposalId: "m-1", packageIdentity: { sha256: "p1", bytes: 10 } },
        contentHash: "h1",
        description: "d",
      }, { timestamp: 100, ...WRITTEN_V2 }),
      stored("skill.written", {
        name: "planning",
        action: "created",
        reach: "project",
        origin: { kind: "agent", sessionId: "s-9" },
        identity: { kind: "recorded", writeId: "w-0", proposalId: "m-0", packageIdentity: { sha256: "p0", bytes: 9 } },
        contentHash: "h0",
        description: "d",
      }, { timestamp: 50, sessionId: "s-9", ...WRITTEN_V2 }),
      stored("skill.written", {
        name: "other",
        action: "created",
        reach: "global",
        origin: { kind: "user" },
        identity: { kind: "recorded", writeId: "w-2", proposalId: "m-2", packageIdentity: { sha256: "p2", bytes: 8 } },
        contentHash: "h2",
        description: "d",
      }, { timestamp: 200, ...WRITTEN_V2 }),
    ]), "planning");
    expect(records).toEqual([
      { sessionId: "s-1", timestamp: 100, action: "patched", reach: "project", origin: "review:rev-1", contentHash: "h1", packageSha256: "p1" },
      { sessionId: "s-9", timestamp: 50, action: "created", reach: "project", origin: "session:s-9", contentHash: "h0", packageSha256: "p0" },
    ]);
  });
});

describe("reviewForkInstruction", () => {
  const loads = () => [
    toolInput({ action: "load", skill_id: "rare" }, { position: 1, timestamp: 100 }),
    ...Array.from({ length: 3 }, (_, index) => toolInput({ action: "load", skill_id: "hot" }, { position: index + 2, timestamp: 200 })),
  ];
  const all = () => true;

  it("appends a ranked load-count block for a review that can patch skills", async () => {
    const instruction = await reviewForkInstruction("Review.", all, reader(loads()));
    expect(instruction.startsWith("Review.\n\n## Skill load counts")).toBe(true);
    expect(instruction.indexOf("hot: 3 loads")).toBeLessThan(instruction.indexOf("rare: 1 load"));
  });

  it("adds nothing when the workspace has no recorded loads", async () => {
    expect(await reviewForkInstruction("Review.", all, reader([]))).toBe("Review.");
  });

  it("reads no load history and adds no block for a review without skill_manage", async () => {
    const counter = countStateRequests(reader(loads()));
    expect(await reviewForkInstruction("Review.", (term) => term !== "skill_manage", counter.reader)).toBe("Review.");
    expect(counter.take()).toHaveLength(0);
  });
});
