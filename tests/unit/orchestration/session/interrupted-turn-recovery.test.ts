import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types";
import { hydrateToolContentFact } from "../../../../src/infra/tool-content-hydration";
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store";
import { resolveEventStoreDbFile } from "../../../../src/infra/paths";
import { createConversationTreeWriter } from "../../../../src/orchestration/session/conversation/conversation-tree-writer";
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle";
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-user-inputs";
import { holdQueuedBackgroundNotification, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications";
import type { ConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree";
import {
  assistantMessage,
  assistantToolUseMessage,
  attachingProcess,
  createSavePointContext,
  disposeSavePointContext,
  readEntries,
  toolResultMessage,
  userMessage,
  type SavePointTestContext,
} from "./_save-point-fixtures";
import {
  checkpointFinalizedToolResult,
  recoverFinalizedToolResultCheckpoints,
} from "../../../../src/orchestration/session/finalized-tool-result-checkpoint";
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer";
import { chatTurnEndOf, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record";

// An interrupted turn is reported from the facts its actions already wrote, not
// from a durable copy of its unfinished prose. These tests hold that line from
// both ends: the turn in progress costs no fact, and a process attaching after
// the writer died still learns what that turn did.

let ctx: SavePointTestContext;
let tree: ConversationTree;

beforeEach(async () => {
  ctx = await createSavePointContext();
  tree = ctx.tree;
});

afterEach(async () => {
  await disposeSavePointContext(ctx);
});

function conversationFacts(): string[] {
  return ctx.store.read({ aggregateId: `conversation:${ctx.conversationId}` }).map((event) => event.type);
}

async function reopenContextStore(): Promise<ConversationTree> {
  await (await ctx.tree.getStorage()).dispose();
  ctx.store.close();
  ctx.store = createSqliteEventStore(resolveEventStoreDbFile(ctx.baseDir));
  const reopened = await tryOpenConversationTree({ conversationId: ctx.conversationId, sessionId: ctx.sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) });
  if (!reopened) throw new Error(`expected conversation tree ${ctx.conversationId}`);
  ctx.tree = reopened;
  tree = reopened;
  return reopened;
}

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

let requestCount = 0;

/** A provider request of one conversation, which every call it makes names. */
function recordRequest(conversationId = ctx.conversationId): string {
  const requestId = `request-${++requestCount}`;
  ctx.store.append({
    aggregateId: `session:${ctx.sessionId}`,
    sessionId: ctx.sessionId,
    type: "model.requested",
    version: 5,
    timestamp: Date.now(),
    actor: "flywheel",
    payload: {
      requestId,
      identity: { providerSessionKey: conversationId, conversationId },
      turn: 1,
      model: "test-model",
      accessProvider: "openai_api",
      modelFamily: "openai",
      interactionProfileId: "default",
    },
  });
  return requestId;
}

function recordToolCall(toolName: string, toolUseId: string, modelRequestId = recordRequest()): void {
  recordSessionFact("tool.input.completed", { toolUseId, toolName, modelRequestId, input: {} });
}

function recordToolResult(toolUseId: string): void {
  recordSessionFact("tool.result.recorded", { toolUseId, outcome: "ok" });
}

function recordFileChange(displayPath: string, toolUseId: string): void {
  recordSessionFact("file.changed", { path: `/abs/${displayPath}`, displayPath, changeKind: "modified", before: null, after: null, toolUseId });
}

describe("a turn in progress", () => {
  it("costs no durable fact until its save point", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("ask"));
    const afterUserTurn = conversationFacts().length;

    writer.beginTurn();
    await writer.enqueueMessage(assistantToolUseMessage("t1"));
    await writer.enqueueMessage(toolResultMessage("t1", "ok"));
    writer.enqueueMessage(assistantMessage("done"));

    expect(conversationFacts().length).toBe(afterUserTurn);
    expect(writer.pendingCount()).toBe(3);
  });

  it("is visible to the process writing it, so a continuing turn sees its own output", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("ask"));
    writer.beginTurn();
    await writer.enqueueMessage(assistantToolUseMessage("t1"));
    await writer.enqueueMessage(toolResultMessage("t1", "ok"));

    expect((await tree.buildContext()).messages.map((message) => message.kind)).toEqual(["user", "assistant", "toolResult"]);
  });

  it("commits as one batch that the branch shows exactly once", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("ask"));
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("t1"));
    writer.enqueueMessage(toolResultMessage("t1", "ok"));
    writer.enqueueMessage(assistantMessage("done"));

    await writer.flushSavePoint();

    expect(conversationFacts().filter((type) => type === "chat.entries.appended").length).toBe(2);
    const branch = await readEntries(tree);
    expect(branch.map((entry) => (entry.kind === "message" ? entry.message.kind : entry.kind))).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });

  it("is dropped, not committed, when the writer suspends", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("ask"));
    writer.beginTurn();
    writer.enqueueMessage(assistantMessage("half a thought"));

    writer.suspendPending();

    expect(writer.pendingCount()).toBe(0);
    expect((await tree.buildContext()).messages.map((message) => message.kind)).toEqual(["user"]);
  });
});

