import { describe, it, expect, afterEach } from "bun:test";

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import { asAsyncEventReadSurface, type AsyncEventReadSurface } from "../../../../src/infra/event-store-types";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import { createSessionBudgetStore } from "../../../../src/orchestration/session/budget-store";
import type { EmitFn } from "../../../../src/infra/event-bus";
import { skillLoadedFact } from "../../../../src/workflows/skill-facts";
import { countStateRequests } from "../../../helpers/state-requests";

import {
  cleanupTmpRoot,
  readBudgetSummary,
  makeTmpDir,
  newSessionId,
  noopEmitter,
  makeSessionBudgetStore,
  makeSessionStores,
} from "./_budget-store-fixtures";

afterEach(() => {
  cleanupTmpRoot();
});

describe("SessionBudgetStore durable projection", () => {
  it("hydrates and advances one registered budget projection through an async-only source", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const aggregateId = `session:${sessionId}`;
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
    const common = { aggregateId, version: 1, timestamp: Date.now(), sessionId };

    store.append({
      ...common,
      type: "model.turn.completed",
      actor: "provider",
      payload: {
        isError: false,
        totalCostUsd: 0.10,
        usage: { input_tokens: 5000, output_tokens: 2000 },
      },
    });
    store.append({
      ...common,
      type: "model.turn.completed",
      actor: "provider",
      payload: {
        isError: false,
        totalCostUsd: 0.25,
        usage: { input_tokens: 8000, output_tokens: 3000 },
      },
    });
    store.append({
      ...common,
      type: "budget.invocation.recorded",
      actor: "flywheel",
      payload: { count: 2 },
    });
    store.append({
      ...common,
      type: "model.context.measured",
      actor: "provider",
      payload: { promptTokens: 90_000, contextWindow: 1_000_000 },
    });
    const local = asAsyncEventReadSurface(store);
    const afterPositions: number[] = [];
    const source: AsyncEventReadSurface = {
      capturePosition: local.capturePosition,
      async readPage(query, upperPosition, afterPosition, tolerant) {
        afterPositions.push(afterPosition);
        return local.readPage(query, upperPosition, afterPosition, tolerant);
      },
    };
    const budgetStore = createSessionBudgetStore({
      sessionId,
      emitter: noopEmitter,
      reader: source,
      recorder: async () => null,
    });

    expect(await budgetStore.getTotalCost()).toBeCloseTo(0.25, 10);
    expect(await budgetStore.getTokensUsed()).toBe(11000);
    expect(await budgetStore.getInvocationsUsed()).toBe(2);
    expect(await budgetStore.getContextUtilization()).toEqual({
      promptTokens: 90_000,
      contextWindow: 1_000_000,
      percent: 9,
    });
    const initialReadCount = afterPositions.length;
    store.append({
      ...common,
      type: "budget.invocation.recorded",
      actor: "flywheel",
      payload: { count: 1 },
    });
    const reused = createSessionBudgetStore({
      sessionId,
      emitter: noopEmitter,
      reader: source,
      recorder: async () => null,
    });
    expect(await reused.getInvocationsUsed()).toBe(3);
    expect(afterPositions).toHaveLength(initialReadCount + 1);
    expect(afterPositions.at(-1)).toBeGreaterThan(0);
    reused.dispose();
    budgetStore.dispose();
    store.close();
  });

  it("reads the compaction trigger of the latest context measurement, and none from a fact of the previous shape", async () => {
    const sessionId = newSessionId();
    const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()));
    const common = { aggregateId: `session:${sessionId}`, version: 1, timestamp: Date.now(), sessionId, type: "model.context.measured", actor: "provider" } as const;
    const budgetStore = createSessionBudgetStore({ sessionId, emitter: noopEmitter, reader: asAsyncEventReadSurface(store), recorder: async () => null });

    // The shape before the trigger existed.
    await budgetStore.applyStoredFact(store.append({ ...common, payload: { promptTokens: 100, contextWindow: 1000 } }));
    expect(await budgetStore.getContextUtilization()).toEqual({ promptTokens: 100, contextWindow: 1000, percent: 10 });

    await budgetStore.applyStoredFact(store.append({ ...common, payload: { promptTokens: 100, contextWindow: 1000, compactionTriggerTokens: 850 } }));
    expect(await budgetStore.getContextUtilization()).toEqual({ promptTokens: 100, contextWindow: 1000, percent: 10, compactionTriggerTokens: 850 });

    await budgetStore.applyStoredFact(store.append({ ...common, payload: { promptTokens: 200, contextWindow: 1000, compactionTriggerTokens: 0 } }));
    expect(await budgetStore.getContextUtilization()).toEqual({ promptTokens: 200, contextWindow: 1000, percent: 20, compactionTriggerTokens: 0 });

    await budgetStore.applyStoredFact(store.append({ ...common, payload: { promptTokens: 300, contextWindow: 1000 } }));
    expect(await budgetStore.getContextUtilization()).toEqual({ promptTokens: 300, contextWindow: 1000, percent: 30 });
    budgetStore.dispose();
    store.close();
  });

  it.each([3, 30])("makes no state read for %p pushed facts that directly follow its history, and reads once at a gap another writer left", async (count) => {
    const sessionId = newSessionId();
    const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()));
    const common = { aggregateId: `session:${sessionId}`, version: 1, timestamp: Date.now(), sessionId };
    const counter = countStateRequests(asAsyncEventReadSurface(store));
    const metrics: unknown[] = [];
    const emitter: EmitFn = (type, input) => {
      if (type === "budget.metrics.changed") metrics.push(input.data);
    };
    const budgetStore = createSessionBudgetStore({ sessionId, emitter, reader: counter.reader, recorder: async () => null });
    await budgetStore.applyStoredFact(store.append({ ...common, type: "model.context.measured", actor: "provider", payload: { promptTokens: 100, contextWindow: 1000 } }));
    counter.take();
    metrics.length = 0;

    // Each record of the session writer awaits this push, so a read here
    // delays every fact of the session behind the state reads of other writers.
    for (let index = 0; index < count; index += 1) {
      await budgetStore.applyStoredFact(store.append({ ...common, ...skillLoadedFact({ name: `skill-${index}` }) }));
    }
    expect(counter.take()).toEqual([]);
    expect(metrics).toEqual([]);

    // The writer's own budget facts directly follow the history this store
    // has accounted for, so each folds from its push without a read.
    for (let index = 1; index <= count; index += 1) {
      await budgetStore.applyStoredFact(store.append({ ...common, type: "model.context.measured", actor: "provider", payload: { promptTokens: 100 + index, contextWindow: 1000 } }));
    }
    expect(counter.take()).toEqual([]);
    expect(metrics).toHaveLength(count);
    expect(metrics.at(-1)).toMatchObject({ contextPromptTokens: 100 + count });
    metrics.length = 0;

    // Another writer commits usage that this store is never told about.
    store.append({ ...common, type: "model.turn.completed", actor: "provider", payload: { isError: false, totalCostUsd: 0.25, usage: { input_tokens: 800, output_tokens: 200 } } });
    await budgetStore.applyStoredFact(store.append({ ...common, type: "model.context.measured", actor: "provider", payload: { promptTokens: 500, contextWindow: 1000 } }));
    expect(counter.take().map((request) => request.method)).toEqual(["readPage"]);
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ tokens: 1000, cost: 0.25, contextPercent: 50, contextPromptTokens: 500 });
    budgetStore.dispose();
    store.close();
  });

  it("persists context-only updates", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const budgetStore = makeSessionBudgetStore(baseDir, sessionId);

    await budgetStore.recordContextUtilization(90_000, 1_000_000);

    expect(await readBudgetSummary(sessionId, baseDir)).toMatchObject({
      contextPromptTokens: 90_000,
      contextPercent: 9,
    });
    budgetStore.dispose();
  });

  it("ignores subagent-attributed context measurements", async () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const budgetStore = makeSessionBudgetStore(baseDir, sessionId);

    await budgetStore.recordContextUtilization(90_000, 1_000_000);
    await budgetStore.recordRuntimeEvent({
      type: "model.context.measured",
      data: {
        type: "model.context.measured",
        context_prompt_tokens: 250_000,
        context_window: 922_000,
        parent_tool_use_id: "toolu_subagent",
      },
    });

    expect(await budgetStore.getContextUtilization()).toEqual({
      promptTokens: 90_000,
      contextWindow: 1_000_000,
      percent: 9,
    });
    expect((await readBudgetSummary(sessionId, baseDir)).contextPercent).toBe(9);
    budgetStore.dispose();
  });

  it("ignores recorder nulls after writer dispose", () => {
    const baseDir = makeTmpDir();
    const sessionId = newSessionId();
    const stores = makeSessionStores(baseDir, sessionId);
    const budgetStore = createSessionBudgetStore({ sessionId, emitter: noopEmitter, reader: stores.projectionReader, recorder: stores.record });
    stores.writer.dispose();

    expect(() => budgetStore.recordInvocation()).not.toThrow();
    expect(stores.store.read({ aggregateId: `session:${sessionId}` })).toHaveLength(0);

    budgetStore.dispose();
    stores.close();
  });
});
