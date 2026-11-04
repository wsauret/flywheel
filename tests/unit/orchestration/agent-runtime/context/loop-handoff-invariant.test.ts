import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { type InputSource, messageInput } from "../../../../../src/infra/agent-loop-events.js";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { assemblyPinned, RequestToolMap, testBaseTools } from "../../../../helpers/request-tool-surface.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { WorkflowInjectionQueue } from "../../../../../src/orchestration/workflow-host/injection-queue.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { createWorkflowLoopObservers } from "../../../../../src/orchestration/workflow-host/loop-observers.js";
import { HandoffCorrectionExhausted } from "../../../../../src/orchestration/agent-runtime/errors.js";
import { makeCaptureClient, makeFakeLLMClient } from "./_loop-fixtures.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { createProcessTool } from "../../../../../src/orchestration/agent-runtime/tools/process.js";
import { ChatTurnMailbox } from "../../../../../src/orchestration/chat/turn-mailbox.js";

const loopIdentity = { userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", providerSessionKey: "handoff-invariant", promptCacheKey: "handoff-invariant", artifactScopeId: "handoff-invariant", retrievalSessionId: "handoff-invariant" };

function queueSource(): InputSource & { enqueue(text: string): void } {
  const queue: string[] = [];
  return {
    enqueue(text) { queue.push(text); },
    drainPending() {
      if (queue.length === 0) return null;
      return messageInput(queue.splice(0).join("\n\n"));
    },
  };
}

const handoffDirectory = temporaryDirectories();

function tempHandoffPath(): string {
  return join(handoffDirectory("flywheel-handoff-"), "handoff.json");
}


describe("agent-loop handoff invariant", () => {
  test("an admitted handoff completes after its durable result without consuming input or executing later calls", async () => {
    const queue = new WorkflowInjectionQueue();
    let executed = 0;
    let closed = 0;
    let readsAfterStart = 0;
    const writes: string[] = [];
    const extra: RuntimeTool = { name: "later", action: "ui_meta", description: "later", inputSchema: { type: "object", properties: {} }, isConcurrencySafe: true,
      execute: async () => { executed++; return { content: "ran", outcome: "ok" }; } };
    const { client, capturedMessages } = makeCaptureClient([{ events: [
      { kind: "tool_input_start", toolUseId: "finish", name: "handoff" },
      { kind: "tool_use", toolCall: { id: "finish", name: "handoff", input: { summary: "done" } } },
      { kind: "tool_use", toolCall: { id: "late", name: "later", input: {} } },
      { kind: "done", stopReason: "tool_use" },
    ] }]);
    const result = await runAgentLoop({
      client, systemPrompt: stableSystemPrompt("test"), instruction: "go", executionCwd: "/scratch", ...loopIdentity,
      persistence: { history: { append(message) { writes.push(JSON.stringify(message)); } } },
      seed: { kind: "fresh" }, handoff: { onContent() {} }, onEvent() {},
      inputSource: { drainPending() { if (closed) readsAfterStart++; return queue.drainPending(); } },
      lifecycle: { onHandoffStarted() { closed++; queue.enqueue("queued before closure"); queue.handoffStarted(); } },
      tools: new RequestToolMap([["handoff", testBaseTools().get("handoff")!], ["later", extra]]),
      flushCanonicalMessages: async () => {},
    });
    expect(result).toEqual({ kind: "completed" });
    expect([closed, executed, readsAfterStart, capturedMessages.length]).toEqual([1, 0, 0, 1]);
    expect(writes.join("\n")).toContain("session ended");
    expect(writes.join("\n")).not.toContain("queued before closure");
  });

  test("a refused stream-start handoff keeps input open and retains its refusal after the owed result commits", async () => {
    const queue = new WorkflowInjectionQueue();
    const done = Promise.withResolvers<BackgroundWorkResult>();
    const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: (text) => { queue.enqueue(text, { silent: true }); } }));
    background.tasks.track({ done: done.promise, meta: { id: "review", type: "subagent", description: "Nested review", settlementOwner: "child_session" } });
    let closed = 0;
    const writes: string[] = [];
    const { client, capturedMessages } = makeCaptureClient([
      { events: [
        { kind: "tool_input_start", toolUseId: "refused", name: "handoff" },
        { kind: "tool_use", toolCall: { id: "refused", name: "handoff", input: { summary: "early" } } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [{ kind: "tool_use", toolCall: { id: "accepted", name: "handoff", input: { summary: "done" } } }, { kind: "done", stopReason: "tool_use" }] },
    ]);
    const result = await runAgentLoop({
      client, systemPrompt: stableSystemPrompt("test"), instruction: "go", executionCwd: "/scratch", ...loopIdentity,
      seed: { kind: "fresh" }, persistence: { history: { append(message) { writes.push(JSON.stringify(message)); } } },
      inputSource: queue, background, handoff: { onContent() {} },
      lifecycle: { onHandoffStarted() { closed++; queue.handoffStarted(); } },
      onEvent(event) {
        if (event.kind !== "tool_input_start") return;
        expect(closed).toBe(0);
        queue.enqueueMessage("parent reply before admitted handoff");
        done.resolve({ status: "completed", content: "reviewed" });
        void done.promise.then(() => { background.tasks.deliverDurableSubagentNotification({ text: "reviewed", key: "subagent-completions:review", completionRunIds: ["review"] }); });
      },
      tools: new RequestToolMap([["handoff", testBaseTools().get("handoff")!]]),
    });
    expect(result).toEqual({ kind: "completed" });
    expect(closed).toBe(1);
    expect(capturedMessages).toHaveLength(2);
    expect(JSON.stringify(capturedMessages[1])).toContain("parent reply before admitted handoff");
    expect(writes.join("\n")).toContain("Nested review");
  });

  const chatBackground = (mailbox: ChatTurnMailbox, notified?: () => void) => createBackgroundExecutionOwner(createBackgroundWorkRegistry({
    kind: "chat", pendingInput: () => mailbox.hasPending,
    enqueueNotification: (text) => { mailbox.enqueueSilentSystem(text); notified?.(); },
  }));
  const runOneShot = (client: ReturnType<typeof makeCaptureClient>["client"], mailbox: ChatTurnMailbox, seal: (finalReply: string) => boolean, tools = new RequestToolMap()) => runAgentLoop({
    client, systemPrompt: stableSystemPrompt("test"), instruction: "go", executionCwd: "/scratch", ...loopIdentity,
    persistence: { history: { append() {} } }, seed: { kind: "fresh" }, onEvent() {},
    inputSource: mailbox, background: chatBackground(mailbox), completeOnIdle: { seal }, tools,
  });

  test("a one-shot loop seals its final reply as the result, with no handoff call", async () => {
    const sealed: string[] = [];
    const { client, capturedMessages } = makeCaptureClient([{ events: [
      { kind: "thinking_delta", text: "check", blockKey: "thinking" },
      { kind: "text_delta", text: "the whole answer", blockKey: "text" },
      { kind: "done", stopReason: "end_turn" },
    ] }]);
    const result = await runOneShot(client, new ChatTurnMailbox(), (reply) => { sealed.push(reply); return true; });
    expect(result.kind).toBe("completed");
    expect(sealed).toEqual(["the whole answer"]);
    expect(capturedMessages).toHaveLength(1);
  });

  test("a one-shot loop waits for work it owns and seals the reply that incorporates its result", async () => {
    const mailbox = new ChatTurnMailbox();
    const background = chatBackground(mailbox);
    const finish = Promise.withResolvers<BackgroundWorkResult>();
    const sealed: string[] = [];
    const work: RuntimeTool = {
      name: "launch", action: "ui_meta", description: "Launch owned work", inputSchema: { type: "object", properties: {} },
      isConcurrencySafe: false,
      async execute() {
        background.tasks.track({ done: finish.promise, meta: { id: "owned-work", type: "subagent", description: "owned work" } });
        return { content: "launched", outcome: "ok" };
      },
    };
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "tool_use", toolCall: { id: "launch", name: "launch", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "text_delta", text: "waiting for the owned work", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
      // The first such end gets the ordinary pending-work nudge, and the second waits, as in interactive chat.
      { events: [{ kind: "text_delta", text: "still waiting", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
      { events: [{ kind: "text_delta", text: "answer from the owned work", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
    ]);
    const running = runAgentLoop({
      client, systemPrompt: stableSystemPrompt("test"), instruction: "go", executionCwd: "/scratch", ...loopIdentity,
      persistence: { history: { append() {} } }, seed: { kind: "fresh" }, onEvent() {},
      inputSource: mailbox, background, completeOnIdle: { seal: (reply) => { sealed.push(reply); return true; } },
      tools: new RequestToolMap([["launch", work]]),
    });
    while (capturedMessages.length < 3) await Bun.sleep(1);
    await Bun.sleep(5);
    expect(sealed).toEqual([]);
    finish.resolve({ status: "completed", content: "owned work result" });
    const result = await running;
    expect(result.kind).toBe("completed");
    expect(sealed).toEqual(["answer from the owned work"]);
    expect(JSON.stringify(capturedMessages.at(-1))).toContain("owned work result");
  });

  test("a one-shot loop takes input that arrived before the seal instead of completing", async () => {
    const mailbox = new ChatTurnMailbox();
    const sealed: string[] = [];
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "text_delta", text: "first answer", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
      { events: [{ kind: "text_delta", text: "answer with the late input", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
    ]);
    const result = await runOneShot(client, mailbox, (reply) => {
      if (sealed.length === 0 && reply === "first answer") { mailbox.enqueueNextTurn("late input"); return false; }
      sealed.push(reply);
      return true;
    });
    expect(result.kind).toBe("completed");
    expect(sealed).toEqual(["answer with the late input"]);
    expect(capturedMessages).toHaveLength(2);
    expect(JSON.stringify(capturedMessages[1])).toContain("late input");
  });

  test("(a) one-shot utility: no handoffPath and no prepareWaitForInput, text-only end_turn → ok", async () => {
    const client = makeFakeLLMClient([
      { events: [
        { kind: "text_delta", text: "all done", blockKey: "text" },
        { kind: "done", stopReason: "end_turn" },
      ] },
    ]);

    const result = await runAgentLoop({
      tools: testBaseTools(),
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "go",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
    });

    expect(result.kind).toBe("completed");
  });

  test("(b) worker without prepareWaitForInput: text-only end_turn → direct nudge → handoff next turn", async () => {
    const handoffPath = tempHandoffPath();
    const { client, capturedMessages } = makeCaptureClient([
      { events: [
        { kind: "text_delta", text: "forgot to handoff", blockKey: "text" },
        { kind: "done", stopReason: "end_turn" },
      ] },
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "handoff", input: { summary: "done" } } },
        { kind: "done", stopReason: "tool_use" },
      ] },
    ]);

    const result = await runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "go",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      handoff: { onContent: (content) => { writeFileSync(handoffPath, JSON.stringify(content, null, 2)); } },
      onEvent: () => {},
      inputSource: queueSource(),
      tools: new RequestToolMap([["handoff", testBaseTools().get("handoff")!]]),
    });

    expect(result.kind).toBe("completed");
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[1]?.at(-1)).toEqual(expect.objectContaining({ kind: "user" }));
    expect(capturedMessages[1]?.at(-1)?.content).toContain("handoff");
  });


  test("(e) terminating non-handoff tool with handoffPath set → nudge → handoff next turn", async () => {
    const makeTerminateTool = (): RuntimeTool => ({
      name: "finisher",
      action: "ui_meta",
      isConcurrencySafe: true,
      description: "finisher tool",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({ content: "done", outcome: "ok", terminate: true }),
    });
    const handoffPath = tempHandoffPath();
    const { client, capturedMessages } = makeCaptureClient([
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "finisher", input: {} } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_2", name: "handoff", input: { summary: "done" } } },
        { kind: "done", stopReason: "tool_use" },
      ] },
    ]);

    const result = await runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "go",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      handoff: { onContent: (content) => { writeFileSync(handoffPath, JSON.stringify(content, null, 2)); } },
      onEvent: () => {},
      tools: new RequestToolMap([
        ["finisher", makeTerminateTool()],
        ["handoff", testBaseTools().get("handoff")!],
      ]),
    });

    expect(result.kind).toBe("completed");
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[1]?.at(-1)?.kind).toBe("user");
    expect(JSON.stringify(capturedMessages[1]?.at(-1)?.content)).toContain("handoff");
  });

  test("(f) compaction transparent: prefilled compact + handoff on turn 1 → ok", async () => {
    const handoffPath = tempHandoffPath();
    const { client } = makeCaptureClient(
      [
        { events: [
          { kind: "text_delta", text: "Checkpoint saved.", blockKey: "checkpoint" },
          { kind: "done", stopReason: "end_turn" },
        ] },
        { events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "handoff", input: { summary: "done" } } },
          { kind: "done", stopReason: "tool_use" },
        ] },
      ],
      {},
    );

    const injectionQueue = new WorkflowInjectionQueue();
    injectionQueue.enqueueCompact();

    const result = await runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "go",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      handoff: { onContent: (content) => { writeFileSync(handoffPath, JSON.stringify(content, null, 2)); } },
      onEvent: () => {},
      inputSource: injectionQueue,
      tools: await assemblyPinned(new RequestToolMap([["handoff", testBaseTools().get("handoff")!]])),
    });

    expect(result.kind).toBe("completed");
  });

  // Regression: workflow-worker session 61bdfd1d1cfd parked indefinitely after a
  // text-only end_turn because the handoff watchdog ran a 3-turn grace counter.
  // With no producer to wake the queue, the loop deadlocked. The observer now
  // nudges immediately on every text-only turn; the subagent gate inside
  // createWorkflowLoopObservers is responsible for suppressing nudges only when
  // subagents are legitimately in-flight. This test exercises the full worker
  // wrapper, not just the bare handoff observer.
  test("(g) workflow worker: text-only end_turn with no pending tasks → nudge keeps loop progressing", async () => {
    const handoffPath = tempHandoffPath();
    const { client } = makeCaptureClient([
      { events: [
        { kind: "text_delta", text: "Workflow created. The user can run /workflow start.", blockKey: "text" },
        { kind: "done", stopReason: "end_turn" },
      ] },
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "handoff", input: { summary: "done" } } },
        { kind: "done", stopReason: "tool_use" },
      ] },
    ]);

    const injectionQueue = new WorkflowInjectionQueue();
    const backgroundTasks = createBackgroundWorkRegistry({
      kind: "workflow",
      enqueueNotification: (text) => { injectionQueue.enqueue(text, { silent: true }); },
    });
    const observers = createWorkflowLoopObservers({
      parentChannel: true,
      injectionQueue,
      backgroundTasks,
      emit: () => {},
      sessionId: "wf-regression",
    });

    const result = await runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "produce handoff",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      handoff: { onContent: (content) => { writeFileSync(handoffPath, JSON.stringify(content, null, 2)); } },
      onEvent: () => {},
      inputSource: observers.inputSource,
      lifecycle: {
        onTurnEnded: observers.onTurnEnded,
      },
      tools: new RequestToolMap([["handoff", testBaseTools().get("handoff")!]]),
    });

    expect(result.kind).toBe("completed");
  });

  test("(g2) workflow worker: a third text-only end without a handoff ends the loop with a broken handoff contract", async () => {
    const textOnly = (text: string) => ({ events: [
      { kind: "text_delta" as const, text, blockKey: "text" },
      { kind: "done" as const, stopReason: "end_turn" as const },
    ] });
    const { client, capturedMessages } = makeCaptureClient([textOnly("one"), textOnly("two"), textOnly("three"), textOnly("never sent")]);
    const injectionQueue = new WorkflowInjectionQueue();
    const observers = createWorkflowLoopObservers({ parentChannel: true, injectionQueue, emit: () => {}, sessionId: "wf-reminder-cap" });

    const run = runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "produce handoff",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      handoff: { onContent: () => {} },
      onEvent: () => {},
      inputSource: observers.inputSource,
      lifecycle: { onTurnEnded: observers.onTurnEnded },
      tools: new RequestToolMap([["handoff", testBaseTools().get("handoff")!]]),
    });

    await expect(run).rejects.toBeInstanceOf(HandoffCorrectionExhausted);
    expect(capturedMessages).toHaveLength(3);
  });

  test("(h) workflow worker: active subagent blocks clean exit until notification arrives", async () => {
    const handoffPath = tempHandoffPath();
    const { promise, resolve } = createDeferred<BackgroundWorkResult>();
    const { client, capturedMessages } = makeCaptureClient([
      { events: [
        { kind: "text_delta", text: "Waiting for reviewer.", blockKey: "text" },
        { kind: "tool_use", toolCall: { id: "wait-reviewer", name: "process", input: { action: "wait", soft_timeout: 30 } } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "handoff", input: { summary: "done" } } },
        { kind: "done", stopReason: "tool_use" },
      ] },
    ]);
    const injectionQueue = new WorkflowInjectionQueue();
    const backgroundTasks = createBackgroundWorkRegistry({
      kind: "workflow",
      enqueueNotification: (text) => { injectionQueue.enqueue(text, { silent: true }); },
    });
    backgroundTasks.track({
      done: promise,
      meta: { id: "reviewer-1", type: "subagent", description: "Review implementation" },
    });
    const observers = createWorkflowLoopObservers({
      parentChannel: true,
      injectionQueue,
      backgroundTasks,
      emit: () => {},
      sessionId: "wf-background-gate",
    });

    const run = runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "produce handoff",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      handoff: { onContent: (content) => { writeFileSync(handoffPath, JSON.stringify(content, null, 2)); } },
      onEvent: () => {},
      inputSource: observers.inputSource,
      lifecycle: {
        onTurnEnded: observers.onTurnEnded,
      },
      background: createBackgroundExecutionOwner(backgroundTasks),
      tools: new RequestToolMap([["handoff", testBaseTools().get("handoff")!], ["process", createProcessTool(backgroundTasks)]]),
    });
    // Macrotask, not one microtask: the loop resolves its planned attempt
    // before the first request, so a fixed tick count is not a boundary.
    await Bun.sleep(0);
    expect(capturedMessages).toHaveLength(1);
    resolve({ status: "completed", content: "review passed" });

    await expect(run).resolves.toEqual({ kind: "completed" });
    expect(capturedMessages).toHaveLength(2);
    expect(JSON.stringify(capturedMessages[1]?.at(-1)?.content)).toContain("review passed");
  });

  test("(i) workflow worker: aborting the runner signal while parked on active subagents stops without nudge", async () => {
    const handoffPath = tempHandoffPath();
    const { promise } = createDeferred<BackgroundWorkResult>();
    const { client, capturedMessages } = makeCaptureClient([
      { events: [
        { kind: "text_delta", text: "Waiting for reviewer.", blockKey: "text" },
        { kind: "tool_use", toolCall: { id: "wait-reviewer", name: "process", input: { action: "wait", soft_timeout: 30 } } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [
        { kind: "text_delta", text: "should not run", blockKey: "text" },
        { kind: "done", stopReason: "end_turn" },
      ] },
    ]);
    const injectionQueue = new WorkflowInjectionQueue();
    const backgroundTasks = createBackgroundWorkRegistry({
      kind: "workflow",
      enqueueNotification: (text) => { injectionQueue.enqueue(text, { silent: true }); },
    });
    backgroundTasks.track({
      done: promise,
      meta: { id: "reviewer-1", type: "subagent", description: "Review implementation" },
    });
    const observers = createWorkflowLoopObservers({
      parentChannel: true,
      injectionQueue,
      backgroundTasks,
      emit: () => {},
      sessionId: "wf-background-aborted",
    });

    const abort = new AbortController();
    const run = runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "produce handoff",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      handoff: { onContent: (content) => { writeFileSync(handoffPath, JSON.stringify(content, null, 2)); } },
      signal: abort.signal,
      onEvent: () => {},
      inputSource: observers.inputSource,
      lifecycle: {
        onTurnEnded: observers.onTurnEnded,
      },
      background: createBackgroundExecutionOwner(backgroundTasks),
      tools: new RequestToolMap([["handoff", testBaseTools().get("handoff")!], ["process", createProcessTool(backgroundTasks)]]),
    });
    // Macrotask, not one microtask: the loop resolves its planned attempt
    // before the first request, so a fixed tick count is not a boundary.
    await Bun.sleep(0);
    expect(capturedMessages).toHaveLength(1);
    abort.abort();

    await expect(run).resolves.toEqual({ kind: "aborted" });
    expect(capturedMessages).toHaveLength(1);
  });

  function createDeferred<T>() {
    let resolveFn: (value: T) => void = () => {};
    const promise = new Promise<T>((resolve) => { resolveFn = resolve; });
    return { promise, resolve: resolveFn };
  }
});
