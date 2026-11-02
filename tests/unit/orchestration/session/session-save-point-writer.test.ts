import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createConversationTreeWriter } from "../../../../src/orchestration/session/conversation/conversation-tree-writer";
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer";
import { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree";
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types";
import type { HeldRetainedOperation } from "../../../../src/orchestration/module-seams";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types";
import { Log } from "../../../../src/infra/log";
import { chatTurnEndOf, isResumableTurnEnd, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record";
import {
  assistantMessage,
  assistantToolUseMessage,
  attachingProcess,
  createSavePointContext,
  disposeSavePointContext,
  messageContent,
  readEntries,
  toolResultMessage,
  toolResultMessages,
  userMessage,
  type SavePointTestContext,
} from "./_save-point-fixtures";

let ctx: SavePointTestContext;
let tree: ConversationTree;

beforeEach(async () => {
  ctx = await createSavePointContext();
  tree = ctx.tree;
});

describe("raw live conversation capture", () => {
  it("yields cooperatively while keeping one captured pending boundary", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("main question"));
    writer.beginTurn();
    await writer.enqueueMessage(assistantToolUseMessage("running"));
    const reached = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    let clock = 0;
    let paused = false;
    const capturedTree = new ConversationTree(tree.getStorage(), {
      now: () => { clock += 8; return clock; },
      yieldToNextTask: async () => {
        if (paused) return;
        paused = true;
        reached.resolve();
        await resume.promise;
      },
    });
    const capture = capturedTree.captureRawLiveMessages();
    await reached.promise;
    await writer.enqueueMessage(toolResultMessage("running", "finished after capture"));
    resume.resolve();
    expect(await capture).toEqual([userMessage("main question"), assistantToolUseMessage("running")]);
    expect(await tree.captureRawLiveMessages()).toHaveLength(3);
    expect(writer.pendingCount()).toBe(2);
  });

  it("copies committed and held history without repairing open tools or flushing the source", async () => {
    const writer = createConversationTreeWriter({ tree });
    const user = userMessage("main question");
    const calls = assistantToolUseMessage("finished", "running");
    const result = toolResultMessage("finished", "available result");
    await writer.commitUserTurn(user);
    writer.beginTurn();
    await writer.enqueueMessage(calls);
    await writer.flushSavePoint(new Set(["finished", "running"]));
    await writer.enqueueMessage(result);
    const before = await readEntries(tree);
    const snapshot = await writer.captureRawLiveMessages();
    expect(snapshot).toEqual([user, calls, result]);
    expect(await tree.captureCommittedForkMessages()).toEqual([user]);
    expect(await readEntries(tree)).toEqual(before);
    expect(writer.pendingCount()).toBe(1);
    await writer.enqueueMessage(toolResultMessage("running", "later result"));
    expect(snapshot).toEqual([user, calls, result]);
    expect(await tree.captureRawLiveMessages()).toHaveLength(4);
    const capturedCalls = snapshot[1];
    if (capturedCalls?.kind !== "assistant" || typeof capturedCalls.content === "string") throw new Error("expected captured calls");
    const capturedCall = capturedCalls.content[0];
    if (capturedCall?.type !== "tool_use") throw new Error("expected a captured tool call");
    capturedCall.input = { changed: true };
    expect((await tree.captureRawLiveMessages())[1]).toEqual(calls);
  });

  it("captures pending user and assistant history through the chat dependency port after compaction", async () => {
    const controller = createConversationTreeWriterController({
      conversationId: ctx.conversationId, sessionId: ctx.sessionId, projectRoot: ctx.baseDir,
      store: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store),
      writer: asAsyncEventWriter(ctx.store),
    });
    await controller.commitUserTurn("old question");
    await controller.recordCanonicalMessage(assistantMessage("old answer"));
    await controller.recordCompaction({
      tokensBefore: 100, measureTokensAfter: () => 1, additions: [userMessage("compacted context")], after: "park",
    });
    controller.beginTurn();
    await controller.recordCanonicalMessage(userMessage("held question"));
    await controller.recordCanonicalMessage(assistantMessage("held answer"));
    const snapshot = await controller.captureRawLiveMessages();
    expect(snapshot).toEqual([userMessage("compacted context"), userMessage("held question"), assistantMessage("held answer")]);
    expect(await controller.captureCommittedForkMessages()).toEqual([userMessage("compacted context")]);
    await controller.dispose();
  });
});