describe("a turn a dead process left unfinished", () => {
  /** A process that resumes the conversation: it attaches to the store alone
   *  and commits the turn that continues the work. */
  async function resume(text: string): Promise<ConversationTree> {
    const resumed = await attachingProcess(ctx);
    const resumedWriter = createConversationTreeWriter({ tree: resumed });
    await resumedWriter.commitUserTurn(userMessage(text));
    return resumed;
  }

  it("is recorded in the conversation, naming what it ran and changed", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("fix the parser"));
    writer.beginTurn();
    // The actions commit as they happen. The reply never reaches its save point.
    recordToolCall("edit_file", "t1");
    recordFileChange("src/parser.ts", "t1");
    writer.enqueueMessage(assistantMessage("I have started on"));

    const resumed = await resume("carry on");

    const record = (await resumed.getBranch()).at(-2);
    const text = record?.kind === "message" && record.message.kind === "user" ? String(record.message.content) : "";
    expect(text).toContain("edit_file");
    expect(text).toContain("src/parser.ts");
    expect(text).toContain("exited before the turn finished");
    // Marked system-produced, so the transcript does not show it as the user's.
    expect(record?.kind === "message" && record.message.kind === "user" && record.message.origin).toBe("system");
  });

  it("is recorded ahead of held work an idle writer commits, as it is ahead of a message, so Resume still finds it", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("fix the parser"));
    writer.beginTurn();
    recordToolCall("edit_file", "t1");
    writer.enqueueMessage(assistantMessage("I have started on"));

    await asAsyncEventWriter(ctx.store).swapInFlight?.(ctx.sessionId, "workflow.launch", "operation-1", null, { operationId: "operation-1" });
    const [cell] = ctx.store.readInFlight(ctx.sessionId, "workflow.launch");
    if (!cell) throw new Error("expected the accepted cell");
    const noticeId = turnEndEntryId({ reason: "settled" }, "operation-1");
    const resumed = await attachingProcess(ctx);
    await createConversationTreeWriter({ tree: resumed }).acceptRetainedOperation({
      kind: "workflow.launch",
      key: "operation-1",
      commit: async () => ({ kind: "refused", notice: { kind: "user", content: "The qa workflow could not start: required skills are missing", origin: "system" }, noticeId, retire: { op: "swap", kind: cell.kind, key: cell.key, expectedRaw: cell.raw, payload: null } }),
    });

    const branch = await resumed.getBranch();
    expect(branch.at(-1)?.id).toBe(noticeId);
    const record = branch.at(-2);
    expect(record?.kind === "message" && record.message.kind === "user" ? String(record.message.content) : "").toContain("edit_file");
    expect(chatTurnEndOf(branch)).toEqual({ end: { reason: "crash" }, recorded: true });
  });

  it("records nothing when the turn did nothing durable", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("hello"));
    writer.beginTurn();
    writer.enqueueMessage(assistantMessage("thinking out loud"));

    const resumed = await resume("carry on");

    expect(JSON.stringify(await resumed.getBranch())).not.toContain("exited before the turn finished");
  });

  it("records nothing for work the committed branch already accounts for", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("fix it"));
    writer.beginTurn();
    // The assistant barrier commits the call before it runs, so its result
    // fact lands after the last assistant commit, and the save point that
    // follows commits the result itself. A turn parked on a process wait
    // ends here, with no assistant reply after its results. A nested call
    // that Code Mode made has no result entry of its own: its parent's
    // committed result answers it.
    const requestId = recordRequest();
    recordToolCall("code", "t1", requestId);
    recordToolCall("process", "t2", requestId);
    await writer.enqueueMessage(assistantToolUseMessage("t1", "t2"));
    await writer.flushSavePoint(new Set(["t1", "t2"]));
    recordSessionFact("tool.input.completed", { toolUseId: "t1#1", toolName: "edit_file", modelRequestId: requestId, parentToolUseId: "t1", input: {} });
    recordFileChange("src/parser.ts", "t1#1");
    recordSessionFact("tool.result.recorded", { toolUseId: "t1#1", parentToolUseId: "t1", outcome: "ok" });
    recordToolResult("t1");
    recordToolResult("t2");
    await writer.enqueueMessage(toolResultMessage("t1", "edited"));
    await writer.enqueueMessage(toolResultMessage("t2", "waiting"));
    await writer.endTurn();

    // The live writer's own notice while parked, then another process.
    await writer.commitUserTurn({ kind: "user", content: "Updated a skill.", origin: "system" });
    const resumed = await resume("carry on");

    expect(JSON.stringify(await resumed.getBranch())).not.toContain("exited before the turn finished");
  });

  it("is recorded once however many processes recover it, and once per interruption", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("fix the parser"));
    writer.beginTurn();
    recordToolCall("edit_file", "t1");

    // Two processes race the same recovery, then a third turn follows.
    await resume("carry on");
    await resume("still there?");
    const resumed = await resume("hello?");

    const records = (await resumed.getBranch())
      .filter((entry) => entry.kind === "message" && entry.message.kind === "user" && String(entry.message.content).includes("exited before"));
    expect(records).toHaveLength(1);
  });

  it("separates tools that finished from calls whose results were lost", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("fix the parser"));
    writer.beginTurn();
    recordToolCall("read_file", "t1");
    recordToolResult("t1");
    // The crash lands between the input completing and the tool executing.
    recordToolCall("bash", "t2");

    const resumed = await resume("carry on");

    const record = (await resumed.getBranch()).at(-2);
    const text = record?.kind === "message" && record.message.kind === "user" ? String(record.message.content) : "";
    expect(text).toContain("Tools that finished: read_file");
    expect(text).toContain("may not have run: bash");
  });

  it("never claims another conversation's work in the same session", async () => {
    // A workflow session runs one conversation tree per step under one
    // sessionId. Step 1's facts precede step 2's tree creation, so a fresh
    // step must not open with a crash record naming the previous step's work.
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("step 1"));
    writer.beginTurn();
    recordToolCall("edit_file", "t1");
    recordFileChange("src/step-one.ts", "t1");

    const second = await createConversationTree({ conversationId: "step-two", sessionId: ctx.sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) });
    const secondWriter = createConversationTreeWriter({ tree: second });
    await secondWriter.commitUserTurn(userMessage("step 2 prompt"));

    expect(JSON.stringify(await second.getBranch())).not.toContain("exited before the turn finished");

    // Work recorded after the second tree existed is the second tree's own
    // only when its own request made the call: a step running in parallel
    // records its calls into the same session at the same time.
    recordToolCall("bash", "t2", recordRequest("step-two"));
    recordToolCall("grep", "t3");
    recordToolResult("t3");
    const secondResumed = await tryOpenConversationTree({ conversationId: "step-two", sessionId: ctx.sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) });
    if (!secondResumed) throw new Error("expected conversation tree step-two");
    await createConversationTreeWriter({ tree: secondResumed }).commitUserTurn(userMessage("carry on"));
    const text = JSON.stringify(await secondResumed.getBranch());
    expect(text).toContain("bash");
    expect(text).not.toContain("edit_file");
    expect(text).not.toContain("grep");
  });

  it("records a second crash even when no assistant commit separates the two", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("fix the parser"));
    writer.beginTurn();
    recordToolCall("edit_file", "t1");

    // Crash 1 -> resume records it; the resumed turn crashes again before any
    // assistant save point.
    await resume("carry on");
    recordToolCall("bash", "t2");

    const second = await resume("what happened?");

    const records = (await second.getBranch())
      .filter((entry) => entry.kind === "message" && entry.message.kind === "user" && String(entry.message.content).includes("exited before"));
    expect(records).toHaveLength(2);
    const latest = records.at(-1);
    expect(latest?.kind === "message" ? String(latest.message.content) : "").toContain("bash");
  });

  it("records a second interruption after the first was answered", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("fix the parser"));
    writer.beginTurn();
    recordToolCall("edit_file", "t1");

    const first = await resume("carry on");
    const firstWriter = createConversationTreeWriter({ tree: first });
    firstWriter.beginTurn();
    firstWriter.enqueueMessage(assistantMessage("Picking up from the edit."));
    await firstWriter.flushSavePoint();
    // The second process dies mid-turn too.
    recordToolCall("bash", "t2");

    const second = await resume("what happened?");

    const records = (await second.getBranch())
      .filter((entry) => entry.kind === "message" && entry.message.kind === "user" && String(entry.message.content).includes("exited before"));
    expect(records).toHaveLength(2);
    const latest = records.at(-1);
    expect(latest?.kind === "message" ? String(latest.message.content) : "").toContain("bash");
  });

  it("leaves a checkpoint written in a shape this release cannot finish in place and recovers the rest", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("inspect the file"));
    recordToolCall("read_first", "t1");
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("t1"));
    await writer.flushSavePoint(new Set(["t1"]));

    const checkpointWriter = createSessionFactWriter({
      sessionId: ctx.sessionId,
      writer: asAsyncEventWriter(ctx.store),
    });
    try {
      // The shape a 2026-09-04 binary wrote: no conversation, tool name,
      // budget flag, or ordinal. No current contract can finish it.
      if (!checkpointWriter.putInFlight) throw new Error("expected an in-flight writer");
      await checkpointWriter.putInFlight("finalized-tool-result", "legacy", {
        toolUseId: "legacy",
        content: [{ type: "text", text: "from an older binary" }],
        outcome: "ok",
      });
      await checkpointFinalizedToolResult(checkpointWriter, {
        conversationId: ctx.conversationId,
        toolUseId: "t1",
        toolName: "read_first",
        budgetExempt: true, turnBudgetChars: 200_000,
        registrationOrdinal: 0,
        content: [{ type: "text", text: "first result" }],
        outcome: "ok",
      });
    } finally {
      checkpointWriter.dispose();
    }

    const resumed = await attachingProcess(ctx);
    await recoverFinalizedToolResultCheckpoints({
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      store: asAsyncEventReadSurface(ctx.store),
      writer: asAsyncEventWriter(ctx.store),
      tree: resumed,
    });

    expect(ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.result.recorded"] })
      .map((fact) => fact.payload.toolUseId)).toEqual(["t1"]);
    expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result").map((row) => row.key)).toEqual(["legacy"]);
  });

  it("recovers finalized checkpoints in registration order before interruption history", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("inspect both files"));
    recordToolCall("read_second", "t2");
    recordToolCall("read_first", "t1");
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("t1", "t2"));
    await writer.flushSavePoint(new Set(["t1", "t2"]));

    const checkpointWriter = createSessionFactWriter({
      sessionId: ctx.sessionId,
      writer: asAsyncEventWriter(ctx.store),
    });
    try {
      await checkpointFinalizedToolResult(checkpointWriter, {
        conversationId: ctx.conversationId,
        toolUseId: "t2",
        toolName: "read_second",
        budgetExempt: true, turnBudgetChars: 200_000,
        registrationOrdinal: 1,
        content: [{ type: "text", text: "second result" }],
        outcome: "ok",
        executionOutputTail: "second tail",
      });
      await checkpointFinalizedToolResult(checkpointWriter, {
        conversationId: ctx.conversationId,
        toolUseId: "t1",
        toolName: "read_first",
        budgetExempt: true, turnBudgetChars: 200_000,
        registrationOrdinal: 0,
        content: [{ type: "text", text: "first result" }],
        outcome: "ok",
      });
    } finally {
      checkpointWriter.dispose();
    }

    const resumed = await attachingProcess(ctx);
    await recoverFinalizedToolResultCheckpoints({
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      store: asAsyncEventReadSurface(ctx.store),
      writer: asAsyncEventWriter(ctx.store),
      tree: resumed,
    });
    await createConversationTreeWriter({ tree: resumed }).commitUserTurn(userMessage("carry on"));

    const branch = await resumed.getBranch();
    const recoveredResults = branch.filter((entry) => entry.kind === "message" && entry.message.kind === "toolResult");
    expect(recoveredResults.map((entry) => entry.kind === "message" && entry.message.kind === "toolResult" ? entry.message.toolUseId : "")).toEqual(["t1", "t2"]);
    expect(JSON.stringify((await resumed.buildContext()).messages)).toContain("first result");
    expect(JSON.stringify((await resumed.buildContext()).messages)).toContain("second result");
    const resumeIndex = branch.findIndex((entry) => entry.kind === "message" && entry.message.kind === "user" && entry.message.content === "carry on");
    const interruptionIndex = branch.findIndex((entry) => entry.kind === "message" && entry.message.kind === "user"
      && String(entry.message.content).includes("exited before the turn finished"));
    expect(interruptionIndex).toBeGreaterThan(recoveredResults.length);
    expect(interruptionIndex).toBeLessThan(resumeIndex);
    expect(ctx.store.readInFlight(ctx.sessionId, "finalized-tool-result")).toEqual([]);
    expect(ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.result.recorded"] })
      .map((fact) => fact.payload.toolUseId)).toEqual(["t1", "t2"]);
    expect(ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.execution_output.recorded"] })[0]?.payload)
      .toMatchObject({ toolUseId: "t2", output: "second tail" });
  });

  it("reuses ordinary result evidence and reconstructs only the missing model derivative", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("inspect once"));
    writer.beginTurn();
    writer.enqueueMessage(assistantToolUseMessage("t1"));
    await writer.flushSavePoint(new Set(["t1"]));
    recordToolCall("read_file", "t1");
    recordToolResult("t1");
    ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", `${ctx.conversationId}:t1`, {
      conversationId: ctx.conversationId,
      toolUseId: "t1",
      toolName: "read_file",
      budgetExempt: true,
      registrationOrdinal: 0,
      content: [{ type: "text", text: "durable model result" }],
      outcome: "ok",
    });

    const resumed = await attachingProcess(ctx);
    await recoverFinalizedToolResultCheckpoints({
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      store: asAsyncEventReadSurface(ctx.store),
      writer: asAsyncEventWriter(ctx.store),
      tree: resumed,
    });

    expect(ctx.store.read({ aggregateId: `session:${ctx.sessionId}`, types: ["tool.result.recorded"] })).toHaveLength(1);
    expect((await resumed.getBranch()).filter((entry) => entry.kind === "message"
      && entry.message.kind === "toolResult"
      && entry.message.toolUseId === "t1")).toHaveLength(1);
    expect(JSON.stringify((await resumed.buildContext()).messages)).toContain("durable model result");
  });

  it("preserves nested parent identity and exact large content without adding a top-level derivative", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("inspect nested work"));
    const large = "nested exact output\n".repeat(180);
    ctx.store.putInFlight(ctx.sessionId, "finalized-tool-result", `${ctx.conversationId}:nested-result`, {
      conversationId: ctx.conversationId,
      toolUseId: "nested-result",
      toolName: "nested",
      budgetExempt: false,
      registrationOrdinal: 0,
      parentToolUseId: "parent-tool",
      modelRequestId: "request-1",
      content: [{ type: "text", text: large }],
      outcome: "ok",
      details: { displayContent: large },
      executionOutputTail: large,
    });

    const resumed = await attachingProcess(ctx);
    await recoverFinalizedToolResultCheckpoints({
      conversationId: ctx.conversationId,
      sessionId: ctx.sessionId,
      store: asAsyncEventReadSurface(ctx.store),
      writer: asAsyncEventWriter(ctx.store),
      tree: resumed,
    });

    const stored = ctx.store.read({
      aggregateId: `session:${ctx.sessionId}`,
      types: ["tool.result.recorded", "tool.execution_output.recorded"],
    });
    expect(stored.map((fact) => fact.version)).toEqual([4, 4]);
    const hydrated = stored.map((fact) => hydrateToolContentFact(fact, ctx.store.toolContent));
    const result = hydrated.find((fact) => fact.type === "tool.result.recorded");
    const executionOutput = hydrated.find((fact) => fact.type === "tool.execution_output.recorded");
    expect(result?.payload).toMatchObject({
      toolUseId: "nested-result",
      parentToolUseId: "parent-tool",
      modelRequestId: "request-1",
      content: large,
      details: { displayContent: large },
    });
    expect(executionOutput?.payload).toMatchObject({
      toolUseId: "nested-result",
      parentToolUseId: "parent-tool",
      modelRequestId: "request-1",
      output: large,
    });
    expect((await resumed.getBranch()).some((entry) => entry.kind === "message" && entry.message.kind === "toolResult")).toBe(false);
  });

});

