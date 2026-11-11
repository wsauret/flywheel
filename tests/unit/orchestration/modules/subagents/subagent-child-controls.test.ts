import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js";
import { summarizeSubagentWork } from "../../../../../src/orchestration/modules/subagents/execution/summarize-work.js";
import { newTestRunner } from "../../../../helpers/agent-runner.js";
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { asModelClient } from "../../agent-runtime/_model-client.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter, type AsyncGuardedEventWriter, type LocalSqliteEventStore } from "../../../../../src/infra/event-store-types";
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store";
import { createConversationTreeWriterController } from "../../../../../src/orchestration/chat/tree-writer";
import { buildSubagentCompleted, buildSubagentPaused, buildSubagentResumed } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers";
import { readSubagentRuns } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-projection";
import { settleDeletedSubagent, stopSubagentSession } from "../../../../../src/orchestration/modules/subagents/execution/direct-child-control";
import { createSessionManager, type SessionManager } from "../../../../../src/orchestration/session/manager";
import { liveChildRun } from "../../../../../src/orchestration/session/live-session-control";
import { prepareSessionFactAppend } from "../../../../../src/orchestration/session/session-fact-writer";
import { holdQueuedBackgroundNotification, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../../src/orchestration/session/conversation/queued-background-notifications";
import { holdQueuedUserInput, QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../../src/orchestration/session/conversation/queued-user-inputs";
import { registerTestChildRun } from "../../../../helpers/live-child-run";
import type { AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types";
import type { AgentLoopInput } from "../../../../../src/infra/agent-loop-events";
import type { SessionInputProducer } from "../../../../../src/infra/chat-input";
import { reconcileChildSessionCompletions } from "../../../../../src/orchestration/session/child-session-reconciliation";
import { deliverSessionInput } from "../../../../../src/orchestration/session/session-input-delivery";
import { createSessionMessaging } from "../../../../../src/orchestration/session/session-messaging";
import { makeContext, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures";
import { assistantToolUseMessage } from "../../session/_save-point-fixtures";
import { createUnstartedChild, subagentChildHarnesses, type SubagentChildHarness } from "./_subagent-child-fixtures";
import { finalizeTestSessionDeletion } from "../../session/_session-manager-fixtures";
import { executeChildSessionDeletionPlan } from "../../../../../src/orchestration/session/child-session-deletion";
import { unusedChildSessionControl } from "../../../../helpers/child-session-control.js";

const createHarness = subagentChildHarnesses();

let root: string;
let store: LocalSqliteEventStore;
let manager: SessionManager;
let parentSessionId: string;
let parentConversationId: string;
let childSessionId: string;
let childConversationId: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-child-controls-"));
  store = createSqliteEventStore(resolveEventStoreDbFile(root));
  manager = createSessionManager({ projectRoot: root, executionCwd: root, store });
  ({ parentSessionId, parentConversationId, childSessionId, childConversationId } = await createUnstartedChild(manager, root));
});

afterEach(() => {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("durable child controls", () => {
  test.each(["Resume", "Stop"] as const)("Stop reports the actual outcome when a concurrent %s wins its publication", async (winner) => {
    store.append(prepareSessionFactAppend(childSessionId, buildSubagentPaused({ childRunId: "run-1", pausedBy: "person" })));
    const reader = asAsyncEventReadSurface(store);
    const base = asAsyncEventWriter(store);
    const writer: AsyncGuardedEventWriter = {
      ...base,
      async appendBatchGuarded(events) {
        store.append(prepareSessionFactAppend(childSessionId, winner === "Resume"
          ? buildSubagentResumed({ childRunId: "run-1", authorizationId: "resume", continuation: 1 })
          : buildSubagentCompleted({ childRunId: "run-1", status: "cancelled", isError: true, content: "canceled", durationMs: 1 })));
        return base.appendBatchGuarded(events);
      },
    };
    const answer = await stopSubagentSession({
      eventStore: reader, projectionReader: reader, writer, projectRoot: root, childSessionId, parentSessionId, by: "agent",
    });
    if (winner === "Resume") {
      expect(answer).toMatchObject({ ok: false, error: expect.stringContaining("Cancellation was not confirmed") });
      expect((await readSubagentRuns(reader, childSessionId)).at(-1)?.status).toBe("created");
    } else {
      expect(answer).toEqual({ ok: true, status: "cancelled" });
      expect((await readSubagentRuns(reader, childSessionId)).at(-1)?.status).toBe("cancelled");
    }
  });

  test("the run registry addresses only the selected child session", () => {
    let childInterrupted = false;
    let siblingInterrupted = false;
    const releaseChild = registerTestChildRun(asAsyncEventReadSurface(store), {
      sessionId: childSessionId,
      runId: "run-1",
      parentSessionId,
      parentConversationId,
      parentToolCallId: "dispatch-tool",
      stop: () => { childInterrupted = true; },
    });
    const releaseSibling = registerTestChildRun(asAsyncEventReadSurface(store), {
      sessionId: "sibling",
      runId: "run-2",
      parentSessionId,
      parentConversationId,
      parentToolCallId: "dispatch-sibling",
      stop: () => { siblingInterrupted = true; },
    });

    liveChildRun(asAsyncEventReadSurface(store), childSessionId)?.child.stop("person");
    expect(childInterrupted).toBe(true);
    expect(siblingInterrupted).toBe(false);
    releaseChild();
    releaseSibling();
  });

  test("holds the parent's message to a paused child durably as the parent's", async () => {
    const messaging = createSessionMessaging({ manager, projectionReader: asAsyncEventReadSurface(store), eventWriter: asAsyncEventWriter(store) }, unusedChildSessionControl());
    expect(await messaging.send({
      target: "session",
      sender: { sessionId: parentSessionId, conversationId: parentConversationId, toolUseId: "message-tool", hop: 0 },
      to: childSessionId,
      text: "inspect the parser",
      personWords: () => undefined,
    })).toEqual({ status: "held", to: childSessionId, name: "child", reason: "no_reader", waiting: false });

    const writer = createConversationTreeWriterController({
      conversationId: childConversationId,
      sessionId: childSessionId,
      projectRoot: root,
      store: asAsyncEventReadSurface(store),
      projectionReader: asAsyncEventReadSurface(store),
      writer: asAsyncEventWriter(store),
    });
    await writer.commitUserTurn("resume");
    expect((await writer.buildContext()).messages).toContainEqual({
      kind: "user",
      content: "inspect the parser",
      producer: { kind: "session", sessionId: parentSessionId, conversationId: parentConversationId, toolUseId: "message-tool", hop: 0, envelope: { name: "Parent", relation: "parent", waits: false } },
    });
    await writer.dispose();
  });

  test("refuses the parent's message and takes the hold back when the child settles after the hold", async () => {
    const base = asAsyncEventWriter(store);
    const settling: AsyncEventWriter = {
      ...base,
      async putInFlight(sessionId, kind, key, payload) {
        await base.putInFlight?.(sessionId, kind, key, payload);
        store.append(prepareSessionFactAppend(childSessionId, buildSubagentCompleted({
          childRunId: "run-1",
          status: "completed",
          isError: false,
          content: "done",
          durationMs: 1,
        })));
      },
    };

    expect(await deliverSessionInput({ manager, projectionReader: asAsyncEventReadSurface(store), eventWriter: settling }, childSessionId, {
      text: "too late",
      producer: { kind: "session", sessionId: parentSessionId, conversationId: parentConversationId, toolUseId: "message-tool", hop: 0 },
    })).toEqual({ status: "refused", reason: "settled" });
    expect(store.readInFlight(childSessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([]);
  });

  test("a stopped child commits the person's unread messages and its unread notices, gives the parent its own in the stopped result, and returns a sibling's once", async () => {
    store.append(prepareSessionFactAppend(childSessionId, buildSubagentPaused({ childRunId: "run-1", pausedBy: "person" })));
    const sibling = await manager.createChat({ name: "Sibling" });
    const writer = asAsyncEventWriter(store);
    // A notice the paused child holds as a sender. No later run reads it.
    await holdQueuedBackgroundNotification(writer, childSessionId, childConversationId, "a notice for the child", "notice-1");
    const conversation = { target: "conversation" as const, conversationId: childConversationId };
    await holdQueuedUserInput(writer, childSessionId, conversation, "the person's note");
    await holdQueuedUserInput(writer, childSessionId, conversation, { text: "the parent's question", producer: { kind: "session", sessionId: parentSessionId, conversationId: parentConversationId, toolUseId: "ask-1", hop: 0 } });
    await holdQueuedUserInput(writer, childSessionId, conversation, { text: "the sibling's question", producer: { kind: "session", sessionId: sibling, conversationId: "sibling-conversation", toolUseId: "ask-2", hop: 0 } });

    const answer = await stopSubagentSession({
      eventStore: asAsyncEventReadSurface(store),
      projectionReader: asAsyncEventReadSurface(store),
      writer,
      projectRoot: root,
      childSessionId,
      parentSessionId,
      by: "person",
    });
    expect(answer).toEqual({ ok: true, status: "stopped" });

    const stopped = (await readSubagentRuns(asAsyncEventReadSurface(store), childSessionId)).at(-1);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.result).toContain("the parent's question");
    expect(stopped?.result).not.toContain("the sibling's question");
    expect(stopped?.result).not.toContain("the person's note");
    const siblingNotices = store.readInFlight(sibling, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND);
    expect(siblingNotices).toHaveLength(1);
    expect(String(siblingNotices[0]?.payload.text)).toContain("the sibling's question");
    expect(store.readInFlight(childSessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([]);
    expect(store.readInFlight(childSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([]);
    const tree = createConversationTreeWriterController({
      conversationId: childConversationId,
      sessionId: childSessionId,
      projectRoot: root,
      store: asAsyncEventReadSurface(store),
      projectionReader: asAsyncEventReadSurface(store),
      writer,
    });
    expect((await tree.buildContext({ allowAssistantTail: true })).messages).toEqual([
      { kind: "user", content: "inspect", producer: { kind: "launch", sessionId: parentSessionId, toolUseId: "dispatch-tool", name: "Parent" } },
      { kind: "user", content: "the person's note", origin: "human" },
      { kind: "user", content: "a notice for the child", origin: "system", replyRequired: true },
    ]);
    await tree.dispose();
  });

  test("deleting an interrupted child gives the parent its own messages in the stopped result and returns a sibling's once, naming the deletion", async () => {
    store.append(prepareSessionFactAppend(childSessionId, buildSubagentPaused({ childRunId: "run-1", pausedBy: "person" })));
    const sibling = await manager.createChat({ name: "Sibling" });
    const writer = asAsyncEventWriter(store);
    const conversation = { target: "conversation" as const, conversationId: childConversationId };
    await holdQueuedUserInput(writer, childSessionId, conversation, { text: "the parent's question", producer: { kind: "session", sessionId: parentSessionId, conversationId: parentConversationId, toolUseId: "ask-1", hop: 0 } });
    await holdQueuedUserInput(writer, childSessionId, conversation, { text: "the sibling's question", producer: { kind: "session", sessionId: sibling, conversationId: "sibling-conversation", toolUseId: "ask-2", hop: 0 } });

    // The kind owner's settlement, then the kernel's tombstone, as a person's delete runs them.
    await settleDeletedSubagent({
      eventStore: asAsyncEventReadSurface(store),
      projectionReader: asAsyncEventReadSurface(store),
      writer,
      projectRoot: root,
      childSessionId,
      parentSessionId,
      conversationId: childConversationId,
    });
    await finalizeTestSessionDeletion(manager, childSessionId);

    const stopped = (await readSubagentRuns(asAsyncEventReadSurface(store), childSessionId)).at(-1);
    expect(stopped?.status).toBe("stopped");
    expect(stopped?.result).toContain("the parent's question");
    expect(stopped?.result).toContain("was deleted before it read");
    expect(stopped?.result).not.toContain("the sibling's question");
    const siblingNotices = store.readInFlight(sibling, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND);
    expect(siblingNotices).toHaveLength(1);
    expect(String(siblingNotices[0]?.payload.text)).toContain("the sibling's question");
    expect(String(siblingNotices[0]?.payload.text)).toContain('reason="deleted"');
    expect(String(siblingNotices[0]?.payload.text)).toContain("was deleted before it read");
    expect(store.readInFlight(childSessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([]);
  });
});

/** A harness whose child runs hold until the test settles them. */
function heldRuns() {
  const runs: { options: AgentOptions; done: PromiseWithResolvers<AgentRunResult> }[] = [];
  const harness = createHarness((options) => {
    const done = Promise.withResolvers<AgentRunResult>();
    runs.push({ options, done });
    return { send() {}, end() {}, abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }); }, done: done.promise };
  });
  return { harness, runs };
}

async function dispatchChild(harness: SubagentChildHarness): Promise<{ parent: string; parentConversation: string; child: string }> {
  const parent = await harness.manager.createChat({ id: "root", conversationId: "root-conversation", name: "root" });
  await harness.tool(parent).execute(
    { persona: "delegator", rationale: TEST_RATIONALE, prompt: "Hold messages" },
    makeContext({ conversationId: "root-conversation", toolUseId: "dispatch-call" }),
  );
  const child = [...(await harness.manager.read(parent))?.childSessionIds ?? []][0];
  if (!child) throw new Error("Dispatch did not publish a child session");
  return { parent, parentConversation: "root-conversation", child };
}

function fromSession(sessionId: string, conversationId: string, toolUseId: string): SessionInputProducer {
  return { kind: "session", sessionId, conversationId, toolUseId, hop: 0 };
}

function drained(options: AgentOptions): AgentLoopInput[] {
  if (options.lifecycle?.kind !== "parkable") throw new Error("Expected a parkable child loop");
  const inputs: AgentLoopInput[] = [];
  for (let input = options.lifecycle.inputSource.drainPending(); input; input = options.lifecycle.inputSource.drainPending()) inputs.push(input);
  return inputs;
}

describe("live child messages", () => {
  test("recalls only the latest unread human input and retires its hold", async () => {
    const { harness, runs } = heldRuns();
    try {
      const { parent, parentConversation, child } = await dispatchChild(harness);
      const delivery = { manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer };
      await deliverSessionInput(delivery, child, { text: "first", producer: { kind: "human" }, submissionIds: ["first"] });
      await deliverSessionInput(delivery, child, { text: "latest", producer: { kind: "human" }, submissionIds: ["latest"] });
      await deliverSessionInput(delivery, child, { text: "parent note", producer: fromSession(parent, parentConversation, "note") });
      const control = liveChildRun(harness.reader, child)!;
      expect(await control.recallQueuedMessage!()).toMatchObject({ text: "latest", submissionIds: ["latest"] });
      expect(harness.store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND).map((row) => row.key)).not.toContain("person:latest");
      expect(await control.recallQueuedMessage!()).toMatchObject({ text: "first" });
      expect(await control.recallQueuedMessage!()).toBeNull();
      expect(JSON.stringify(drained(runs[0]!.options))).toContain("parent note");
      await deliverSessionInput(delivery, child, { text: "consumed", producer: { kind: "human" } });
      drained(runs[0]!.options);
      expect(await control.recallQueuedMessage!()).toBeNull();
    } finally {
      for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });

  test.each(["deadline", "stop"] as const)("a failed child's pending summary settles on %s", async (cut) => {
    const provider = Promise.withResolvers<void>();
    const summaryStarted = Promise.withResolvers<void>();
    const deadline = new AbortController();
    const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let summarySignal: AbortSignal | undefined;
    const client = asModelClient({
      model: "test-summary", modelFamily: "anthropic", accessProvider: "anthropic_api",
      contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(options) {
        summarySignal = options.signal;
        summaryStarted.resolve();
        await provider.promise;
      },
    });
    const { harness, runs } = heldRuns();
    try {
      const parent = await harness.manager.createChat({ id: "root", conversationId: "root-conversation", name: "root" });
      await harness.tool(parent, {
        failureSummarizerForChild: ({ sessionId, conversationId, projectRoot, executionCwd, eventWriter, reader }) => (records, terminalError, signal) => summarizeSubagentWork({
          records, terminalError, ...(signal ? { signal } : {}),
          createRunner: (options) => newTestRunner({ ...options, agentsMd: "", model: "test-summary" }, async () => client),
          runnerOptions: async () => ({
            projectRoot, executionCwd, userDataRoot: `${harness.projectRoot}/.test-account`, accountHome: harness.projectRoot,
            moduleSelection: testCapabilityModules, captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {},
            runtimeSurfaces: {}, memorySnapshot: null,
          }),
          child: { sessionId, conversationId, writer: eventWriter, reader },
        }),
      }).execute({ persona: "delegator", rationale: TEST_RATIONALE, prompt: "Fail after reading" },
        makeContext({ conversationId: "root-conversation", toolUseId: "dispatch-call" }));
      const child = [...(await harness.manager.read(parent))?.childSessionIds ?? []][0];
      if (!child || !runs[0]) throw new Error("The child did not start");
      for (let index = 0; index < 3; index += 1) {
        const id = `read-${index}`;
        runs[0].options.onEvent(createRuntimeEvent("tool.input.completed", {
          model_request_id: "request", tool_use: {
            id, name: "read", provider_call_id: id, provider_tool_name: "read", executable_tool_name: "read",
            input: { path: `file-${index}.ts` }, execution: { mode: "foreground", trace_kind: "tool" },
          },
        }));
        runs[0].options.onEvent(createRuntimeEvent("tool.result.recorded", { tool_use_id: id, content: [{ type: "text", text: "read" }], is_error: false }));
      }
      runs[0].done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: "provider broke", recovery: { kind: "none" } } });
      await summaryStarted.promise;
      const finished = Promise.all(harness.backgroundTasks.processRecords().map((process) => harness.backgroundTasks.waitProcess(process.id)));
      let stopped: Promise<void> | undefined;
      if (cut === "deadline") deadline.abort();
      else stopped = stopSubagentSession({
        eventStore: harness.reader, projectionReader: harness.reader, writer: harness.writer,
        projectRoot: harness.projectRoot, childSessionId: child, parentSessionId: parent, by: "person",
      }).then(() => {});
      let settled = false;
      const done = Promise.all([finished, stopped]).then(() => { settled = true; });
      const isSettled = () => settled;
      const settleBy = performance.now() + 2_000;
      while (!isSettled() && performance.now() < settleBy) await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(true);
      await done;
      expect(summarySignal?.aborted).toBe(true);
      const failed = (await readSubagentRuns(harness.reader, child)).at(-1);
      expect(failed?.status).toBe("failed");
      expect(failed?.result).toContain("provider broke");
      expect(failed?.result).toContain("## Work completed before error");
    } finally {
      provider.resolve();
      timeout.mockRestore();
      for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });

  test("a live run that fails commits the person's unread message, gives the parent its own in the result, and returns a sibling's once", async () => {
    const { harness, runs } = heldRuns();
    try {
      const { parent, parentConversation, child } = await dispatchChild(harness);
      const sibling = await harness.manager.createChat({ id: "sibling", conversationId: "sibling-conversation", name: "sibling" });
      const delivery = { manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer };
      expect(await deliverSessionInput(delivery, child, { text: "the person's note", producer: { kind: "human" } })).toEqual({ status: "delivered", startsTurn: false });
      expect(await deliverSessionInput(delivery, child, { text: "the parent's question", producer: fromSession(parent, parentConversation, "ask-1") })).toEqual({ status: "delivered", startsTurn: false });
      expect(await deliverSessionInput(delivery, child, { text: "the sibling's question", producer: fromSession(sibling, "sibling-conversation", "ask-2") })).toEqual({ status: "delivered", startsTurn: false });

      runs[0]?.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "api_error", message: "provider broke", recovery: { kind: "none" } } });
      await Promise.all(harness.backgroundTasks.processRecords().map((process) => harness.backgroundTasks.waitProcess(process.id)));
      await reconcileChildSessionCompletions({ parentSessionId: parent, reader: harness.reader, writer: harness.writer });

      const failed = (await readSubagentRuns(harness.reader, child)).at(-1);
      expect(failed?.status).toBe("failed");
      expect(failed?.result).toContain("<returned_messages");
      expect(failed?.result).toContain("the parent's question");
      expect(failed?.result).not.toContain("the sibling's question");
      expect(failed?.result).not.toContain("the person's note");
      const siblingNotices = harness.store.readInFlight(sibling, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND);
      expect(siblingNotices).toHaveLength(1);
      expect(String(siblingNotices[0]?.payload.text)).toContain("the sibling's question");
      expect(harness.store.readInFlight(child, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([]);
      const childSession = await harness.manager.read(child);
      if (childSession?.kind !== "subagent") throw new Error("expected the subagent child");
      const conversation = JSON.stringify(harness.store.read({ aggregateId: `conversation:${childSession.conversationId}` }));
      expect(conversation).toContain("the person's note");
      expect(conversation).not.toContain("the parent's question");
      expect(conversation).not.toContain("the sibling's question");
    } finally {
      for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });

  // Siblings that wait on their background work read each other's messages
  // without a wake, so a chain between them ran until a run ended.
  test("a run parked on its background work gives its loop a peer's message at the hop limit as held, and its parent's message to read", async () => {
    const { harness, runs } = heldRuns();
    try {
      const { parent, parentConversation, child } = await dispatchChild(harness);
      const sibling = await harness.manager.createChat({ id: "sibling", conversationId: "sibling-conversation", name: "sibling" });
      const lifecycle = runs[0]?.options.lifecycle;
      if (lifecycle?.kind !== "parkable") throw new Error("expected a parkable child loop");
      const delivery = { manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer };
      const peer = (toolUseId: string): SessionInputProducer => ({ ...fromSession(sibling, "sibling-conversation", toolUseId), hop: 5, envelope: { name: "sibling", relation: "sibling", waits: false } });
      const fromParent: SessionInputProducer = { ...fromSession(parent, parentConversation, "steer-1"), hop: 9, envelope: { name: "root", relation: "parent", waits: false } };

      await lifecycle.onTurnParked?.({ handoffWritten: false, turnCount: 1, activeBackgroundCount: 1, parkedOnBackgroundWork: true, waitRequested: false, userResumeRequired: false, park: "waiting_on_work" });
      expect(await deliverSessionInput(delivery, child, { text: "is your part done?", producer: peer("ask-1") })).toEqual({ status: "held", reason: "wake_limit" });
      expect(await deliverSessionInput(delivery, child, { text: "use the new schema", producer: fromParent })).toEqual({ status: "delivered", startsTurn: false });
      expect(drained(runs[0]!.options).map((input) => input.kind === "message" ? { text: input.text, held: input.held === true } : input.kind))
        .toEqual([{ text: "is your part done?", held: true }, { text: "use the new schema", held: false }]);

      // A turn that runs reads every message.
      lifecycle.onTurnResumed?.();
      expect(await deliverSessionInput(delivery, child, { text: "and the tests?", producer: peer("ask-2") })).toEqual({ status: "delivered", startsTurn: false });
    } finally {
      for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });

  test("a run that completes commits a notice that came after it stopped reading, so no cell outlives the run", async () => {
    const { harness, runs } = heldRuns();
    try {
      const { child } = await dispatchChild(harness);
      const childSession = await harness.manager.read(child);
      const run = runs[0];
      if (childSession?.kind !== "subagent" || run?.options.conversation.kind !== "durable-tree") throw new Error("expected the child run's durable conversation");
      await run.options.conversation.append({ kind: "assistant", content: [{ type: "text", text: "Done." }] });
      // The notice is held after the loop read its last input. No later run of
      // the settled child reads it.
      await holdQueuedBackgroundNotification(harness.writer, child, childSession.conversationId, "a notice for the child", "notice-1");

      run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } });
      await Promise.all(harness.backgroundTasks.processRecords().map((process) => harness.backgroundTasks.waitProcess(process.id)));

      expect(harness.store.readInFlight(child, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([]);
      expect(JSON.stringify(harness.store.read({ aggregateId: `conversation:${childSession.conversationId}` }))).toContain("a notice for the child");
    } finally {
      for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });

  test("deleting a live run gives the parent its own messages in the stopped result and returns a sibling's once, naming the deletion", async () => {
    const { harness, runs } = heldRuns();
    try {
      const { parent, parentConversation, child } = await dispatchChild(harness);
      const sibling = await harness.manager.createChat({ id: "sibling", conversationId: "sibling-conversation", name: "sibling" });
      const delivery = { manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer };
      expect(await deliverSessionInput(delivery, child, { text: "the parent's question", producer: fromSession(parent, parentConversation, "ask-1") })).toEqual({ status: "delivered", startsTurn: false });
      expect(await deliverSessionInput(delivery, child, { text: "the sibling's question", producer: fromSession(sibling, "sibling-conversation", "ask-2") })).toEqual({ status: "delivered", startsTurn: false });
      const childSession = await harness.manager.read(child);
      if (childSession?.kind !== "subagent") throw new Error("expected the subagent child");

      await settleDeletedSubagent({
        eventStore: harness.reader, projectionReader: harness.reader, writer: harness.writer, projectRoot: harness.projectRoot,
        childSessionId: child, parentSessionId: parent, conversationId: childSession.conversationId,
      });
      await finalizeTestSessionDeletion(harness.manager, child);

      const stopped = (await readSubagentRuns(harness.reader, child)).at(-1);
      expect(stopped?.result).toContain("the parent's question");
      expect(stopped?.result).toContain("was deleted before it read");
      expect(stopped?.result).not.toContain("the sibling's question");
      const siblingNotices = harness.store.readInFlight(sibling, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND);
      expect(siblingNotices).toHaveLength(1);
      expect(String(siblingNotices[0]?.payload.text)).toContain("the sibling's question");
      expect(String(siblingNotices[0]?.payload.text)).toContain('reason="deleted"');
    } finally {
      for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });

  test("deleting an interrupted child hands a running sibling the notice of its returned message in its next request", async () => {
    const { harness, runs } = heldRuns();
    try {
      const parent = await harness.manager.createChat({ id: "root", conversationId: "root-conversation", name: "root" });
      for (const toolUseId of ["dispatch-kilo", "dispatch-lima"]) {
        await harness.tool(parent).execute(
          { persona: "delegator", rationale: TEST_RATIONALE, prompt: toolUseId },
          makeContext({ conversationId: "root-conversation", toolUseId }),
        );
      }
      const [kilo, lima] = (await harness.manager.read(parent))?.childSessionIds ?? [];
      const limaRun = runs[1];
      const limaSession = lima ? await harness.manager.read(lima) : null;
      if (!kilo || !lima || !limaRun || limaSession?.kind !== "subagent") throw new Error("expected two running children");
      await liveChildRun(harness.reader, kilo)?.child.interrupt("person");
      const delivery = { manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer };
      expect(await deliverSessionInput(delivery, kilo, { text: "SIBLING-UNREAD-42", producer: fromSession(lima, limaSession.conversationId, "ask-1") }))
        .toEqual({ status: "held", reason: "interrupted" });

      // The project-state Worker owns the session manager in its own
      // process, so its reader is not the one that the live runs registered with.
      const stateReader = { ...harness.reader };
      const state = createSessionManager({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, projectionReader: stateReader, writer: harness.writer });
      await executeChildSessionDeletionPlan({
        projectRoot: harness.projectRoot, reader: harness.reader, projectionReader: harness.reader, writer: harness.writer, read: harness.manager.read,
        finalizeDeletionTarget: state.finalizeDeletionTarget,
      }, await state.admitDeletion(kilo));

      const notice = JSON.stringify(drained(limaRun.options));
      expect(notice).toContain('reason=\\"deleted\\"');
      expect(notice).toContain("SIBLING-UNREAD-42");
    } finally {
      for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });

  test("deleting an interrupted child commits the notice of a sibling whose run ended into the sibling's conversation", async () => {
    const { harness, runs } = heldRuns();
    try {
      const parent = await harness.manager.createChat({ id: "root", conversationId: "root-conversation", name: "root" });
      for (const toolUseId of ["dispatch-kilo", "dispatch-lima"]) {
        await harness.tool(parent).execute(
          { persona: "delegator", rationale: TEST_RATIONALE, prompt: toolUseId },
          makeContext({ conversationId: "root-conversation", toolUseId }),
        );
      }
      const [kilo, lima] = (await harness.manager.read(parent))?.childSessionIds ?? [];
      const limaRun = runs[1];
      const limaSession = lima ? await harness.manager.read(lima) : null;
      if (!kilo || !lima || limaRun?.options.conversation.kind !== "durable-tree" || limaSession?.kind !== "subagent") throw new Error("expected two running children");
      await liveChildRun(harness.reader, kilo)?.child.interrupt("person");
      const delivery = { manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer };
      expect(await deliverSessionInput(delivery, kilo, { text: "SIBLING-UNREAD-42", producer: fromSession(lima, limaSession.conversationId, "ask-1") }))
        .toEqual({ status: "held", reason: "interrupted" });
      await limaRun.options.conversation.append({ kind: "assistant", content: [{ type: "text", text: "Done." }] });
      limaRun.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } });
      await Promise.all(harness.backgroundTasks.processRecords().map((process) => harness.backgroundTasks.waitProcess(process.id)));
      // The run settles: its loop returned, so it reads nothing more.
      expect(liveChildRun(harness.reader, lima)).toBeUndefined();
      expect(["completed", "failed"]).toContain((await readSubagentRuns(harness.reader, lima)).at(-1)?.status ?? "none");

      // No later run of the settled sibling reads a held notice.
      const state = createSessionManager({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, projectionReader: { ...harness.reader }, writer: harness.writer });
      await executeChildSessionDeletionPlan({
        projectRoot: harness.projectRoot, reader: harness.reader, projectionReader: harness.reader, writer: harness.writer, read: harness.manager.read,
        finalizeDeletionTarget: state.finalizeDeletionTarget,
      }, await state.admitDeletion(kilo));

      expect(harness.store.readInFlight(lima, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([]);
      const conversation = JSON.stringify(harness.store.read({ aggregateId: `conversation:${limaSession.conversationId}` }));
      expect(conversation).toContain('reason=\\"deleted\\"');
      expect(conversation).toContain("SIBLING-UNREAD-42");
    } finally {
      for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });

  test("a pause that cuts a running tool call records the cut before the person's unread message", async () => {
    const { harness, runs } = heldRuns();
    try {
      const { child } = await dispatchChild(harness);
      const run = runs[0];
      if (run?.options.conversation.kind !== "durable-tree") throw new Error("expected the child run's durable conversation");
      await run.options.conversation.append(assistantToolUseMessage("call-1"));
      await run.options.conversation.append({ kind: "toolResult", toolUseId: "call-1", content: [{ type: "text", text: "Tool 'search' was interrupted." }], interrupted: true });
      const delivery = { manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer };
      expect(await deliverSessionInput(delivery, child, { text: "the person's note", producer: { kind: "human" } })).toEqual({ status: "delivered", startsTurn: false });

      await liveChildRun(harness.reader, child)?.child.interrupt("person");

      const childSession = await harness.manager.read(child);
      if (childSession?.kind !== "subagent") throw new Error("expected the subagent child");
      const tree = createConversationTreeWriterController({
        conversationId: childSession.conversationId,
        sessionId: child,
        projectRoot: harness.projectRoot,
        store: harness.reader,
        projectionReader: harness.reader,
        writer: harness.writer,
      });
      const tail = (await tree.buildContext({ allowAssistantTail: true })).messages.slice(-2).map((message) => JSON.stringify(message.content));
      await tree.dispose();
      expect(tail[0]).toContain("A tool call that was running was cut");
      expect(tail[1]).toContain("the person's note");
    } finally {
      for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });

  test("a paused child lists as interrupted, not failed, and leaves the active work count", async () => {
    const { harness, runs } = heldRuns();
    try {
      const { child } = await dispatchChild(harness);
      expect(harness.backgroundTasks.activeBackgroundCommands()).toHaveLength(1);

      await liveChildRun(harness.reader, child)?.child.interrupt("person");

      expect(harness.backgroundTasks.processRecords()).toEqual([expect.objectContaining({ kind: "subagent", status: "interrupted" })]);
      expect(harness.backgroundTasks.activeBackgroundCommands()).toEqual([]);
    } finally {
      for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });

  test("a message that a resume takes at its start reaches the resumed run once", async () => {
    const { harness, runs } = heldRuns();
    try {
      const { parent, parentConversation, child } = await dispatchChild(harness);
      await liveChildRun(harness.reader, child)?.child.interrupt("person");
      // The resume starts after the hold commits and before the delivery
      // looks for a live control: its continuation reads the cell, and its
      // control then takes the same message live.
      let resumed: Promise<unknown> | undefined;
      const writer: AsyncEventWriter = {
        ...harness.writer,
        async putInFlight(sessionId, kind, key, payload) {
          await harness.writer.putInFlight?.(sessionId, kind, key, payload);
          if (kind !== QUEUED_USER_INPUT_IN_FLIGHT_KIND || resumed) return;
          resumed = harness.tool(parent).processResume(child, makeContext({ conversationId: parentConversation, toolUseId: "resume-call" }));
          await resumed;
        },
      };

      expect(await deliverSessionInput({ manager: harness.manager, projectionReader: harness.reader, eventWriter: writer }, child, { text: "while resuming", producer: { kind: "human" } }))
        .toEqual({ status: "delivered", startsTurn: false });

      const resumedRun = runs.at(-1);
      if (!resumedRun || runs.length !== 2) throw new Error("expected the resumed run");
      expect(JSON.stringify(drained(resumedRun.options)).split("while resuming")).toHaveLength(2);
    } finally {
      for (const run of runs) run.done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } });
      await harness.close();
    }
  });
});
