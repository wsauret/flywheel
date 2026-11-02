import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types";
import { createFactParser } from "../../../../src/infra/event-registry";
import { messageInput } from "../../../../src/infra/agent-loop-events";
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop";
import { redactMessage } from "../../../../src/orchestration/agent-runtime/agent-loop-history";
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types";
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer";
import { ChatTurnMailbox } from "../../../../src/orchestration/chat/turn-mailbox";
import { ConversationTreeFactSchemas, parseConversationTreeFact } from "../../../../src/orchestration/session/conversation/conversation-facts";
import { extractTreeFactContent } from "../../../../src/orchestration/session/conversation/conversation-tree-content-extraction";
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle";
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-user-inputs";
import { RequestToolMap } from "../../../helpers/request-tool-surface";
import { makeCaptureClient } from "../agent-runtime/context/_loop-fixtures";
import { createSavePointContext, disposeSavePointContext, type SavePointTestContext } from "./_save-point-fixtures";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

let ctx: SavePointTestContext;
let controller: ReturnType<typeof createConversationTreeWriterController>;

beforeEach(async () => {
  ctx = await createSavePointContext();
  controller = createConversationTreeWriterController({
    conversationId: ctx.conversationId, sessionId: ctx.sessionId,
    projectRoot: ctx.baseDir, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
    projectionReader: asAsyncEventReadSurface(ctx.store),
  });
});

afterEach(async () => {
  await controller.dispose();
  await disposeSavePointContext(ctx);
});

async function reopenedMessages() {
  const tree = await tryOpenConversationTree({ conversationId: ctx.conversationId, sessionId: ctx.sessionId, store: asAsyncEventReadSurface(ctx.store) });
  if (!tree) throw new Error("expected committed conversation");
  try {
    return (await tree.buildContext({ allowAssistantTail: true })).messages;
  } finally {
    tree.getStorage().dispose();
  }
}