describe("ConversationTreeWriter — retained operations", () => {
  const launch = (key: string, commit: HeldRetainedOperation["commit"]): HeldRetainedOperation => ({ kind: "workflow.launch", key, commit });

  it("commits held work when the busy turn ends, never at a save point inside it, and dispatches it once", async () => {
    const writer = createConversationTreeWriter({ tree });
    const order: string[] = [];
    const dispatched = Promise.withResolvers<void>();
    const registered = Promise.withResolvers<void>();
    await writer.commitUserTurn(userMessage("start"));
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("t1"));
    await writer.acceptRetainedOperation(launch("operation-1", async () => {
      order.push("commit");
      return { kind: "committed", dispatch: () => {
        order.push("dispatch");
        dispatched.resolve();
        return registered.promise;
      } };
    }));

    await writer.flushSavePoint(new Set(["t1"]));
    writer.enqueueMessage(toolResultMessage("t1", "ok"));
    await writer.flushSavePoint();
    expect(order).toEqual([]);

    writer.enqueueMessage(assistantMessage("done"));
    const ending = writer.endTurn();
    await dispatched.promise;
    expect(await Promise.race([ending.then(() => "ended"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 0))])).toBe("waiting");
    registered.resolve();
    await ending;
    expect(order).toEqual(["commit", "dispatch"]);
    expect((await readEntries(tree)).map((entry) => messageContent(entry)?.kind)).toEqual(["user", "assistant", "toolResult", "assistant"]);

    await writer.flushSavePoint();
    expect(order).toEqual(["commit", "dispatch"]);
  });

  it("commits work accepted while the turn's last drain runs, at any point of that drain, before the turn ends", async () => {
    // The acceptance lands a few microtasks after the turn's batch commits,
    // which sweeps the gap between the drain's held-work loop and idle.
    for (let ticks = 0; ticks < 8; ticks += 1) {
      const writer = createConversationTreeWriter({ tree });
      await writer.commitUserTurn(userMessage(`start ${ticks}`));
      writer.beginTurn();
      writer.enqueueMessage(assistantMessage(`done ${ticks}`));
      let commits = 0;
      const { promise: accepted, resolve: accept } = Promise.withResolvers<void>();
      const append = tree.appendMessages.bind(tree);
      const restore = spyOn(tree, "appendMessages").mockImplementationOnce(async (...args) => {
        const outcome = await append(...args);
        let gap = Promise.resolve();
        for (let tick = 0; tick < ticks; tick += 1) gap = gap.then(() => {});
        void gap.then(() => accept(writer.acceptRetainedOperation(launch(`operation-${ticks}`, async () => {
          commits += 1;
          return { kind: "committed", dispatch: () => {} };
        }))));
        return outcome;
      });
      await writer.endTurn();
      // No later save point: the acceptance itself is the only trigger. An
      // acceptance during the drain resolves at once and the drain commits
      // it; one after the drain commits before it resolves.
      await accepted;
      restore.mockRestore();
      expect({ ticks, commits }).toEqual({ ticks, commits: 1 });
    }
  });

  it("keeps an operation that contention retained, and an idle writer retries it once when a Resume hands it over again", async () => {
    const writer = createConversationTreeWriter({ tree });
    let contended = true;
    let commits = 0;
    let dispatches = 0;
    const operation = launch("reserved-child-and-entry-ids", async () => {
      commits += 1;
      return contended ? { kind: "retained" } : { kind: "committed", dispatch: () => { dispatches += 1; } };
    });

    await writer.acceptRetainedOperation(operation);
    expect([commits, dispatches]).toEqual([1, 0]);

    // A Resume reads the same cell again and hands the writer its operation.
    contended = false;
    await writer.acceptRetainedOperation(launch("reserved-child-and-entry-ids", operation.commit));
    expect([commits, dispatches]).toEqual([2, 1]);
  });

  /** Accepts a launch cell under `key`, and returns an operation that the
   *  module refuses with `content` and that retires that exact cell. */
  async function refusedLaunch(key: string, content: string) {
    await asAsyncEventWriter(ctx.store).swapInFlight?.(ctx.sessionId, "workflow.launch", key, null, { operationId: key });
    const cell = ctx.store.readInFlight(ctx.sessionId, "workflow.launch").find((candidate) => candidate.key === key);
    if (!cell) throw new Error("expected the accepted cell");
    const notice: ConversationMessage = { kind: "user", content, origin: "system" };
    const noticeId = turnEndEntryId({ reason: "settled" }, key);
    const retire = { op: "swap", kind: cell.kind, key: cell.key, expectedRaw: cell.raw, payload: null } as const;
    return { notice, noticeId, operation: launch(key, async () => ({ kind: "refused", notice, noticeId, retire })) };
  }

  it("retires a refused operation's cell with its notice in one batch, settles the exchange, and goes on to the next", async () => {
    const { notice, noticeId, operation } = await refusedLaunch("operation-1", "The QA workflow could not start: required skills are missing");
    const order: string[] = [];
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("start"));
    writer.beginTurn();
    // The owner learns of each record only once it is durable: the refusal's
    // notice and its cell's retirement land in one batch.
    const retired = () => !ctx.store.readInFlight(ctx.sessionId, "workflow.launch").some(({ key }) => key === "operation-1");
    await writer.acceptRetainedOperation({ ...operation, landed: () => { order.push(`operation-1 landed, retired: ${retired()}`); } });
    await writer.acceptRetainedOperation({
      ...launch("operation-2", async () => ({ kind: "committed", dispatch: () => { order.push("operation-2 dispatched"); } })),
      landed: () => { order.push("operation-2 landed"); },
    });
    await writer.enqueueMessage(assistantMessage("done"));

    await writer.endTurn();

    const branch = await readEntries(tree);
    expect(branch.at(-1)).toMatchObject({ id: noticeId, message: notice });
    expect(chatTurnEndOf(branch)).toEqual({ end: { reason: "settled" }, recorded: true });
    expect(ctx.store.readInFlight(ctx.sessionId, "workflow.launch")).toEqual([]);
    expect(order).toEqual(["operation-1 landed, retired: true", "operation-2 dispatched", "operation-2 landed"]);
  });

  it("drops an operation whose commit throws, records it, and still ends the turn at idle so the next message commits", async () => {
    const error = spyOn(Log.create({ service: "conversation-tree-writer" }), "error").mockImplementation(() => {});
    try {
      const writer = createConversationTreeWriter({ tree });
      let commits = 0;
      await writer.commitUserTurn(userMessage("start"));
      writer.beginTurn();
      await writer.acceptRetainedOperation(launch("operation-1", async () => {
        commits += 1;
        throw new Error("required skills are missing");
      }));
      await writer.enqueueMessage(assistantMessage("done"));

      await writer.endTurn();
      expect(await writer.commitUserTurn(userMessage("next"))).toEqual(expect.any(String));
      await writer.flushSavePoint();

      expect(commits).toBe(1);
      expect((await readEntries(tree)).map((entry) => messageContent(entry)?.kind)).toEqual(["user", "assistant", "user"]);
      expect(error).toHaveBeenCalledTimes(1);
      expect(error.mock.calls[0]?.[1]).toEqual({ kind: "workflow.launch", key: "operation-1", errorName: "Error" });
    } finally {
      error.mockRestore();
    }
  });

  it("lands no settled record inside a turn, so a process that dies before the model answers leaves a crash that recovery records and Resume continues", async () => {
    const { noticeId, operation } = await refusedLaunch("operation-1", "The qa workflow could not start: required skills are missing");
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("start"));
    writer.beginTurn();
    await writer.enqueueMessage(assistantToolUseMessage("t1"));
    await writer.flushSavePoint(new Set(["t1"]));
    await writer.acceptRetainedOperation(operation);
    await writer.enqueueMessage(toolResultMessage("t1", "ok"));
    await writer.flushSavePoint();

    // The owner dies here, before the model answers the tool result. The
    // operation waits in its cell, so the branch ends at the unanswered result.
    expect((await readEntries(tree)).map((entry) => messageContent(entry)?.kind)).toEqual(["user", "assistant", "toolResult"]);
    expect(ctx.store.readInFlight(ctx.sessionId, "workflow.launch")).toHaveLength(1);

    const recovered = await attachingProcess(ctx);
    try {
      await recovered.recordInterruptedTurn("crash", { ownerDead: true });
      const recorded = chatTurnEndOf(await recovered.getBranch());
      expect(recorded).toEqual({ end: { reason: "crash" }, recorded: true });
      expect(isResumableTurnEnd(recorded?.end)).toBe(true);

      // Resume hands the waiting operation to an idle writer first. Its
      // settled record lands after the crash record and keeps that turn resumable.
      await createConversationTreeWriter({ tree: recovered }).acceptRetainedOperation(operation);
      const branch = await recovered.getBranch();
      expect(branch.at(-1)?.id).toBe(noticeId);
      expect(chatTurnEndOf(branch)).toEqual({ end: { reason: "crash" }, recorded: true });
    } finally {
      recovered.getStorage().dispose();
    }
  });

  it("holds an operation behind a question that waits for the person, through a stop and an idle restart, and commits it after the answer", async () => {
    let commits = 0;
    const operation = launch("operation-1", async () => {
      commits += 1;
      return { kind: "committed", dispatch: () => {} };
    });
    const stopped = createConversationTreeWriter({ tree });
    await stopped.commitUserTurn(userMessage("start"));
    stopped.beginTurn();
    await stopped.enqueueMessage({ kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }] });
    await stopped.flushSavePoint(new Set(["ask-1"]));
    await stopped.acceptRetainedOperation(operation);
    // A stop suspends the turn on its question, and disposal ends the turn.
    stopped.suspendPending();
    await stopped.endTurn();
    expect(commits).toBe(0);

    // The next runner's writer starts idle and reads the operation from its cell.
    const writer = createConversationTreeWriter({ tree });
    await writer.acceptRetainedOperation(operation);
    expect(commits).toBe(0);

    writer.beginTurn();
    await writer.enqueueMessage(toolResultMessage("ask-1", "yes"));
    await writer.flushSavePoint();
    expect(commits).toBe(0);

    await writer.enqueueMessage(assistantMessage("Thanks."));
    await writer.endTurn();
    expect(commits).toBe(1);
    expect((await readEntries(tree)).map((entry) => messageContent(entry)?.kind)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });
});

