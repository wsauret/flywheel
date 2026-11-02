import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types";
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer";
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle";
import type { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree";
import type { CompactionEntry, MessageEntry } from "../../../../src/orchestration/session/conversation/conversation-entry-types";
import { createTokenCounter } from "../../../../src/orchestration/agent-runtime/compaction/token-counter";
import { assistantMessage, createSavePointContext, disposeSavePointContext, type SavePointTestContext } from "./_save-point-fixtures";

let ctx: SavePointTestContext;
let tree: ConversationTree;

beforeEach(async () => {
  ctx = await createSavePointContext();
  tree = ctx.tree;
});

afterEach(async () => {
  await disposeSavePointContext(ctx);
});

function createController() {
  return createConversationTreeWriterController({ conversationId: ctx.conversationId, sessionId: ctx.sessionId, projectRoot: ctx.baseDir, store: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) });
}

function measureWithPrefix(prefixTokens: number) {
  return (messages: readonly import("../../../../src/orchestration/agent-runtime/llm/types").ConversationMessage[]) => {
    const counter = createTokenCounter({ provider: "anthropic" });
    counter.resetFor([...messages]);
    return prefixTokens + counter.total;
  };
}

async function openExistingTree(): Promise<ConversationTree> {
  const reopened = await tryOpenConversationTree({ conversationId: ctx.conversationId, sessionId: ctx.sessionId, store: asAsyncEventReadSurface(ctx.store) });
  if (!reopened) throw new Error(`expected conversation tree ${ctx.conversationId}`);
  return reopened;
}

describe("ConversationTreeWriterController reset compaction", () => {
  it("records tokensAfter as the prompt prefix plus reset history", async () => {
    await tree.getStorage().dispose();
    let recordedTokensAfter = 0;
    const controller = createController();
    try {
      await controller.commitUserTurn("first");
      const result = await controller.recordCompaction({
        tokensBefore: 30_000,
        additions: [],
        after: "continue",
        measureTokensAfter: measureWithPrefix(25_000),
      });
      expect(result).not.toBeNull();
      expect(result?.messages).toEqual([]);
      expect(result?.tokensAfter).toBe(25_000);
      recordedTokensAfter = result?.tokensAfter ?? 0;
    } finally {
      await controller.dispose();
    }
    const reopened = await openExistingTree();
    try {
      const compaction = (await reopened.getBranch()).find((entry): entry is CompactionEntry => entry.kind === "compaction");
      expect(compaction).toMatchObject({ mode: "reset", tokensAfter: recordedTokensAfter });
    } finally {
      await reopened.getStorage().dispose();
    }
  });

  it("records sourceLeafId at the post-flush leaf", async () => {
    await tree.getStorage().dispose();
    const controller = createController();
    try {
      await controller.commitUserTurn("first");
      controller.beginTurn();
      controller.recordCanonicalMessage(assistantMessage("queued-reply"));
      const result = await controller.recordCompaction({
        tokensBefore: 10_000,
        additions: [],
        after: "continue",
        measureTokensAfter: measureWithPrefix(0),
      });
      expect(result?.entryId).toEqual(expect.any(String));
      expect(result?.messages).toEqual([]);
    } finally {
      await controller.dispose();
    }
    const reopened = await openExistingTree();
    try {
      const branch = await reopened.getBranch();
      const compaction = branch.find((entry): entry is CompactionEntry => entry.kind === "compaction");
      const messages = branch.filter((entry): entry is MessageEntry => entry.kind === "message");
      expect(messages).toHaveLength(2);
      expect(compaction).toMatchObject({ mode: "reset", sourceLeafId: messages[1]?.id });
    } finally {
      await reopened.getStorage().dispose();
    }
  });

  it("returns null when the tree has no entry to anchor against", async () => {
    await tree.getStorage().dispose();
    const controller = createController();
    try {
      expect(await controller.recordCompaction({
        tokensBefore: 0,
        additions: [],
        after: "continue",
        measureTokensAfter: measureWithPrefix(0),
      })).toBeNull();
    } finally {
      await controller.dispose();
    }
  });
});
