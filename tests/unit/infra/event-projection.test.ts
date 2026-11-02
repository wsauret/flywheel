import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { DebugLog, scanDebugLogFiles } from "../../../src/infra/debug-log";
import { Log } from "../../../src/infra/log";

import { createEventProjection, parseProjectionFact, reduceEvents } from "../../../src/infra/event-projection";
import { asAsyncEventReadSurface, type EventReader, type StoredFact } from "../../../src/infra/event-store-types";
import { InvariantViolation } from "../../../src/infra/invariant";
import { extractContent, resolveToolContentReference } from "../../../src/infra/tool-content";
import { inMemoryEventReader } from "../../helpers/in-memory-event-reader.js";

describe("parseProjectionFact", () => {
  test("throws InvariantViolation with schema-mismatch and stored event coordinates on parse failure", () => {
    const event: StoredFact = {
      position: 42,
      id: "evt_bad",
      aggregateId: "session:s1",
      seq: 3,
      type: "queue.created",
      version: 1,
      timestamp: 123,
      actor: "flywheel",
      sessionId: "s1",
      payload: {},
    };

    let caught: unknown;
    try {
      parseProjectionFact(event, () => {
        throw new Error("payload.queue is required");
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(InvariantViolation);
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof InvariantViolation)) throw new Error("expected InvariantViolation");
    const violation = caught;
    expect(violation.kind).toBe("schema-mismatch");
    expect(violation.eventType).toBe("queue.created");
    expect(violation.eventPosition).toBe(42);
    expect(violation.aggregateId).toBe("session:s1");
    expect(violation.detail).toContain("payload.queue is required");
  });
});

describe("createEventProjection", () => {
  interface PositionState {
    positions: number[]
  }

  const fact = (position: number): StoredFact => ({
    position, id: `evt_${position}`, aggregateId: "session:s1", seq: position - 1,
    type: "wanted", version: 1, timestamp: 1, actor: "test", sessionId: "s1", payload: {},
  })

  test("waits for a delayed seed and reads only its suffix", async () => {
    const seed = Promise.withResolvers<{ state: { positions: number[] }; position: number }>()
    const local = asAsyncEventReadSurface(inMemoryEventReader([fact(1), fact(2)]))
    const afterPositions: number[] = []
    const projection = createEventProjection({
      ...local,
      readPage: (...args: Parameters<typeof local.readPage>) => {
        afterPositions.push(args[2])
        return local.readPage(...args)
      },
    }, {
      seed: () => seed.promise,
      initialState: (): PositionState => ({ positions: [] }),
      reduce: (state, event) => ({ positions: [...state.positions, event.position] }),
    })
    const replay = projection.replay()
    expect(afterPositions).toEqual([])
    expect(projection.getState()).toEqual({ positions: [] })
    seed.resolve({ state: { positions: [1] }, position: 1 })
    expect(await replay).toEqual({ positions: [1, 2] })
    expect(afterPositions).toEqual([1])
  })

  test("routes a fact whose body its parser refuses to the family's salvage rule and folds the facts after it", async () => {
    const refused: StoredFact = { ...fact(2), version: 2 }
    const definition = {
      initialState: (): PositionState => ({ positions: [] }),
      reduce: (state: PositionState, event: StoredFact) => {
        parseProjectionFact(event, (value) => {
          if (value.version !== 1) throw new Error("Unexpected key")
          return value
        })
        return { positions: [...state.positions, event.position] }
      },
      reduceUnreadableFact: (state: PositionState, event: StoredFact, violation: InvariantViolation) =>
        ({ positions: [...state.positions, -event.position, violation.eventVersion ?? 0] }),
    }
    const events = [fact(1), refused, fact(3)]
    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(events)), definition)

    expect(await projection.replay()).toEqual({ positions: [1, -2, 2, 3] })
    expect(projection.getPosition()).toBe(3)
    expect(reduceEvents(events, definition)).toEqual({ positions: [1, -2, 2, 3] })
    // A failure that is not about the fact's own body still fails the fold.
    expect(() => reduceEvents(events, { ...definition, reduce: () => { throw new Error("broken reducer") } })).toThrow("broken reducer")
  })

  test("initial push reads older committed history in position order exactly once", async () => {
    const events = [fact(1), fact(2), fact(3)]
    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(events)), {
      initialState: (): PositionState => ({ positions: [] }),
      reduce: (state, event) => ({ positions: [...state.positions, event.position] }),
    })
    expect(await projection.apply([events[2]!, events[0]!])).toEqual({ positions: [1, 2, 3] })
    expect(await projection.apply(events[1]!)).toEqual({ positions: [1, 2, 3] })
    expect(await projection.replay()).toEqual({ positions: [1, 2, 3] })
  })

  test("advances selected aggregates together in committed order and ignores unrelated pushes", async () => {
    const events = [
      fact(1),
      { ...fact(2), aggregateId: "session:s2" },
      { ...fact(3), aggregateId: "session:other" },
    ]
    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(events)), {
      aggregateIds: ["session:s1", "session:s2"],
      initialState: (): PositionState => ({ positions: [] }),
      reduce: (state, event) => ({ positions: [...state.positions, event.position] }),
    })
    expect(await projection.replay()).toEqual({ positions: [1, 2] })
    events.push({ ...fact(4), aggregateId: "session:s2" })
    expect(await projection.apply(events[2]!)).toEqual({ positions: [1, 2] })
    expect(await projection.apply(events[3]!)).toEqual({ positions: [1, 2, 4] })
    events.push(fact(5))
    expect(await projection.replay()).toEqual({ positions: [1, 2, 4, 5] })
  })

  test("a replay asked for after a catch-up started never joins it", async () => {
    const events = [fact(1)]
    const local = asAsyncEventReadSurface(inMemoryEventReader(events))
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let firstPage = true
    const reader = {
      ...local,
      readPage: async (...args: Parameters<typeof local.readPage>) => {
        const page = local.readPage(...args)
        if (firstPage) {
          firstPage = false
          entered.resolve()
          await release.promise
        }
        return page
      },
    }
    const projection = createEventProjection(reader, {
      initialState: (): PositionState => ({ positions: [] }),
      reduce: (state, event) => ({ positions: [...state.positions, event.position] }),
    })
    const first = projection.replay()
    await entered.promise
    events.push(fact(2))
    const afterCommit = projection.replay()
    events.push(fact(3))
    const push = projection.apply(events[2]!)
    const afterPush = projection.replay()
    release.resolve()
    expect(await first).toEqual({ positions: [1] })
    expect(await afterCommit).toEqual({ positions: [1, 2, 3] })
    expect(await push).toEqual({ positions: [1, 2, 3] })
    expect(await afterPush).toEqual({ positions: [1, 2, 3] })
  })

  test.each(["valid", "missing", "hash", "bytes"] as const)("hydrates pushed content with %s evidence through the read authority", async (kind) => {
    const content = extractContent("é".repeat(2048))
    if (content.kind !== "reference") throw new Error("expected reference")
    const reference = { type: "text_reference", ...content.reference, bytes: content.reference.bytes + (kind === "bytes" ? 1 : 0) }
    const event = { ...fact(1), payload: { content: [reference] } }
    const rows = kind === "missing" ? [] : [{ ...content.row, content: kind === "hash" ? "x".repeat(content.row.bytes) : content.row.content }]
    const reader = asAsyncEventReadSurface(inMemoryEventReader([event], new Map([["s1", rows]])))
    const projection = createEventProjection(reader, {
      readsToolContent: true,
      initialState: () => ({ text: "" }),
      // The page carries bytes unproven; the hydration seam is where a reader
      // proves them, so the reducer resolves through it.
      reduce: (_state, stored, resolver) => ({ text: resolveToolContentReference(resolver, stored.sessionId, { ...content.reference, bytes: reference.bytes }, { eventType: stored.type, eventPosition: stored.position, aggregateId: stored.aggregateId }) }),
    })
    if (kind === "valid") expect(await projection.apply(event)).toEqual({ text: content.row.content })
    else await expect(projection.apply(event)).rejects.toBeInstanceOf(InvariantViolation)
  })

  test("only a projection that reads tool content asks for pages that carry it", async () => {
    const local = asAsyncEventReadSurface(inMemoryEventReader([fact(1)]))
    const modes: (string | undefined)[] = []
    const reader = { ...local, readPage: (...args: Parameters<typeof local.readPage>) => { modes.push(args[4]); return local.readPage(...args) } }
    const definition = { initialState: (): PositionState => ({ positions: [] }), reduce: (state: PositionState, event: StoredFact) => ({ positions: [...state.positions, event.position] }) }
    await createEventProjection(reader, definition).replay()
    await createEventProjection(reader, { ...definition, readsToolContent: true }).replay()
    expect(modes).toEqual(["deferred", "eager"])
  })

  test("content validation errors remain available to the historical reducer", async () => {
    const content = extractContent("x".repeat(3000))
    if (content.kind !== "reference") throw new Error("expected reference")
    const event = { ...fact(1), payload: { content: [{ type: "text_reference", ...content.reference }] } }
    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader([event])), {
      readsToolContent: true,
      initialState: () => ({ degraded: 0 }),
      reduce: (state, stored, resolver) => {
        try { resolveToolContentReference(resolver, stored.sessionId, content.reference, { eventType: stored.type, eventPosition: stored.position, aggregateId: stored.aggregateId }) }
        catch (error) {
          if (!(error instanceof InvariantViolation)) throw error
          return { degraded: state.degraded + 1 }
        }
        return state
      },
    })
    expect(await projection.replay()).toEqual({ degraded: 1 })
  })

  test.each([true, false])("a corrupt reference does not degrade valid shared content (bad first: %s)", async (badFirst) => {
    const content = extractContent("x".repeat(3000))
    if (content.kind !== "reference") throw new Error("expected reference")
    const references = [content.reference, { ...content.reference, bytes: content.reference.bytes + 1 }]
    if (badFirst) references.reverse()
    const events = references.map((reference, index) => ({
      ...fact(index + 1), payload: { content: [{ type: "text_reference", ...reference }] },
    }))
    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(events, new Map([["s1", [content.row]]]))), {
      readsToolContent: true,
      initialState: () => ({ valid: 0, degraded: 0 }),
      reduce: (state, stored, resolver) => {
        try {
          resolveToolContentReference(resolver, stored.sessionId, references[stored.position - 1]!, {
            eventType: stored.type, eventPosition: stored.position, aggregateId: stored.aggregateId,
          })
          return { ...state, valid: state.valid + 1 }
        } catch (error) {
          if (!(error instanceof InvariantViolation)) throw error
          return { ...state, degraded: state.degraded + 1 }
        }
      },
    })
    expect(await projection.replay()).toEqual({ valid: 1, degraded: 1 })
  })

  test("shares concurrent delayed catch-up and applies queued pushes once", async () => {
    const events = [{
      position: 1, id: "evt_1", aggregateId: "session:s1", seq: 0, type: "wanted",
      version: 1, timestamp: 1, actor: "test", sessionId: "s1", payload: {},
    }] satisfies StoredFact[]
    let reads = 0
    const local = asAsyncEventReadSurface(inMemoryEventReader(events))
    const reader = {
      ...local,
      readPage: async (...args: Parameters<typeof local.readPage>) => {
        reads += 1
        const page = local.readPage(...args)
        await Promise.resolve()
        if (reads === 1) events.push(pushed)
        return page
      },
    }
    const projection = createEventProjection(reader, {
      factTypes: ["wanted"],
      initialState: () => ({ seen: 0 }),
      reduce: (state) => ({ seen: state.seen + 1 }),
    })
    const pushed = { ...events[0]!, position: 2, id: "evt_2", seq: 1 }

    const first = projection.replay()
    const second = projection.replay()
    const push = projection.apply(pushed)

    expect(await first).toEqual({ seen: 1 })
    expect(await second).toEqual({ seen: 1 })
    expect(await push).toEqual({ seen: 2 })
    expect(reads).toBe(2)
  })

  test.each([1, 300])("captures a bounded upper position in the first page for %i facts", async (size) => {
    const events = Array.from({ length: size }, (_, index): StoredFact => ({
      position: index + 1, id: `evt_${index}`, aggregateId: "session:s1", seq: index,
      type: "wanted", version: 1, timestamp: 1, actor: "test", sessionId: "s1", payload: {},
    }))
    const local = asAsyncEventReadSurface(inMemoryEventReader(events))
    const bounds: (number | undefined)[] = []
    const requests: string[] = []
    const projection = createEventProjection({
      ...local,
      capturePosition: () => {
        requests.push("position.capture")
        return local.capturePosition()
      },
      readPage: async (...args: Parameters<typeof local.readPage>) => {
        requests.push("facts.page")
        bounds.push(args[1])
        const page = await local.readPage(...args)
        if (bounds.length === 1) events.push({ ...events[0]!, position: size + 1, id: `evt_${size}`, seq: size })
        return page
      },
    }, {
      factTypes: ["wanted"],
      initialState: () => ({ seen: 0 }),
      reduce: (state) => ({ seen: state.seen + 1 }),
    })
    const replay = projection.replay()

    expect(await replay).toEqual({ seen: size })
    expect(requests).toEqual(size === 1 ? ["facts.page"] : ["facts.page", "facts.page"])
    expect(bounds).toEqual(size === 1 ? [undefined] : [undefined, size])
    expect(projection.getReadPosition()).toBe(size)
    expect(await projection.replay()).toEqual({ seen: size + 1 })
  })

  test("lets a scheduled task run between catch-up pages", async () => {
    let scheduledTaskRan = false
    let page = 0
    const projection = createEventProjection({
      capturePosition: async () => 3,
      readPage: async () => {
        page += 1
        return {
          facts: [fact(page)],
          upperPosition: 3,
          continuationPosition: page < 3 ? page : null,
          toolContent: { resolve: () => null },
        }
      },
    }, {
      initialState: (): PositionState => ({ positions: [] }),
      reduce: (state, event) => ({ positions: [...state.positions, event.position] }),
    })

    const replay = projection.replay()
    const scheduled = Bun.sleep(0).then(() => { scheduledTaskRan = true })

    expect(await replay).toEqual({ positions: [1, 2, 3] })
    expect(scheduledTaskRan).toBe(true)
    await scheduled
  })


  test("a push that matches no filtered type makes no read, and the next matching push reads the whole gap once", async () => {
    const events: StoredFact[] = []
    const local = asAsyncEventReadSurface(inMemoryEventReader(events))
    const afterPositions: number[] = []
    let captures = 0
    const projection = createEventProjection({
      capturePosition: () => {
        captures += 1
        return local.capturePosition()
      },
      readPage: (...args: Parameters<typeof local.readPage>) => {
        afterPositions.push(args[2])
        return local.readPage(...args)
      },
    }, {
      factTypes: ["wanted"],
      initialState: () => ({ seen: 0 }),
      reduce: (state) => ({ seen: state.seen + 1 }),
    })

    for (const position of [10, 20, 30, 40, 50]) {
      const ignored = { ...fact(position), type: "ignored" }
      events.push(ignored)
      await projection.apply(ignored)
    }
    expect(afterPositions).toEqual([])
    expect(projection.getReadPosition()).toBe(0)

    // Another writer commits the matching fact at 60, which this owner never sees.
    events.push(fact(60), fact(70))
    await projection.apply(events.at(-1)!)
    expect(afterPositions).toEqual([0])
    expect(projection.getState()).toEqual({ seen: 2 })
    expect(projection.getPosition()).toBe(70)
    expect(projection.getReadPosition()).toBe(70)
    // Replay captures its ceiling in the page instead of a separate request.
    expect(captures).toBe(0)
    expect(await projection.replay()).toEqual({ seen: 2 })
    expect(captures).toBe(0)
    expect(afterPositions).toEqual([0, 70])
  })

  test("does not let ignored out-of-order events skip later relevant events", async () => {
    const events: StoredFact[] = [fact(1)];
    const reader: EventReader = inMemoryEventReader(events);

    const projection = createEventProjection(asAsyncEventReadSurface(reader), {
      factTypes: ["wanted"],
      initialState: () => ({ seen: 0 }),
      reduce: (state) => ({ seen: state.seen + 1 }),
    });

    await projection.apply({
      position: 2,
      id: "evt_ignored",
      aggregateId: "session:s1",
      seq: 0,
      type: "ignored",
      version: 1,
      timestamp: 123,
      actor: "test",
      sessionId: "s1",
      payload: {},
    });
    await projection.apply({
      position: 1,
      id: "evt_wanted",
      aggregateId: "session:s1",
      seq: 0,
      type: "wanted",
      version: 1,
      timestamp: 123,
      actor: "test",
      sessionId: "s1",
      payload: {},
    });

    expect(projection.getState()).toEqual({ seen: 1 });
  });

  test.each([false, true])("a reducer failure publishes the folded prefix and the retry resumes at the failing fact (draft: %p)", async (useDraft) => {
    const events = [fact(1), fact(2), fact(3)]
    let failAt: number | undefined = 2
    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(events)), {
      initialState: (): PositionState => ({ positions: [] }),
      ...(useDraft ? { draft: (state: PositionState) => ({ positions: [...state.positions] }) } : {}),
      reduce: (state, event) => {
        if (event.position === failAt) throw new Error("reducer failed")
        if (!useDraft) return { positions: [...state.positions, event.position] }
        state.positions.push(event.position)
        return state
      },
    })
    await expect(projection.replay()).rejects.toThrow("reducer failed")
    const prefix = projection.getState()
    expect(prefix).toEqual({ positions: [1] })
    expect(projection.getPosition()).toBe(1)

    failAt = undefined
    expect(await projection.replay()).toEqual({ positions: [1, 2, 3] })
    expect(projection.getPosition()).toBe(3)
    expect(prefix).toEqual({ positions: [1] })
  });
});