afterEach(async () => {
  await disposeSavePointContext(ctx);
});

describe("ConversationTreeWriter — idle vs in-turn writes", () => {
  it("queues a follow-up user message that arrives while in-turn", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("first"));
    writer.beginTurn();
    // User sends a follow-up before the previous turn settles.
    const queuedId = await writer.commitUserTurn(userMessage("queued"));
    const beforeFlush = await readEntries(tree);
    expect(queuedId).toBeNull();
    expect(beforeFlush.length).toBe(1); // first only — queued is pending
    await writer.flushSavePoint();
    const afterFlush = await readEntries(tree);
    expect(afterFlush.length).toBe(2);
    expect(messageContent(afterFlush[1])?.content).toBe("queued");
  });
});

describe("ConversationTreeWriterController — commit ids", () => {
  it("returns a durable entry id while idle and null for in-turn buffered commits", async () => {
    const controller = createConversationTreeWriterController({
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      projectRoot: ctx.baseDir,
      store: asAsyncEventReadSurface(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
      writer: {
        append: async (event) => ctx.store.append(event),
        appendBatch: async (events) => ctx.store.appendBatch(events),
        appendGuarded: async (event) => ctx.store.appendGuarded(event),
        appendBatchGuarded: async (events) => ctx.store.appendBatchGuarded(events),
        pruneSupersededEvents: async (aggregateId, eventType) => ctx.store.pruneSupersededEvents(aggregateId, eventType),
      },
    });
    try {
      const entryId = await controller.commitUserTurn("idle");
      const branch = await readEntries(tree);
      expect(entryId).toBe(branch[0]!.id);
      controller.beginTurn();
      await expect(controller.commitUserTurn("buffered")).resolves.toBeNull();
    } finally {
      await controller.dispose();
    }
  });
});

describe("ConversationTreeWriter — save-point flush ordering", () => {
  it("flushes pending entries in request order with a single batch and preserves parent links", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("ask"));
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("tool-1"));
    writer.enqueueMessage(toolResultMessage("tool-1", "model.turn.completed"));
    writer.enqueueMessage(assistantMessage("final answer"));

    await writer.flushSavePoint();

    const branch = await readEntries(tree);
    expect(branch.length).toBe(4);
    expect(messageContent(branch[0])?.kind).toBe("user");
    expect(messageContent(branch[1])?.kind).toBe("assistant");
    expect(messageContent(branch[2])?.kind).toBe("toolResult");
    expect(messageContent(branch[3])?.kind).toBe("assistant");
    // parent chain
    expect(branch[1]?.parentId).toBe(branch[0]?.id ?? null);
    expect(branch[2]?.parentId).toBe(branch[1]?.id ?? null);
    expect(branch[3]?.parentId).toBe(branch[2]?.id ?? null);
  });
});

