import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types";
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer";
import { createConversationTreeWriter } from "../../../../src/orchestration/session/conversation/conversation-tree-writer";
import {
  assistantMessage,
  createSavePointContext,
  disposeSavePointContext,
  readEntries,
  userMessage,
  type SavePointTestContext,
} from "./_save-point-fixtures";

let ctx: SavePointTestContext;

beforeEach(async () => {
  ctx = await createSavePointContext();
});

afterEach(async () => {
  await disposeSavePointContext(ctx);
});

describe("save-point identity reservations", () => {
  it("releases recalled and refused input reservations without releasing another pending input", async () => {
    const eventWriter = asAsyncEventWriter(ctx.store);
    let refuse = false;
    const controller = createConversationTreeWriterController({
      conversationId: ctx.conversationId, sessionId: ctx.sessionId, projectRoot: ctx.baseDir,
      store: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store),
      writer: {
        ...eventWriter,
        putInFlight: async (...args) => {
          if (refuse) throw new Error("write refused");
          await eventWriter.putInFlight!(...args);
        },
      },
    });
    await controller.buildContext();
    const uuid = spyOn(crypto, "randomUUID");
    const draw = (prefix: string): ReturnType<typeof crypto.randomUUID> => `${prefix}-0000-4000-8000-000000000000`;
    try {
      uuid.mockReturnValue(draw("0000000a"));
      const recalled = await controller.holdQueuedUserInput("recall this");
      uuid.mockReturnValue(draw("0000000b"));
      const pending = await controller.holdQueuedUserInput("keep this");
      expect(recalled).toBe("0000000a");
      expect(pending).toBe("0000000b");
      await controller.dropQueuedUserInputs(["0000000a"]);
      expect(ctx.store.readInFlight(ctx.sessionId, "chat.queued_user_input").map(cell => cell.key)).toEqual(["0000000b"]);
      uuid.mockReturnValue(draw("0000000a"));
      expect(await controller.reserveMessageId()).toBe("0000000a");
      uuid.mockReturnValueOnce(draw("0000000b")).mockReturnValue(draw("0000000c"));
      expect(await controller.reserveMessageId()).toBe("0000000c");
      uuid.mockReturnValue(draw("0000000d"));
      refuse = true;
      await expect(controller.holdQueuedUserInput("not saved")).rejects.toThrow("write refused");
      uuid.mockReturnValueOnce(draw("0000000d")).mockReturnValue(draw("0000000e"));
      expect(await controller.reserveMessageId()).toBe("0000000d");
      expect(ctx.store.readInFlight(ctx.sessionId, "chat.queued_user_input").map(cell => cell.key)).toEqual(["0000000b"]);
    } finally {
      uuid.mockRestore();
      await controller.dispose();
    }
  });

  it("keeps partial assistant content and its reserved identity from the held turn through the save point", async () => {
    const { tree } = ctx;
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("hi"));
    writer.beginTurn();
    const id = await tree.getStorage().allocateId();
    await writer.enqueueMessage(assistantMessage("partial reply"), id);
    expect(tree.getStorage().getPendingEntries().at(-1)?.id).toBe(id);
    expect(await readEntries(tree)).toHaveLength(1);

    await writer.flushSavePoint();

    const afterFlush = await readEntries(tree);
    expect(afterFlush).toMatchObject([{}, { id, kind: "message", message: { kind: "assistant" } }]);
  });
});