describe("catch-up logging volume", () => {
  const TMP_ROOT = path.join(os.tmpdir(), `flywheel-projection-log-test-${process.pid}`);
  const roots = new Set<string>();

  function makeTmpDir(): string {
    const dir = path.join(TMP_ROOT, crypto.randomUUID());
    roots.add(dir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function catchUpRecords(baseDir: string): string[] {
    const logDir = path.join(baseDir, ".flywheel", "log");
    const files = fs.readdirSync(logDir).filter((n) => n.endsWith(".jsonl")).map((n) => path.join(logDir, n));
    return [...scanDebugLogFiles(files)]
      .map((record) => {
        const payload: { message?: unknown } = record.payload ?? {};
        return typeof payload.message === "string" ? payload.message : "";
      })
      .filter((message) => message.startsWith("projection catch-up"));
  }

  function factsFor(count: number): StoredFact[] {
    return Array.from({ length: count }, (_, i) => ({
      position: i + 1,
      id: `evt_${i}`,
      aggregateId: "session:s1",
      seq: i + 1,
      type: "noted",
      version: 1,
      timestamp: 1,
      actor: "flywheel",
      sessionId: "s1",
      payload: {},
    }));
  }

  const counting = { initialState: () => ({ n: 0 }), reduce: (state: { n: number }) => ({ n: state.n + 1 }) };

  afterEach(async () => {
    await DebugLog.close();
    await Log.init({ dir: makeTmpDir(), level: "INFO" });
    await DebugLog.close();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    roots.clear();
  });

  afterAll(() => {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  });

  test("a small routine fold writes no record at the default level", async () => {
    const baseDir = makeTmpDir();
    await Log.init({ dir: baseDir, level: "INFO" });

    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(factsFor(5))), counting);
    expect((await projection.replay()).n).toBe(5);
    await DebugLog.close();

    expect(catchUpRecords(baseDir)).toEqual([]);
  });

  test("a fast fold of many events writes no record at the default level", async () => {
    const baseDir = makeTmpDir();
    await Log.init({ dir: baseDir, level: "INFO" });

    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(factsFor(200))), counting);
    expect((await projection.replay()).n).toBe(200);
    await DebugLog.close();

    expect(catchUpRecords(baseDir)).toEqual([]);
  });

  test("a replay from the start over a large event count records one completion at the default level", async () => {
    const baseDir = makeTmpDir();
    await Log.init({ dir: baseDir, level: "INFO" });

    // A projection rebuilt from the start on every store change is the
    // replay starvation this record keeps visible, however fast each fold is.
    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(factsFor(1_000))), counting);
    expect((await projection.replay()).n).toBe(1_000);
    await DebugLog.close();

    expect(catchUpRecords(baseDir)).toEqual(["projection catch-up done"]);
  });

  test("a fold slow enough to explain a pause records one completion at the default level", async () => {
    const baseDir = makeTmpDir();
    await Log.init({ dir: baseDir, level: "INFO" });
    let now = 0;
    // Each clock read moves on a second, so the fold's start and end are far apart.
    const clock = spyOn(performance, "now").mockImplementation(() => { now += 1_000; return now; });
    try {
      const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(factsFor(5))), counting);
      expect((await projection.replay()).n).toBe(5);
    } finally {
      clock.mockRestore();
    }
    await DebugLog.close();

    expect(catchUpRecords(baseDir)).toEqual(["projection catch-up done"]);
  });

  test("the routine fold is recoverable at DEBUG without idle replay records", async () => {
    const baseDir = makeTmpDir();
    await Log.init({ dir: baseDir, level: "DEBUG" });

    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(factsFor(5))), counting);
    expect((await projection.replay()).n).toBe(5);
    expect((await projection.replay()).n).toBe(5);
    expect((await projection.replay()).n).toBe(5);
    await DebugLog.close();

    expect(catchUpRecords(baseDir)).toEqual(["projection catch-up done"]);
  });
});