describe("ConversationTreeWriter — deferred tool save points", () => {
  it("commits a deferred tool call before execution and appends its result later", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("choose"));
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("ask-1"));

    await writer.flushSavePoint(new Set(["ask-1"]));

    expect((await readEntries(tree)).map((entry) => messageContent(entry)?.kind)).toEqual(["user", "assistant"]);

    writer.enqueueMessage(toolResultMessage("ask-1", "User answered: beta"));
    writer.enqueueMessage(assistantMessage("done"));
    await writer.flushSavePoint();

    expect((await tree.buildContext({ allowAssistantTail: true })).messages.map((message) => message.kind)).toEqual(["user", "assistant", "toolResult", "assistant"]);
  });
});

describe("ConversationTreeWriter — flush race", () => {
  it("drains a save point synchronously; later enqueues wait for the next save point", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("ask"));
    writer.beginTurn();
    writer.enqueueMessage(assistantMessage("answer"));
    const flush = writer.flushSavePoint();
    // The SQLite tree append is synchronous, so this enqueue is after the
    // save-point drain and belongs to the next batch.
    writer.enqueueMessage(userMessage("queued during flush"));
    await flush;
    expect(writer.pendingCount()).toBe(1);
    await writer.flushSavePoint();
    const branch = await readEntries(tree);
    expect(branch.length).toBe(3);
    expect(messageContent(branch[2])?.content).toBe("queued during flush");
    expect((await tree.buildContext()).messages.map((message) => message.kind)).toEqual(["user", "assistant", "user"]);
  });

  // A later delivery of the same notification looks for its key, and a
  // second read of one must not fail the turn's save point.
  it("names a background notification's entry by its key, and never fails a save point on a notification the tree already holds", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("ask"));
    writer.beginTurn();
    const notification: ConversationMessage = { kind: "user", content: "exited with code 0", origin: "system", backgroundNotificationIds: ["command:bash-bg-1"], replyRequired: true };
    writer.enqueueMessage(assistantMessage("waiting"));
    writer.enqueueMessage(notification);
    await writer.flushSavePoint();
    expect(messageContent(await tree.getEntry("command:bash-bg-1"))).toMatchObject({ content: "exited with code 0" });

    writer.enqueueMessage(notification);
    await writer.flushSavePoint();

    expect((await readEntries(tree)).length).toBe(4);
  });

  it("back-to-back save-point flushes do not duplicate appends or lose later messages", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("ask"));
    writer.beginTurn();
    writer.enqueueMessage(assistantMessage("answer"));
    const first = writer.flushSavePoint();
    const second = writer.flushSavePoint();
    writer.enqueueMessage(userMessage("raced"));
    await Promise.all([first, second]);
    await writer.flushSavePoint();
    const branch = await readEntries(tree);
    expect(branch.length).toBe(3);
    expect((await tree.buildContext()).messages.map((message) => message.kind)).toEqual(["user", "assistant", "user"]);
  });

});

