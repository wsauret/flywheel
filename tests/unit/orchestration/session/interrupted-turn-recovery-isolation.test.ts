import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { asAsyncEventReadSurface, asAsyncEventWriter, CorruptEventRowError } from "../../../../src/infra/event-store-types";
import { createConversationTreeWriter } from "../../../../src/orchestration/session/conversation/conversation-tree-writer";
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle";
import type { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree";
import {
  createSavePointContext,
  disposeSavePointContext,
  userMessage,
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

describe("interrupted-turn recovery session isolation", () => {
  it("recovers a healthy conversation without selecting a later corrupt session's tool fact", async () => {
    await createConversationTreeWriter({ tree }).commitUserTurn(userMessage("hello"));
    const boundary = await (await tree.getStorage()).getInterruptionBoundary();
    const corrupt = ctx.store.append({
      aggregateId: "session:other",
      sessionId: "other",
      type: "tool.input.completed",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      payload: { toolUseId: "theirs", toolName: "read", input: {} },
      payloadJson: "{{not-json",
    });
    expect(corrupt.position).toBeGreaterThan(boundary);
    const read = spyOn(ctx.store, "read");
    try {
      const resumed = await tryOpenConversationTree({ conversationId: ctx.conversationId, sessionId: ctx.sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) });
      if (!resumed) throw new Error(`expected conversation tree ${ctx.conversationId}`);
      await createConversationTreeWriter({ tree: resumed }).commitUserTurn(userMessage("carry on"));

      expect(read).toHaveBeenCalledWith({
        aggregateId: `session:${ctx.sessionId}`,
        types: ["tool.input.completed", "tool.result.recorded", "file.changed"],
        afterPosition: boundary,
      });
      expect((await resumed.buildContext()).messages.map((message) => message.content)).toEqual(["hello", "carry on"]);
      expect(ctx.store.readLatestPayloadByAggregateAndType("session:other", "tool.input.completed")).toBe("{{not-json");
    } finally {
      read.mockRestore();
    }
  });

  it("still rejects corrupt facts owned by the recovering session", async () => {
    ctx.store.append({
      aggregateId: `session:${ctx.sessionId}`,
      sessionId: ctx.sessionId,
      type: "tool.input.completed",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      payload: { toolUseId: "mine", toolName: "read", input: {} },
      payloadJson: "{{not-json",
    });

    await expect(tree.recordInterruptedTurn()).rejects.toThrow(CorruptEventRowError);
    expect(await tree.getBranch()).toHaveLength(0);
    expect(ctx.store.readLatestPayloadByAggregateAndType(`session:${ctx.sessionId}`, "tool.input.completed")).toBe("{{not-json");
  });
});