describe("a user message queued mid-turn", () => {
  function holdQueuedCell(key: string, text: string, conversationId?: string): void {
    ctx.store.putInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, key, {
      conversationId: conversationId ?? ctx.conversationId,
      text,
    });
  }

  it("is restored on resume when the owning process died before its flush", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("fix the parser"));
    writer.beginTurn();
    recordToolCall("edit_file", "t1");
    holdQueuedCell("q1", "also update the docs please");

    const resumed = await attachingProcess(ctx);
    await createConversationTreeWriter({ tree: resumed }).commitUserTurn(userMessage("carry on"));

    const branch = await resumed.getBranch();
    const texts = branch.map((entry) => (entry.kind === "message" && entry.message.kind === "user" ? String(entry.message.content) : ""));
    expect(texts).toContain("also update the docs please");
    // The recovered words precede the resuming message, in dispatch order.
    expect(texts.indexOf("also update the docs please")).toBeLessThan(texts.indexOf("carry on"));
    // The restoring commit retired the cell, so a second resume restores nothing.
    expect(ctx.store.readInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toHaveLength(0);
  });

  it("retires its cell in the same commit that makes the message durable", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("fix the parser"));
    writer.beginTurn();
    holdQueuedCell("q2", "queued words");
    writer.enqueueMessage(assistantMessage("working"));
    writer.enqueueMessage({ kind: "user", content: "queued words", dispatchIds: ["q2"] });

    await writer.flushSavePoint();

    expect(ctx.store.readInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toHaveLength(0);
    // Nothing left to restore: the next activation sees only the committed copy.
    const resumed = await attachingProcess(ctx);
    await createConversationTreeWriter({ tree: resumed }).commitUserTurn(userMessage("next"));
    const texts = (await resumed.getBranch()).map((entry) => (entry.kind === "message" && entry.message.kind === "user" ? String(entry.message.content) : ""));
    expect(texts.filter((text) => text === "queued words")).toHaveLength(1);
  });

  it("never restores another conversation's queued words", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("step 1"));
    holdQueuedCell("q3", "belongs elsewhere", "some-other-conversation");

    const resumed = await attachingProcess(ctx);
    await createConversationTreeWriter({ tree: resumed }).commitUserTurn(userMessage("carry on"));

    expect(JSON.stringify(await resumed.getBranch())).not.toContain("belongs elsewhere");
    expect(ctx.store.readInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toHaveLength(1);
  });
});