describe("ConversationTree — projection gate", () => {
  it("refuses a batch that would project adjacent complete assistant messages", async () => {
    await tree.appendMessage(userMessage("hi"));
    await tree.appendMessage(assistantMessage("first"));
    const outcome = await tree.appendMessages([assistantMessage("second")]);
    expect(outcome.kind).toBe("notCommitted");
    expect((await readEntries(tree)).length).toBe(2);
  });

  it("accepts a trailing assistant (prefill resolves at the next user turn)", async () => {
    await tree.appendMessage(userMessage("hi"));
    const outcome = await tree.appendMessages([assistantMessage("answer")]);
    expect(outcome.kind).toBe("committed");
  });

  it("preserves incomplete assistant before continuation", async () => {
    await tree.appendMessage(userMessage("hi"));
    await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "cut off" }], incomplete: true });
    const outcome = await tree.appendMessages([assistantMessage("retried answer")]);
    expect(outcome.kind).toBe("committed");
    await tree.appendMessage(userMessage("next"));
    expect((await tree.buildContext()).messages.map((message) => message.kind)).toEqual([
      "user", "assistant", "assistant", "user",
    ]);
  });

  it("a blocked batch stays pending in the writer and never lands on disk", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("hi"));
    writer.beginTurn();
    writer.enqueueMessage(assistantMessage("first"));
    await writer.flushSavePoint();
    writer.beginTurn();
    writer.enqueueMessage(assistantMessage("second"));
    await expect(writer.flushSavePoint()).rejects.toThrow(/adjacent assistant/);
    expect(writer.pendingCount()).toBe(1);
    expect((await readEntries(tree)).length).toBe(2);
  });
});

