import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createConversationTreeWriter } from "../../../../src/orchestration/session/conversation/conversation-tree-writer";
import type { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types";
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer";
import {
  assistantMessage,
  assistantToolUseMessage,
  attachingProcess,
  createSavePointContext,
  disposeSavePointContext,
  toolResultMessage,
  userMessage,
  type SavePointTestContext,
} from "./_save-point-fixtures";
import { interruptedTurnMessage, turnEndEntryId, turnEndOfEntry } from "../../../../src/orchestration/session/conversation/turn-end-record";

// A turn's end reason is what Resume reads. Recovery over a dead owner must
// record an unanswered turn that left no work, and must leave an interrupted
// turn's record as the interrupt wrote it, so an interrupted chat never reads
// as a crash.

let ctx: SavePointTestContext;
let tree: ConversationTree;

beforeEach(async () => {
  ctx = await createSavePointContext();
  tree = ctx.tree;
});

afterEach(async () => {
  await disposeSavePointContext(ctx);
});

describe("a turn that ends by an interrupt or dies before its first tool call", () => {
  const pausedRecord = () => ({ kind: "user" as const, content: interruptedTurnMessage("person", true), origin: "system" as const });

  it("recovery over a dead owner records an unanswered turn that left no work, so Resume can find it", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("fix the parser"));
    writer.beginTurn();
    writer.enqueueMessage(assistantMessage("I have started on"));

    const recovering = await attachingProcess(ctx);
    await recovering.recordInterruptedTurn("crash", { ownerDead: true });

    const record = (await recovering.getBranch()).at(-1);
    expect(record?.kind === "message" && String(record.message.content)).toContain("exited before the turn finished");
    expect(record ? turnEndOfEntry(record) : undefined).toEqual({ reason: "crash" });
  });

  it("a live writer's idle commit never mistakes its own unanswered message for a crash", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("the task"));
    await writer.commitUserTurn({ kind: "user", content: "held input", origin: "system" });

    const kinds = (await tree.getBranch()).map((entry) => entry.kind === "message" ? String(entry.message.content) : entry.kind);
    expect(kinds).toEqual(["the task", "held input"]);
  });

  it("recovery leaves an interrupted turn's record alone: it stays interrupted, never a crash", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("fix the parser"));
    await tree.appendMessage(pausedRecord(), turnEndEntryId({ reason: "paused", pausedBy: "person" }, "k"));

    const recovering = await attachingProcess(ctx);
    await recovering.recordInterruptedTurn("crash", { ownerDead: true });

    const branch = await recovering.getBranch();
    expect(branch.map((entry) => entry.kind === "message" ? turnEndOfEntry(entry)?.reason : undefined)).toEqual([undefined, "paused"]);
    expect(JSON.stringify(branch)).not.toContain("exited before the turn finished");
  });

  it("a later recovery pass leaves a runtime interrupt's record alone when an earlier pass closed a call the turn made", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("delegate the parser fix"));
    recordSessionFact("tool.input.completed", { toolUseId: "dispatch-1", toolName: "subagent", input: {} });
    await tree.appendMessage({ ...pausedRecord(), content: interruptedTurnMessage("runtime", true) }, turnEndEntryId({ reason: "paused", pausedBy: "runtime" }, "k"));
    // The first pass over the dead owner closed the call the interrupted
    // turn made; the successor's pass reads the same turn again.
    recordSessionFact("tool.result.recorded", { toolUseId: "dispatch-1", outcome: "interrupted" });

    const recovering = await attachingProcess(ctx);
    await recovering.recordInterruptedTurn("crash", { ownerDead: true });

    const branch = await recovering.getBranch();
    expect(branch.map((entry) => entry.kind === "message" ? turnEndOfEntry(entry) : undefined)).toEqual([undefined, { reason: "paused", pausedBy: "runtime" }]);
    expect(JSON.stringify(branch)).not.toContain("exited before the turn finished");
  });
});

describe("a live interrupt of a turn parked on a wait", () => {
  it("records only its own turn end, never a crash record over the turn it ends", async () => {
    const writer = createConversationTreeWriterController({
      conversationId: ctx.conversationId, sessionId: ctx.sessionId, projectRoot: ctx.baseDir, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
    });
    try {
      await writer.commitUserTurn("delegate the parser fix");
      writer.beginTurn();
      recordSessionFact("tool.input.completed", { toolUseId: "wait-1", toolName: "process", input: {} });
      await writer.recordCanonicalMessage(assistantToolUseMessage("wait-1"));
      await writer.recordCanonicalMessage(toolResultMessage("wait-1", "Wait acknowledged."));
      await writer.flushSavePoint();
      // The wait's result fact lands after the turn's last assistant commit,
      // and the turn parks on its child with the writer idle.
      recordSessionFact("tool.result.recorded", { toolUseId: "wait-1", outcome: "ok" });
      await writer.endTurn();

      await writer.commitTurnEnd("runtime");

      const branch = await (await attachingProcess(ctx)).getBranch();
      const ends = branch.flatMap((entry) => entry.kind === "message" ? [turnEndOfEntry(entry)].filter((end) => end !== undefined) : []);
      expect(ends).toEqual([{ reason: "paused", pausedBy: "runtime" }]);
    } finally {
      await writer.dispose();
    }
  });
});

function recordSessionFact(type: string, payload: { readonly [key: string]: unknown }): void {
  ctx.store.append({
    aggregateId: `session:${ctx.sessionId}`,
    sessionId: ctx.sessionId,
    type,
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    payload,
  });
}
