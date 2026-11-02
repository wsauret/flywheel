import { describe, expect, test } from "bun:test";

import { createEventProjection } from "../../../src/infra/event-projection";
import { asAsyncEventReadSurface, type CorruptEventRowError, type StoredFact } from "../../../src/infra/event-store-types";
import { inMemoryEventReader } from "../../helpers/in-memory-event-reader.js";

/** A test family whose every `reset` fact is a root that resets at its position. */
function newestReset(facts: readonly (StoredFact | CorruptEventRowError)[]): number | undefined {
  return facts.findLast((fact) => "type" in fact && fact.type === "reset")?.position;
}

describe("createEventProjection reset boundary", () => {
  test.each(["apply", "replay"] as const)("invalidates state when %s rejects a reset boundary and recovers at a later root", async (method) => {
    const workflowFact = (position: number, type = "value"): StoredFact => ({
      aggregateId: "workflow:s1", sessionId: "s1", id: `event-${position}`,
      seq: position - 1, position, timestamp: 1, actor: "test", type, version: 1, payload: {},
    });
    const events = [workflowFact(1)];
    const failure = new Error("invalid current root");
    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(events)), {
      aggregateId: "workflow:s1",
      factTypes: ["value"],
      resetBoundary: {
        types: ["reset"],
        read: () => undefined,
        within: (facts) => {
          const root = newestReset(facts);
          if (root === 2) throw failure;
          return root;
        },
      },
      initialState: () => ({ seen: 0 }),
      reduce: (state) => ({ seen: state.seen + 1 }),
    });
    const oldSnapshot = await projection.replay();
    expect(oldSnapshot).toEqual({ seen: 1 });
    // A root commits with its companions in one batch.
    const invalidRoot = [workflowFact(2, "reset"), workflowFact(3)];
    events.push(...invalidRoot);
    await expect(method === "apply" ? projection.apply(invalidRoot) : projection.replay()).rejects.toBe(failure);
    expect(projection.getState()).toEqual({ seen: 0 });
    expect(projection.getPosition()).toBe(1);
    expect(oldSnapshot).toEqual({ seen: 1 });
    await expect(projection.replay()).rejects.toBe(failure);
    const repair = [workflowFact(4, "reset"), workflowFact(5)];
    events.push(...repair);
    expect(await (method === "apply" ? projection.apply(repair) : projection.replay())).toEqual({ seen: 1 });
    expect(projection.getPosition()).toBe(5);
    expect(await projection.replay()).toEqual({ seen: 1 });
  });

  test("probes the root once, resets at a root in the page it folds, and makes no read for ignored members", async () => {
    let probes = 0;
    let validations = 0;
    const events: StoredFact[] = [];
    const projection = createEventProjection(asAsyncEventReadSurface(inMemoryEventReader(events)), {
      aggregateId: "workflow:s1",
      factTypes: ["value"],
      resetBoundary: {
        types: ["reset"],
        read: () => { probes += 1; return undefined; },
        within: (facts) => { validations += 1; return newestReset(facts); },
      },
      initialState: () => ({ seen: 0 }),
      reduce: (state) => ({ seen: state.seen + 1 }),
    });
    const workflowFact = (position: number, type = "value"): StoredFact => ({
      aggregateId: "workflow:s1", sessionId: "s1", id: `event-${position}`,
      seq: position - 1, position, timestamp: 1, actor: "test", type, version: 1, payload: {},
    });
    const batch = Array.from({ length: 100 }, (_, index) => workflowFact(index + 1));
    events.push(...batch);
    validations = 0;
    await projection.apply(batch);
    expect(projection.getState()).toEqual({ seen: 100 });
    expect(validations).toBe(1);
    await projection.apply([workflowFact(300, "ignored"), { ...workflowFact(400), aggregateId: "other" }]);
    expect(validations).toBe(1);
    expect(projection.getPosition()).toBe(100);
    expect(projection.getReadPosition()).toBe(100);
    events.push(workflowFact(301));
    await projection.apply(events.at(-1)!);
    expect(projection.getState()).toEqual({ seen: 101 });
    events.push(workflowFact(500, "reset"), workflowFact(501));
    validations = 0;
    await projection.apply(events.slice(-2));
    expect(validations).toBe(1);
    expect(projection.getState()).toEqual({ seen: 1 });
    expect(projection.getPosition()).toBe(501);
    expect(probes).toBe(1);
  });

  test("resets before folding superseded rows, cold or live, and preserves held snapshots and workspace positions", async () => {
    const events: StoredFact[] = [];
    const reader = inMemoryEventReader(events);
    let probed: number | undefined = undefined;
    const afterPositions: Array<number | undefined> = [];
    const definition = {
      aggregateId: "workflow:s1",
      factTypes: ["value"],
      resetBoundary: { types: ["reset"], read: () => probed, within: newestReset },
      initialState: () => ({ seen: 0 }),
      reduce: (state: { seen: number }, event: StoredFact) => {
        if (event.payload.poison) throw new Error("superseded poison");
        return { seen: state.seen + 1 };
      },
    };
    const surface = asAsyncEventReadSurface({
      ...reader,
      read: (query = {}) => {
        afterPositions.push(query.afterPosition);
        return reader.read(query);
      },
    });
    const projection = createEventProjection(surface, definition);
    const workflowFact = (position: number, type = "value"): StoredFact => ({
      aggregateId: "workflow:s1", sessionId: "s1", id: `event-${position}`,
      seq: position / 10 - 1, position, timestamp: 1, actor: "test", type, version: 1, payload: {},
    });
    events.push(workflowFact(10));
    const snapshot = await projection.replay();
    events.push({ ...workflowFact(20), payload: { poison: true } }, workflowFact(30, "reset"), workflowFact(40));
    expect(await projection.replay()).toEqual({ seen: 1 });
    expect(afterPositions).toEqual([0, 10]);
    expect(projection.getPosition()).toBe(40);
    expect(snapshot).toEqual({ seen: 1 });
    events.push(workflowFact(50, "reset"), workflowFact(60));
    await projection.apply(events.slice(-2));
    expect(projection.getState()).toEqual({ seen: 1 });
    expect(projection.getPosition()).toBe(60);
    expect(snapshot).toEqual({ seen: 1 });

    // A cold projection starts at the probed root, so it never reads the poison.
    probed = 30;
    afterPositions.length = 0;
    expect(await createEventProjection(surface, definition).replay()).toEqual({ seen: 1 });
    expect(afterPositions).toEqual([30]);
  });
});