describe("ConversationTreeWriter — turn-boundary behavior", () => {
  it("replaces dangling tool_use blocks with a typed gap before a queued follow-up", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("first"));
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("test_call", "lint_call"));
    await writer.commitUserTurn(userMessage("follow-up"));

    await writer.flushSavePoint();

    const branch = await readEntries(tree);
    expect(branch.length).toBe(3);
    const gap = messageContent(branch[1]);
    expect(gap).toMatchObject({ kind: "user", origin: "system" });
    expect(gap?.content).toStartWith("<conversationHistoryGap");
    expect(messageContent(branch[2])?.content).toBe("follow-up");
    expect((await tree.buildContext()).messages.map((message) => message.kind)).toEqual(["user", "user", "user"]);
  });

  it("preserves complete tool results without synthetic entries", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("first"));
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("test_call", "lint_call"));
    for (const result of toolResultMessages([
      ["test_call", "tests passed"],
      ["lint_call", "lint passed"],
    ])) {
      writer.enqueueMessage(result);
    }

    await writer.flushSavePoint();

    const branch = await readEntries(tree);
    expect(branch.length).toBe(4);
    expect(messageContent(branch[1])?.kind).toBe("assistant");
    const results = [branch[2], branch[3]].map((entry) => {
      const persisted = messageContent(entry);
      if (persisted?.kind !== "toolResult") throw new Error("expected toolResult message");
      return persisted;
    });
    expect(results.map((message) => message.toolUseId)).toEqual(["test_call", "lint_call"]);
    expect(results.some((message) => message.interrupted === true)).toBe(false);
    expect(results.map((message) => message.content)).toEqual([
      [{ type: "text", text: "tests passed" }],
      [{ type: "text", text: "lint passed" }],
    ]);
    expect((await tree.buildContext()).messages.map((message) => message.kind)).toEqual(["user", "assistant", "toolResult", "toolResult"]);
  });
});

describe("ConversationTreeWriter — dispose and error surfacing", () => {
  it("keeps the turn in memory when the canonical save point fails, writing no retry marker", async () => {
    let appendCalls = 0;
    const realAppendMessages = tree.appendMessages.bind(tree);
    const append = spyOn(tree, "appendMessages").mockImplementation(async (...args) => {
      appendCalls += 1;
      return appendCalls === 1
        ? realAppendMessages(...args)
        : { kind: "notCommitted", cause: new Error("save point failed") } as const;
    });
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("start"));
    writer.beginTurn();
    writer.enqueueMessage({ kind: "assistant", content: [{ type: "text", text: "partial" }], incomplete: true });

    await expect(writer.flushSavePoint()).rejects.toThrow();

    // The failed save point remains pending for the next flush and is visible
    // to this process's provider context without becoming durable.
    expect(writer.pendingCount()).toBe(1);
    expect((await tree.buildContext({ allowAssistantTail: true })).messages.map((message) => message.kind)).toEqual(["user", "assistant"]);
    expect((await readEntries(tree)).map((entry) => messageContent(entry)?.kind)).toEqual(["user"]);
    const facts = ctx.store.read({ aggregateId: `conversation:${ctx.conversationId}` });
    expect(JSON.stringify(facts)).not.toMatch(/retryMarker|resumed|dedup/i);
    append.mockRestore();

    // The failed drain does not stop the drains after it.
    await writer.flushSavePoint();
    expect(writer.pendingCount()).toBe(0);
    expect((await readEntries(tree)).map((entry) => messageContent(entry)?.kind)).toEqual(["user", "assistant"]);
  });

  it("a failed authoritative flush rejects so the caller can mark the session failed", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("hi"));
    writer.beginTurn();
    await writer.enqueueMessage(assistantMessage("queued"));
    // Force a failure by disposing the underlying storage, then flushing.
    await (await tree.getStorage()).dispose();
    await expect(writer.flushSavePoint()).rejects.toThrow();
  });
});

