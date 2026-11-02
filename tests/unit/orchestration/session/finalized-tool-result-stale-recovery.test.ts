import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types";
import { createConversationTreeWriter } from "../../../../src/orchestration/session/conversation/conversation-tree-writer";
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle";
import type { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree";
import { recoverFinalizedToolResultCheckpoints, retireLegacyFinalizedToolResultCheckpoints } from "../../../../src/orchestration/session/finalized-tool-result-checkpoint";
import { buildMutationEvidence, buildMutationFileEvidence } from "../../../../src/infra/mutation-evidence";
import { hydrateToolContentFact } from "../../../../src/infra/tool-content-hydration";
import { buildMutationDiff } from "../../../../src/infra/mutation-diff";
import { retireRecordedFinalizedToolResultCheckpointPage } from "../../../../src/orchestration/migrations/finalized-tool-result-checkpoints";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import {
  assistantToolUseMessage,
  createSavePointContext,
  disposeSavePointContext,
  userMessage,
  toolResultMessage,
  type SavePointTestContext,
} from "./_save-point-fixtures";

let ctx: SavePointTestContext;
let tree: ConversationTree;

beforeEach(async () => {
  ctx = await createSavePointContext();
  tree = ctx.tree;
});

afterEach(async () => {
  await disposeSavePointContext(ctx);
});

async function attachingProcess(): Promise<ConversationTree> {
  const fresh = await tryOpenConversationTree({
    conversationId: ctx.conversationId,
    sessionId: ctx.sessionId,
    store: asAsyncEventReadSurface(ctx.store),
    writer: asAsyncEventWriter(ctx.store),
  });
  if (!fresh) throw new Error(`expected conversation tree ${ctx.conversationId}`);
  return fresh;
}

describe("finalized tool result checkpoint recovery", () => {
  it("preserves recorded results that still owe a canonical conversation result", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("read"));
    writer.beginTurn();
    await writer.enqueueMessage(assistantToolUseMessage("current"));
    await writer.flushSavePoint(new Set(["current"]));
    ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", `${ctx.conversationId}:current`, {
      version: 2, conversationId: ctx.conversationId, toolUseId: "current", toolName: "read",
      budgetExempt: true, registrationOrdinal: 0, content: [{ type: "text", text: "recovered output" }], outcome: "ok",
    });
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`, sessionId: ctx.sessionId, type: "tool.result.recorded",
      version: 1, actor: "flywheel", timestamp: Date.now(), payload: { toolUseId: "current", outcome: "ok" },
    });
    retireRecordedFinalizedToolResultCheckpointPage(resolveEventStoreDbFile(ctx.baseDir));
    const resumed = await attachingProcess();
    try {
      await recoverFinalizedToolResultCheckpoints({
        conversationId: ctx.conversationId, sessionId: ctx.sessionId,
        store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store), tree: resumed,
      });
      expect((await resumed.getBranch()).filter(entry => entry.kind === "message" && entry.message.kind === "toolResult")).toHaveLength(1);
    } finally {
      resumed.getStorage().dispose();
    }
  });

  it("converts durable canonical results and preserves missing evidence and unknown cells", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("read"));
    writer.beginTurn();
    await writer.enqueueMessage(assistantToolUseMessage("recorded", "missing-output", "nested"));
    await writer.enqueueMessage(toolResultMessage("recorded", "output"));
    await writer.enqueueMessage(toolResultMessage("missing-output", "output"));
    await writer.enqueueMessage(toolResultMessage("nested", "output"));
    await writer.flushSavePoint();
    for (const toolUseId of ["recorded", "unrecorded", "unknown-result", "missing-output", "nested"]) {
      ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", `${ctx.conversationId}:${toolUseId}`, {
        version: 2, conversationId: ctx.conversationId, toolUseId, toolName: "read",
        budgetExempt: true, registrationOrdinal: 0, content: [{ type: "text", text: "output" }], outcome: "ok",
        ...(toolUseId === "missing-output" ? { executionOutputTail: "evidence" } : {}),
        ...(toolUseId === "nested" ? { parentToolUseId: "parent" } : {}),
      });
    }
    ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", `${ctx.conversationId}:unknown`, { version: 999 });
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`, sessionId: ctx.sessionId, type: "tool.result.recorded",
      version: 1, actor: "flywheel", timestamp: Date.now(), payload: { toolUseId: "nested", outcome: "ok", parentToolUseId: "parent" },
    });
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`, sessionId: ctx.sessionId, type: "tool.result.recorded",
      version: 1, actor: "flywheel", timestamp: Date.now(), payload: { toolUseId: "missing-output", outcome: "ok" },
    });
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`, sessionId: ctx.sessionId, type: "tool.result.recorded",
      version: 1, actor: "flywheel", timestamp: Date.now(), payload: { toolUseId: "recorded", outcome: "ok" },
    });
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`, sessionId: ctx.sessionId, type: "tool.result.recorded",
      version: 999, actor: "flywheel", timestamp: Date.now(), payload: { toolUseId: "unknown-result", outcome: "ok" },
    });
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`, sessionId: ctx.sessionId, type: "tool.result.recorded",
      version: 1, actor: "flywheel", timestamp: Date.now(), payload: { toolUseId: "unknown", outcome: "ok" },
    });
    expect(retireRecordedFinalizedToolResultCheckpointPage(resolveEventStoreDbFile(ctx.baseDir)).retired).toBe(2);
    expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result").map(row => row.key)).toEqual([
      `${ctx.conversationId}:unrecorded`, `${ctx.conversationId}:unknown-result`, `${ctx.conversationId}:missing-output`, `${ctx.conversationId}:unknown`,
    ]);
    expect(retireRecordedFinalizedToolResultCheckpointPage(resolveEventStoreDbFile(ctx.baseDir)).retired).toBe(0);
  });

  it("retires completed bare-key historical cells without discarding incomplete or unknown cells", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("read"));
    writer.beginTurn();
    await writer.enqueueMessage(assistantToolUseMessage("recorded", "missing-output"));
    await writer.enqueueMessage(toolResultMessage("recorded", "output"));
    await writer.enqueueMessage(toolResultMessage("missing-output", "output"));
    await writer.flushSavePoint();
    for (const toolUseId of ["recorded", "unrecorded", "missing-output"]) {
      ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", toolUseId, {
        toolUseId, content: [{ type: "text", text: "output" }], outcome: "ok",
        ...(toolUseId === "missing-output" ? { executionOutputTail: "tail" } : {}),
      });
      ctx.store.append({
        aggregateId: `session:${ctx.sessionId}`, sessionId: ctx.sessionId, type: "tool.result.recorded",
        version: 1, actor: "flywheel", timestamp: Date.now(), payload: { toolUseId, outcome: "ok" },
      });
    }
    ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", "unknown", { version: 999 });
    await recoverFinalizedToolResultCheckpoints({
      conversationId: ctx.conversationId, sessionId: ctx.sessionId,
      store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store), tree,
    });
    expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result").map(row => row.key))
      .toEqual(["recorded", "unrecorded", "missing-output", "unknown"]);
    await retireLegacyFinalizedToolResultCheckpoints({
      sessionId: ctx.sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
      conversationIds: new Set([ctx.conversationId]),
      openConversation: () => attachingProcess(),
    });
    expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result").map(row => row.key)).toEqual(["unrecorded", "missing-output", "unknown"]);
  });

  it("commits bounded pages and completes a pass restarted after withdrawal", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("read"));
    writer.beginTurn();
    await writer.enqueueMessage(assistantToolUseMessage(...Array.from({ length: 65 }, (_, index) => `nested-${index}`)));
    for (let index = 0; index < 65; index++) await writer.enqueueMessage(toolResultMessage(`nested-${index}`, "output"));
    await writer.flushSavePoint();
    for (let index = 0; index < 65; index++) {
      const toolUseId = `nested-${index}`;
      ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", `${ctx.conversationId}:${toolUseId}`, {
        version: 2, conversationId: ctx.conversationId, toolUseId, parentToolUseId: "parent", toolName: "read",
        budgetExempt: true, registrationOrdinal: index, content: [{ type: "text", text: "output" }], outcome: "ok",
      });
      ctx.store.append({
        aggregateId: `session:${ctx.sessionId}`, sessionId: ctx.sessionId, type: "tool.result.recorded",
        version: 1, actor: "flywheel", timestamp: Date.now(), payload: { toolUseId, outcome: "ok" },
      });
    }
    const dbFile = resolveEventStoreDbFile(ctx.baseDir);
    expect(retireRecordedFinalizedToolResultCheckpointPage(dbFile)).toMatchObject({ retired: 64, complete: false });
    expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result")).toHaveLength(1);
    expect(retireRecordedFinalizedToolResultCheckpointPage(dbFile)).toMatchObject({ retired: 1, complete: true });
    expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result")).toEqual([]);
    expect(retireRecordedFinalizedToolResultCheckpointPage(dbFile)).toMatchObject({ retired: 0, examined: 0, complete: true });
  });

  it.each(["result", "conversation", "entry"] as const)("isolates unreadable %s evidence from an unrelated session", async kind => {
    const damagedSessionId = "damaged-session";
    const damagedConversationId = "damaged-conversation";
    const damaged = await createConversationTree({
      conversationId: damagedConversationId, sessionId: damagedSessionId,
      store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
    });
    try {
      for (const [sessionId, conversationId, conversation] of [
        [ctx.sessionId, ctx.conversationId, tree],
        [damagedSessionId, damagedConversationId, damaged],
      ] as const) {
        const writer = createConversationTreeWriter({ tree: conversation });
        await writer.commitUserTurn(userMessage("read"));
        writer.beginTurn();
        await writer.enqueueMessage(assistantToolUseMessage("recorded"));
        await writer.enqueueMessage(toolResultMessage("recorded", "output"));
        await writer.flushSavePoint();
        ctx.store.putInFlight(sessionId, "finalized-tool-result", `${conversationId}:recorded`, {
          version: 2, conversationId, toolUseId: "recorded", toolName: "read",
          budgetExempt: true, registrationOrdinal: 0, content: [{ type: "text", text: "output" }], outcome: "ok",
        });
        ctx.store.append({
          aggregateId: `session:${sessionId}`, sessionId, type: "tool.result.recorded",
          version: 1, actor: "flywheel", timestamp: Date.now(), payload: { toolUseId: "recorded", outcome: "ok" },
        });
      }
      const dbFile = resolveEventStoreDbFile(ctx.baseDir);
      const db = new Database(dbFile);
      try {
        const aggregateId = kind === "result" ? `session:${damagedSessionId}` : `conversation:${damagedConversationId}`;
        const type = kind === "result" ? "tool.result.recorded" : "chat.entries.appended";
        const unreadable = kind === "entry" ? '{"entries":["unreadable"]}' : '{"broken":';
        db.query("update event set payload = ? where aggregate_id = ? and type = ?").run(unreadable, aggregateId, type);
        const original = ctx.store.readInFlight(damagedSessionId, "finalized-tool-result")[0]!.raw;
        expect(retireRecordedFinalizedToolResultCheckpointPage(dbFile)).toMatchObject({ retired: 1, complete: true });
        expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result")).toEqual([]);
        expect(ctx.store.readInFlight(damagedSessionId, "finalized-tool-result")[0]?.raw).toBe(original);
        const retained = db.query<{ payload: string }, [string, string]>(
          "select payload from event where aggregate_id = ? and type = ?",
        ).all(aggregateId, type);
        expect(retained.length).toBeGreaterThan(0);
        expect(retained.every(row => row.payload === unreadable)).toBe(true);
      } finally {
        db.close();
      }
    } finally {
      damaged.getStorage().dispose();
    }
  });

  it("keeps a nested live writer's retirement token until its own conversation commits", async () => {
    const conversationId = "child-conversation";
    const child = await createConversationTree({
      conversationId, sessionId: ctx.sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
    });
    try {
      const writer = createConversationTreeWriter({ tree: child });
      await writer.commitUserTurn(userMessage("read"));
      writer.beginTurn();
      await writer.enqueueMessage(assistantToolUseMessage("nested"));
      await writer.flushSavePoint(new Set(["nested"]));
      const key = `${conversationId}:nested`;
      ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", key, {
        version: 2, conversationId, toolUseId: "nested", parentToolUseId: "parent", toolName: "read",
        budgetExempt: true, registrationOrdinal: 0, content: [{ type: "text", text: "output" }], outcome: "ok",
      });
      ctx.store.append({
        aggregateId: `session:${ctx.sessionId}`, sessionId: ctx.sessionId, type: "tool.result.recorded",
        version: 1, actor: "flywheel", timestamp: Date.now(), payload: { toolUseId: "nested", outcome: "ok", parentToolUseId: "parent" },
      });
      const cell = ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result")[0]!;
      expect(retireRecordedFinalizedToolResultCheckpointPage(resolveEventStoreDbFile(ctx.baseDir)).retired).toBe(0);
      expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result")[0]?.raw).toBe(cell.raw);
      await writer.enqueueMessage(toolResultMessage("nested", "output"));
      await writer.flushSavePoint(undefined, [{ kind: "finalized-tool-result", key, expectedRaw: cell.raw }]);
      expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result")).toEqual([]);
      expect((await child.getBranch()).filter(entry => entry.kind === "message" && entry.message.kind === "toolResult")).toHaveLength(1);
    } finally {
      child.getStorage().dispose();
    }
  });

  it("converts an unversioned finalized result before the current result mapper runs", async () => {
    const mutation = buildMutationDiff([{ path: "old.ts", before: { kind: "text", text: "old\n" }, after: { kind: "text", text: "new\n" } }]);
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("change the file"));
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("current"));
    await writer.flushSavePoint(new Set(["current"]));
    ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", `${ctx.conversationId}:current`, {
      conversationId: ctx.conversationId, toolUseId: "current", toolName: "edit",
      registrationOrdinal: 0, budgetExempt: false, content: [{ type: "text", text: "changed" }],
      outcome: "interrupted", details: { mutation }, executionOutputTail: "partial output",
    });
    const resumed = await attachingProcess();
    await recoverFinalizedToolResultCheckpoints({
      conversationId: ctx.conversationId, sessionId: ctx.sessionId,
      store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store), tree: resumed,
    });
    expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result")).toEqual([]);
    const result = ctx.store.read({ types: ["tool.result.recorded"] })[0];
    const output = ctx.store.read({ types: ["tool.execution_output.recorded"] })[0];
    expect(result).toMatchObject({ version: 3, payload: { outcome: "interrupted", details: { mutationEvidence: { retainedFiles: 1 } } } });
    expect(output).toMatchObject({ version: 3, payload: { output: "partial output", mutationEvidence: { retainedFiles: 1 } } });
    expect(result?.payload.details).not.toHaveProperty("mutation");
    const messages = (await resumed.getBranch()).filter(entry => entry.kind === "message" && entry.message.kind === "toolResult");
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain("changed");
    expect(JSON.stringify(messages)).not.toContain("mutationEvidence");
    expect(JSON.stringify(messages)).not.toContain("unifiedDiff");
  });
  it.each(["ok", "error", "interrupted"] as const)("recovers %s reference evidence without putting display patches in provider history", async outcome => {
      const stage = async (nodes: Parameters<typeof ctx.store.stageSessionContentNodes>[1]) => {
        ctx.store.stageSessionContentNodes(ctx.sessionId, nodes);
      };
      const file = await buildMutationFileEvidence({
        mutationId: "mutation-recovered", path: "large.txt",
        before: { kind: "text", text: "a".repeat(40_000) },
        after: { kind: "text", text: "b".repeat(40_000) },
      }, stage);
      if (!file) throw new Error("expected mutation");
      const mutationEvidence = await buildMutationEvidence([{ kind: "applied", file }], stage);
      const details = {
        mutationEvidence,
        ...(outcome === "ok" ? {} : { displayContent: "tool display\n".repeat(300) }),
      };
      const writer = createConversationTreeWriter({ tree });
      await writer.commitUserTurn(userMessage("change the file"));
      writer.beginTurn();
      writer.enqueueMessage(assistantToolUseMessage("current"));
      await writer.flushSavePoint(new Set(["current"]));
      ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", `${ctx.conversationId}:current`, {
        version: 2,
        conversationId: ctx.conversationId,
        toolUseId: "current", toolName: "edit", registrationOrdinal: 0, budgetExempt: false,
        content: [{ type: "text", text: "Changed the file" }],
        outcome, details,
        executionOutputTail: "process output\n".repeat(300),
      });
      const resumed = await attachingProcess();
      await recoverFinalizedToolResultCheckpoints({
        conversationId: ctx.conversationId, sessionId: ctx.sessionId,
        store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store), tree: resumed,
      });
      expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result")).toEqual([]);
      const facts = ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.result.recorded"] });
      expect(facts).toHaveLength(1);
      const fact = facts[0];
      if (!fact) throw new Error("expected recovered result");
      expect(fact).toMatchObject({ version: outcome === "ok" ? 3 : 4, payload: { outcome, details: { mutationEvidence } } });
      const resultsSlice = await asAsyncEventReadSurface(ctx.store).readSlice({
        aggregateId: `session:${ctx.sessionId}`, types: ["tool.result.recorded"],
      });
      expect(hydrateToolContentFact(fact, resultsSlice.toolContent)).toMatchObject({ version: 3, payload: { details } });
      const outputs = ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.execution_output.recorded"] });
      expect(outputs).toHaveLength(1);
      const output = outputs[0];
      if (!output) throw new Error("expected execution output");
      expect(output).toMatchObject({ version: 4, payload: { mutationEvidence } });
      const slice = await asAsyncEventReadSurface(ctx.store).readSlice({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.execution_output.recorded"] });
      expect(hydrateToolContentFact(output, slice.toolContent)).toMatchObject({
        version: 3, payload: { output: "process output\n".repeat(300), mutationEvidence },
      });
      const results = (await resumed.getBranch()).filter(entry => entry.kind === "message" && entry.message.kind === "toolResult");
      expect(results).toHaveLength(1);
      expect(JSON.stringify(results)).toContain("Changed the file");
      expect(JSON.stringify(results)).not.toContain(mutationEvidence.manifest.root);
      expect(JSON.stringify(results)).not.toContain("unifiedDiff");
  });

  it.each([
    ["the recorded bound", { turnBudgetChars: 30_000 }, ["first"]],
    // A cell written before 2026-10-27 records the window: a 20,000-token window has a 24,000-character share.
    ["the window of a cell written before the bound was recorded", { contextWindowTokens: 20_000 }, ["first"]],
    ["a cell that records neither, under the default share", {}, []],
  ])("replays %s over the recovered batch", async (_case, bound, persisted) => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("run both"));
    writer.beginTurn();
    await writer.enqueueMessage(assistantToolUseMessage("first", "second"));
    await writer.flushSavePoint(new Set(["first", "second"]));
    for (const [index, toolUseId] of ["first", "second"].entries()) {
      ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", `${ctx.conversationId}:${toolUseId}`, {
        version: 2, conversationId: ctx.conversationId, toolUseId, toolName: "bash", budgetExempt: false, ...bound,
        registrationOrdinal: index, content: [{ type: "text", text: `${toolUseId}\n${"x".repeat(index === 0 ? 21_000 : 20_000)}` }], outcome: "ok",
      });
    }
    const resumed = await attachingProcess();
    try {
      await recoverFinalizedToolResultCheckpoints({
        conversationId: ctx.conversationId, sessionId: ctx.sessionId, projectRoot: ctx.baseDir,
        store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store), tree: resumed,
      });
      const results = (await resumed.getBranch()).flatMap((entry) => entry.kind === "message" && entry.message.kind === "toolResult" ? [entry.message] : []);
      expect(results.filter((message) => JSON.stringify(message.content).includes("<persisted-output>")).map((message) => message.toolUseId)).toEqual(persisted);
    } finally {
      resumed.getStorage().dispose();
    }
  });

  it("retires stale checkpoints as session evidence without adding them to the current open exchange", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("inspect the current file"));
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("current"));
    await writer.flushSavePoint(new Set(["current"]));
    ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", `${ctx.conversationId}:stale`, {
      conversationId: ctx.conversationId,
      toolUseId: "stale",
      toolName: "read_old",
      budgetExempt: true,
      registrationOrdinal: 0,
      content: [{ type: "text", text: "stale output" }],
      outcome: "ok",
    });
    ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", `${ctx.conversationId}:current`, {
      conversationId: ctx.conversationId,
      toolUseId: "current",
      toolName: "read_current",
      budgetExempt: true,
      registrationOrdinal: 1,
      content: [{ type: "text", text: "current output" }],
      outcome: "ok",
    });

    const resumed = await attachingProcess();
    const base = asAsyncEventReadSurface(ctx.store);
    ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", "other:untouched", {
      version: 2, conversationId: "other", toolUseId: "untouched", toolName: "read",
      budgetExempt: true, registrationOrdinal: 0, content: [{ type: "text", text: "other output" }], outcome: "ok",
    });
    const readKeys: string[][] = [];
    const reader = {
      ...base,
      async readInFlight(sessionId: string, kind: string | readonly string[], keyPrefix?: string) {
        await Promise.resolve();
        const rows = await base.readInFlight(sessionId, kind, keyPrefix);
        readKeys.push(rows.map(row => row.key));
        return rows;
      },
      async aggregateSeq(aggregateId: string) {
        await Promise.resolve();
        return base.aggregateSeq(aggregateId);
      },
    };
    await recoverFinalizedToolResultCheckpoints({
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      store: reader,
      writer: asAsyncEventWriter(ctx.store),
      tree: resumed,
    });

    expect(readKeys).toEqual([[`${ctx.conversationId}:stale`, `${ctx.conversationId}:current`]]);
    expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result").map(row => row.key)).toEqual(["other:untouched"]);
    expect(ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.result.recorded"] })
      .map((fact) => fact.payload.toolUseId)).toEqual(["stale", "current"]);
    const results = (await resumed.getBranch()).filter((entry) => entry.kind === "message" && entry.message.kind === "toolResult");
    expect(results.map((entry) => entry.kind === "message" && entry.message.kind === "toolResult" ? entry.message.toolUseId : "")).toEqual(["current"]);
  });
});