describe("explicit human input provenance", () => {
  test("idle human delivery survives canonical persistence and context rebuild", async () => {
    await controller.commitUserTurn({ text: "review this", invocation: { label: "review", args: "this" }, submissionIds: ["idle-1"] });
    expect(await reopenedMessages()).toEqual([
      { kind: "user", content: "review this", origin: "human", invocation: { label: "review", args: "this" }, submissionIds: ["idle-1"] },
    ]);
    const fact = ctx.store.read({ aggregateId: `conversation:${ctx.conversationId}` }).at(-1);
    expect(fact?.version).toBe(3);
    if (!fact) throw new Error("expected committed fact");
    expect(() => parseConversationTreeFact({ type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload })).not.toThrow();
    expect(() => createFactParser(ConversationTreeFactSchemas)({ type: fact.type, version: fact.version, actor: fact.actor, payload: fact.payload })).not.toThrow();
    for (const version of [1, 2]) {
      expect(() => parseConversationTreeFact({ type: fact.type, version, actor: fact.actor, payload: fact.payload })).toThrow();
    }
  });

  test("separate queued humans reach one provider request and durable history with explicit provenance", async () => {
    await controller.commitUserTurn("initial request");
    const mailbox = new ChatTurnMailbox();
    const first = await controller.holdQueuedUserInput("first");
    const second = await controller.holdQueuedUserInput("second");
    if (!first || !second) throw new Error("expected queued dispatch keys");
    mailbox.enqueueNextTurn({ text: "first", dispatchIds: [first], submissionIds: ["queued-1"] });
    mailbox.enqueueNextTurn({ text: "second", dispatchIds: [second], submissionIds: ["queued-2"] });
    const { client, capturedMessages } = makeCaptureClient([{ events: [
      { kind: "text_delta", text: "Done.", blockKey: "done" },
      { kind: "done", stopReason: "end_turn" },
    ] }]);
    controller.beginTurn();
    const result = await runAgentLoop({
      client, tools: new RequestToolMap(), systemPrompt: stableSystemPrompt("test"), instruction: "",
      executionCwd: ctx.baseDir, userDataRoot: `${ctx.baseDir}/.test-account`, projectRoot: ctx.baseDir,
      providerSessionKey: "human-provenance", promptCacheKey: "human-provenance", artifactScopeId: "human-provenance",
      retrievalSessionId: ctx.sessionId, onEvent: () => {},
      seed: { kind: "resume", priorMessages: (await controller.buildContext()).messages },
      persistence: { history: { append: (message) => controller.recordCanonicalMessage(message) } },
      inputSource: {
        drainPending: () => mailbox.drainPending(),
        prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }),
      },
    });
    expect(result.kind).toBe("input_closed");
    await controller.endTurn();
    const queued = [
      { kind: "user", content: "first", origin: "human", submissionIds: ["queued-1"] },
      { kind: "user", content: "second", origin: "human", submissionIds: ["queued-2"] },
    ] satisfies ConversationMessage[];
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0]?.filter(message => message.kind === "user" && message.origin === "human")).toEqual([
      expect.objectContaining({ content: "initial request" }),
      ...queued.map(message => expect.objectContaining(message)),
    ]);
    expect((await reopenedMessages()).filter(message => message.kind === "user" && message.origin === "human")).toEqual([
      expect.objectContaining({ content: "initial request" }),
      ...queued,
    ]);
    expect(ctx.store.readInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([]);
  });

  test("a held human message adopted before its request's admission fails commits once, and recovery does not add a second copy", async () => {
    await controller.commitUserTurn("initial request");
    const key = await controller.holdQueuedUserInput({ text: "sent while parked", submissionIds: ["parked-1"] });
    if (!key) throw new Error("expected a queued dispatch key");
    const base = new RequestToolMap();
    let resolves = 0;
    // The first request admits; the request the parked message starts is refused.
    const tools = {
      async resolve() {
        resolves += 1;
        if (resolves === 2) throw new Error("admission refused");
        return base.resolve();
      },
      current: () => base.current(),
    };
    const { client } = makeCaptureClient([{ events: [
      { kind: "text_delta", text: "Done.", blockKey: "done" },
      { kind: "done", stopReason: "end_turn" },
    ] }]);
    const mailbox = new ChatTurnMailbox();
    controller.beginTurn();
    const run = runAgentLoop({
      client, tools, systemPrompt: stableSystemPrompt("test"), instruction: "",
      executionCwd: ctx.baseDir, userDataRoot: `${ctx.baseDir}/.test-account`, projectRoot: ctx.baseDir,
      providerSessionKey: "human-provenance", promptCacheKey: "human-provenance", artifactScopeId: "human-provenance",
      retrievalSessionId: ctx.sessionId, onEvent: () => {},
      seed: { kind: "resume", priorMessages: (await controller.buildContext()).messages },
      persistence: { history: { append: (message) => controller.recordCanonicalMessage(message) } },
      inputSource: mailbox,
      // The person sends while the loop is parked after its first answer.
      lifecycle: { onTurnParked: () => { mailbox.enqueueNextTurn({ text: "sent while parked", dispatchIds: [key], submissionIds: ["parked-1"] }); } },
    });
    await expect(run).rejects.toThrow("admission refused");
    // The failed runner's disposal ends its turn, which drains the adopted message.
    await controller.endTurn();
    const sent = { kind: "user", content: "sent while parked", origin: "human", submissionIds: ["parked-1"] } satisfies ConversationMessage;
    const copies = (messages: readonly ConversationMessage[]) => messages.filter((message) => message.kind === "user" && message.content === sent.content);
    expect(copies(await reopenedMessages())).toEqual([expect.objectContaining(sent)]);
    expect(ctx.store.readInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([]);

    // A restart recovers held input before its next commit; the message is not restored twice.
    await controller.dispose();
    controller = createConversationTreeWriterController({
      conversationId: ctx.conversationId, sessionId: ctx.sessionId,
      projectRoot: ctx.baseDir, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
    });
    await controller.commitUserTurn("resume");
    expect(copies(await reopenedMessages())).toHaveLength(1);
  });

  test("held human input recovers with its stamp while old unmarked held input stays unknown", async () => {
    await controller.commitUserTurn("initial request");
    await controller.holdQueuedUserInput({ text: "held human", attachments: [{ marker: "image", mediaType: "image/png", data: "abc" }], submissionIds: ["held-1"] });
    ctx.store.putInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "old-held", { conversationId: ctx.conversationId, text: "old held input" });
    // A cell held before attachments had their name spelled the field `images`.
    ctx.store.putInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "old-image", { conversationId: ctx.conversationId, text: "old image", images: [{ marker: "[Image #1]", mediaType: "image/png", data: "old" }] });
    await controller.dispose();
    controller = createConversationTreeWriterController({
      conversationId: ctx.conversationId, sessionId: ctx.sessionId,
      projectRoot: ctx.baseDir, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
    });
    await controller.commitUserTurn("resume");
    expect(await reopenedMessages()).toContainEqual({ kind: "user", origin: "human", submissionIds: ["held-1"], content: [
      { type: "text", text: "held human" }, { type: "image", mediaType: "image/png", data: "abc" },
    ] });
    expect(await reopenedMessages()).toContainEqual({ kind: "user", content: "old held input" });
    expect(await reopenedMessages()).toContainEqual({ kind: "user", content: [{ type: "text", text: "old image" }, { type: "image", mediaType: "image/png", data: "old" }] });
    expect(ctx.store.readInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([]);
  });

  test("a held message from another session commits one canonical entry under its cell key with the sender as producer", async () => {
    await controller.commitUserTurn("initial request");
    const producer = {
      kind: "session" as const, sessionId: "parent-session", conversationId: "parent-conversation", toolUseId: "tool-retry", hop: 2,
      envelope: { name: "Root", relation: "parent" as const, waits: false, personWords: "use the old parser" },
    };
    const key = await controller.holdQueuedUserInput({ text: "revise the parser", producer });
    expect(key).toBe("msg:parent-session:tool-retry");

    await controller.dispose();
    controller = createConversationTreeWriterController({
      conversationId: ctx.conversationId, sessionId: ctx.sessionId,
      projectRoot: ctx.baseDir, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
    });
    await controller.commitUserTurn("resume");

    expect(await reopenedMessages()).toContainEqual({ kind: "user", content: "revise the parser", producer });
    const facts = ctx.store.read({ aggregateId: `conversation:${ctx.conversationId}` });
    const carrying = facts.find((fact) => JSON.stringify(fact.payload).includes("revise the parser"));
    expect(carrying?.version).toBe(5);
    expect(JSON.stringify(carrying?.payload)).toContain(`"id":"${key}"`);
    // A fact without a session producer keeps the version an older build reads.
    expect(facts.at(-1)?.version).toBe(3);
    expect(ctx.store.readInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([]);
  });

  test("a stored parent-agent entry and a held parent-agent cell read as the session producer with hop 0", async () => {
    await controller.commitUserTurn("initial request");
    const leaf = await controller.getLeafId();
    await controller.dispose();
    // The shapes a build before 2026-10-03 wrote for a parent's steering.
    const oldProducer = { kind: "parent-agent", parentSessionId: "parent-session", parentConversationId: "parent-conversation", authorizingToolCallId: "tool-old" };
    ctx.store.append({
      aggregateId: `conversation:${ctx.conversationId}`, type: "chat.entries.appended", version: 3, actor: "flywheel",
      sessionId: ctx.sessionId, timestamp: Date.now(),
      payload: { conversationId: ctx.conversationId, entries: [{ id: "old-steer", parentId: leaf, timestamp: new Date().toISOString(), kind: "message", message: { kind: "user", content: "stored steering", producer: oldProducer } }] },
    });
    ctx.store.putInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "old-held", { conversationId: ctx.conversationId, text: "held steering", producer: { ...oldProducer, authorizingToolCallId: "tool-held" } });
    controller = createConversationTreeWriterController({
      conversationId: ctx.conversationId, sessionId: ctx.sessionId,
      projectRoot: ctx.baseDir, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
    });
    await controller.commitUserTurn("resume");

    const converted = { kind: "session" as const, sessionId: "parent-session", conversationId: "parent-conversation", hop: 0 };
    const messages = await reopenedMessages();
    expect(messages).toContainEqual({ kind: "user", content: "stored steering", producer: { ...converted, toolUseId: "tool-old" } });
    expect(messages).toContainEqual({ kind: "user", content: "held steering", producer: { ...converted, toolUseId: "tool-held" } });
  });

  test("a stored version 4 session message and a held cell without an envelope read as plain session messages", async () => {
    await controller.commitUserTurn("initial request");
    const leaf = await controller.getLeafId();
    await controller.dispose();
    // The shapes a build before 2026-10-03 wrote for a session message: a
    // session producer with no envelope.
    const producer = { kind: "session" as const, sessionId: "sender-session", conversationId: "sender-conversation", toolUseId: "tool-v4", hop: 1 };
    ctx.store.append({
      aggregateId: `conversation:${ctx.conversationId}`, type: "chat.entries.appended", version: 4, actor: "flywheel",
      sessionId: ctx.sessionId, timestamp: Date.now(),
      payload: { conversationId: ctx.conversationId, entries: [{ id: "msg:sender-session:tool-v4", parentId: leaf, timestamp: new Date().toISOString(), kind: "message", message: { kind: "user", content: "stored message", producer } }] },
    });
    ctx.store.putInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "msg:sender-session:tool-held", { conversationId: ctx.conversationId, text: "held message", producer: { ...producer, toolUseId: "tool-held" } });
    controller = createConversationTreeWriterController({
      conversationId: ctx.conversationId, sessionId: ctx.sessionId,
      projectRoot: ctx.baseDir, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
    });
    await controller.commitUserTurn("resume");

    const messages = await reopenedMessages();
    expect(messages).toContainEqual({ kind: "user", content: "stored message", producer });
    expect(messages).toContainEqual({ kind: "user", content: "held message", producer: { ...producer, toolUseId: "tool-held" } });
  });

  test("a stored version 5 session message and an assignment without a producer read as they were stored", async () => {
    await controller.commitUserTurn("initial request");
    const leaf = await controller.getLeafId();
    await controller.dispose();
    // The shapes a build before 2026-10-04 wrote: a version 5 session message
    // with its envelope, and a subagent's assignment with no producer.
    const producer = {
      kind: "session" as const, sessionId: "sender-session", conversationId: "sender-conversation", toolUseId: "tool-v5", hop: 0,
      envelope: { name: "Root", relation: "parent" as const, waits: true },
    };
    ctx.store.append({
      aggregateId: `conversation:${ctx.conversationId}`, type: "chat.entries.appended", version: 5, actor: "flywheel",
      sessionId: ctx.sessionId, timestamp: Date.now(),
      payload: { conversationId: ctx.conversationId, entries: [
        { id: "old-assignment", parentId: leaf, timestamp: new Date().toISOString(), kind: "message", message: { kind: "user", content: "stored assignment" } },
        { id: "msg:sender-session:tool-v5", parentId: "old-assignment", timestamp: new Date().toISOString(), kind: "message", message: { kind: "user", content: "stored message", producer } },
      ] },
    });
    controller = createConversationTreeWriterController({
      conversationId: ctx.conversationId, sessionId: ctx.sessionId,
      projectRoot: ctx.baseDir, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store),
      projectionReader: asAsyncEventReadSurface(ctx.store),
    });

    const messages = await reopenedMessages();
    expect(messages).toContainEqual({ kind: "user", content: "stored assignment" });
    expect(messages).toContainEqual({ kind: "user", content: "stored message", producer });
  });

  test("system turns and held background notifications retain their existing provenance", async () => {
    await controller.commitSystemTurn("assembled workflow prompt");
    const notification = await controller.holdBackgroundNotification("background result");
    if (notification === undefined) throw new Error("an unkeyed notification is always held");
    await controller.commitBackgroundNotification(notification);
    expect(await reopenedMessages()).toEqual([
      { kind: "user", content: "assembled workflow prompt", origin: "system" },
      {
        kind: "user",
        content: "background result",
        origin: "system",
        replyRequired: true,
      },
    ]);
    expect(messageInput("unclassified producer")).not.toHaveProperty("origin");
    expect(redactMessage({ kind: "user", content: "child seed" }, false)).toMatchObject({ origin: "system" });
  });

  test("a live keyed background notification commits under its durable hold key", async () => {
    await controller.commitUserTurn("initial request");
    const notification = await controller.holdBackgroundNotification(
      "Workflow completed. Review the terminal result.",
      "workflow-completion:child",
    );
    if (notification === undefined) throw new Error("a key nothing committed yet is held");
    const mailbox = new ChatTurnMailbox();
    mailbox.enqueueBackgroundNotification(notification);
    const { client } = makeCaptureClient([{ events: [
      { kind: "text_delta", text: "Reviewing now.", blockKey: "done" },
      { kind: "done", stopReason: "end_turn" },
    ] }]);
    controller.beginTurn();
    await runAgentLoop({
      client, tools: new RequestToolMap(), systemPrompt: stableSystemPrompt("test"), instruction: "",
      executionCwd: ctx.baseDir, userDataRoot: `${ctx.baseDir}/.test-account`, projectRoot: ctx.baseDir,
      providerSessionKey: "background-provenance", promptCacheKey: "background-provenance", artifactScopeId: "background-provenance",
      retrievalSessionId: ctx.sessionId, onEvent: () => {},
      seed: { kind: "resume", priorMessages: (await controller.buildContext()).messages },
      persistence: { history: { append: (message) => controller.recordCanonicalMessage(message) } },
      inputSource: {
        drainPending: () => mailbox.drainPending(),
        prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }),
      },
      humanFacing: true,
      flushCanonicalMessages: () => controller.flushSavePoint(),
    });
    await controller.endTurn();

    const tree = await tryOpenConversationTree({ conversationId: ctx.conversationId, sessionId: ctx.sessionId, store: asAsyncEventReadSurface(ctx.store) });
    if (!tree) throw new Error("expected committed conversation");
    const entry = await tree.getEntry("workflow-completion:child");
    tree.getStorage().dispose();
    expect(entry).toMatchObject({
      kind: "message",
      message: {
        kind: "user",
        content: "Workflow completed. Review the terminal result.",
        origin: "system",
        replyRequired: true,
      },
    });
  });

  test("historical version-1 and version-2 unmarked messages stay unknown and readable", async () => {
    let parentId: string | null = null;
    for (const version of [1, 2]) {
      const id = `legacy-${version}`;
      ctx.store.append({
        aggregateId: `conversation:${ctx.conversationId}`, sessionId: ctx.sessionId,
        type: "chat.entries.appended", version, actor: "flywheel", timestamp: Date.now(),
        payload: { conversationId: ctx.conversationId, entries: [{
          kind: "message", id, parentId, timestamp: new Date().toISOString(),
          message: { kind: "user", content: id },
        }] },
      });
      parentId = id;
    }
    expect(await reopenedMessages()).toEqual([
      { kind: "user", content: "legacy-1" }, { kind: "user", content: "legacy-2" },
    ]);
    await controller.commitUserTurn("new human");
    expect((await reopenedMessages()).slice(0, 2)).toEqual([
      { kind: "user", content: "legacy-1" }, { kind: "user", content: "legacy-2" },
    ]);
  });

  test("current referenced tool content keeps the human-capable fact version", () => {
    const extracted = extractTreeFactContent({
      type: "chat.entries.appended", version: 3, actor: "flywheel",
      payload: { conversationId: ctx.conversationId, entries: [{
        kind: "message", id: "result", parentId: "call", timestamp: new Date().toISOString(),
        message: { kind: "toolResult", toolUseId: "tool", content: [{ type: "text", text: "large result ".repeat(1_000) }] },
      }] },
    });
    expect(extracted.fact.version).toBe(3);
    expect(extracted.contentRows).toHaveLength(1);
    expect(() => parseConversationTreeFact(extracted.fact)).not.toThrow();
  });

  test("current referenced tool content hydrates beside an explicit human turn", async () => {
    await controller.commitUserTurn("run this");
    controller.beginTurn();
    await controller.recordCanonicalMessage({ kind: "assistant", content: [{ type: "tool_use", id: "tool", name: "read", input: {} }] });
    const result = { kind: "toolResult" as const, toolUseId: "tool", content: [{ type: "text" as const, text: "large result ".repeat(1_000) }] };
    await controller.recordCanonicalMessage(result);
    await controller.endTurn();
    expect(await reopenedMessages()).toEqual([
      { kind: "user", content: "run this", origin: "human" },
      { kind: "assistant", content: [{ type: "tool_use", id: "tool", name: "read", input: {} }] },
      result,
    ]);
  });
});