describe("ConversationTreeWriter — the turn owner declares the phase", () => {
  const systemNotice = (content: string): ConversationMessage => ({ kind: "system", content });
  const branchKinds = async (): Promise<string[]> =>
    (await readEntries(tree)).map((entry) => (entry.kind === "message" ? entry.message.kind : entry.kind));

  function trackedWriter() {
    let recoveries = 0;
    const writer = createConversationTreeWriter({
      tree,
      recoverFinalizedToolResults: async () => { recoveries += 1; },
    });
    return { writer, recoveries: () => recoveries };
  }

  it("stays in-turn after a save point empties the buffer, so a notice queues and runs no recovery", async () => {
    const { writer, recoveries } = trackedWriter();
    await writer.commitUserTurn(userMessage("run the tools"));
    expect(recoveries()).toBe(1);
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("t1"));
    // The assistant barrier: the tool call commits before its tool finishes.
    await writer.flushSavePoint(new Set(["t1"]));
    expect(writer.pendingCount()).toBe(0);

    // A learning-review notice lands while the tool still runs.
    await expect(writer.commitUserTurn(systemNotice("Updated skill"))).resolves.toBeNull();
    expect(recoveries()).toBe(1);
    expect(await branchKinds()).toEqual(["user", "assistant"]);

    writer.enqueueMessage(toolResultMessage("t1", "ok"));
    await writer.flushSavePoint();
    expect(await branchKinds()).toEqual(["user", "assistant", "toolResult", "system"]);

    writer.enqueueMessage(assistantMessage("done"));
    await writer.endTurn();
    const next = await writer.commitUserTurn(userMessage("next"));
    expect(next).not.toBeNull();
    expect(recoveries()).toBe(2);
    expect(await branchKinds()).toEqual(["user", "assistant", "toolResult", "system", "assistant", "user"]);
  });

  it("holds a notice that arrives before the barrier until the exchange closes", async () => {
    const { writer } = trackedWriter();
    await writer.commitUserTurn(userMessage("run the tools"));
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("t1"));
    await expect(writer.commitUserTurn(systemNotice("Updated skill"))).resolves.toBeNull();

    await writer.flushSavePoint(new Set(["t1"]));
    expect(await branchKinds()).toEqual(["user", "assistant"]);

    writer.enqueueMessage(toolResultMessage("t1", "ok"));
    await writer.flushSavePoint();
    expect(await branchKinds()).toEqual(["user", "assistant", "toolResult", "system"]);
  });

  it("releases a held notice at the turn's end even when a call never got its result", async () => {
    const { writer } = trackedWriter();
    await writer.commitUserTurn(userMessage("run the tools"));
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("t1"));
    await writer.flushSavePoint(new Set(["t1"]));
    await expect(writer.commitUserTurn(systemNotice("Interrupted by user."))).resolves.toBeNull();

    await writer.endTurn();
    expect(await branchKinds()).toEqual(["user", "assistant", "system"]);
    await expect(writer.commitUserTurn(userMessage("carry on"))).resolves.not.toBeNull();
  });

  it("keeps a held notice when the turn's own output is suspended", async () => {
    const { writer } = trackedWriter();
    await writer.commitUserTurn(userMessage("ask"));
    writer.beginTurn();
    writer.enqueueMessage(assistantMessage("half a thought"));
    await expect(writer.commitUserTurn(systemNotice("Interrupted by user."))).resolves.toBeNull();

    writer.suspendPending();
    expect(writer.pendingCount()).toBe(0);
    await writer.flushSavePoint();
    expect(await branchKinds()).toEqual(["user", "system"]);
  });
});