describe("a background notification queued mid-turn", () => {
  it("is restored as system-origin context in cross-origin dispatch order", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("inspect the failure"));
    writer.beginTurn();
    const recognizedSecret = ["sk", "proj", "aB3".repeat(12)].join("-");
    const held = await holdQueuedBackgroundNotification(
      asAsyncEventWriter(ctx.store),
      ctx.sessionId,
      ctx.conversationId,
      `<subagent_notifications>finished audit ${recognizedSecret}</subagent_notifications>`,
    );
    if (!held.key) throw new Error("expected durable notification key");
    const checkpoint = ctx.store.readInFlight(ctx.sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND);
    expect(checkpoint[0]?.payload.text).toContain("[redacted secret]");
    expect(JSON.stringify(checkpoint)).not.toContain(recognizedSecret);
    ctx.store.putInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "q4", {
      conversationId: ctx.conversationId,
      text: "continue after reopening",
    });

    const resumed = await reopenContextStore();
    await createConversationTreeWriter({ tree: resumed }).commitUserTurn(userMessage("resume"));

    const recovered = (await resumed.getBranch()).flatMap((entry) => entry.kind === "message" && entry.message.kind === "user"
      ? [{ id: entry.id, content: String(entry.message.content), origin: entry.message.origin, replyRequired: entry.message.replyRequired }]
      : []);
    const notificationIndex = recovered.findIndex(({ content }) => content.includes("finished audit"));
    const queuedUserIndex = recovered.findIndex(({ content }) => content === "continue after reopening");
    expect(notificationIndex).toBeGreaterThanOrEqual(0);
    expect(queuedUserIndex).toBeGreaterThan(notificationIndex);
    expect(recovered[notificationIndex]?.id).toBe(held.key);
    expect(recovered[notificationIndex]?.origin).toBe("system");
    expect(recovered[notificationIndex]?.replyRequired).toBe(true);
    expect(ctx.store.readInFlight(ctx.sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(0);
    expect(ctx.store.readInFlight(ctx.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toHaveLength(0);

    const reopenedAgain = await reopenContextStore();
    await createConversationTreeWriter({ tree: reopenedAgain }).commitUserTurn(userMessage("resume again"));
    const notificationCopies = (await reopenedAgain.getBranch()).filter((entry) => entry.kind === "message"
      && entry.message.kind === "user"
      && String(entry.message.content).includes("finished audit"));
    expect(notificationCopies).toHaveLength(1);
  });

  it("converges concurrent recovery on one delivered notification", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("inspect concurrently"));
    await holdQueuedBackgroundNotification(asAsyncEventWriter(ctx.store), ctx.sessionId, ctx.conversationId, "completed once");

    const otherStore = createSqliteEventStore(resolveEventStoreDbFile(ctx.baseDir));
    const otherTree = await tryOpenConversationTree({ conversationId: ctx.conversationId, sessionId: ctx.sessionId, store: asAsyncEventReadSurface(otherStore), writer: asAsyncEventWriter(otherStore) });
    if (!otherTree) throw new Error("expected second conversation reader");
    try {
      await Promise.all([tree.recordInterruptedTurn(), otherTree.recordInterruptedTurn()]);
      const fresh = await attachingProcess(ctx);
      const copies = (await fresh.getBranch()).filter((entry) => entry.kind === "message"
        && entry.message.kind === "user"
        && String(entry.message.content) === "completed once");
      expect(copies).toHaveLength(1);
      expect(ctx.store.readInFlight(ctx.sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(0);
    } finally {
      await (await otherTree.getStorage()).dispose();
      otherStore.close();
    }
  });

  it("isolates malformed notification cells from valid recovery", async () => {
    const writer = createConversationTreeWriter({ tree });
    await writer.commitUserTurn(userMessage("inspect malformed state"));
    ctx.store.putInFlight(ctx.sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, "malformed", {
      conversationId: ctx.conversationId,
      text: 42,
    });
    await holdQueuedBackgroundNotification(asAsyncEventWriter(ctx.store), ctx.sessionId, ctx.conversationId, "valid completion");

    const resumed = await reopenContextStore();
    await createConversationTreeWriter({ tree: resumed }).commitUserTurn(userMessage("resume"));

    expect(JSON.stringify(await resumed.getBranch())).toContain("valid completion");
    const remaining = ctx.store.readInFlight(ctx.sessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ kind: QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND, key: "malformed", payload: {
      conversationId: ctx.conversationId,
      text: 42,
    } });
  });
});
