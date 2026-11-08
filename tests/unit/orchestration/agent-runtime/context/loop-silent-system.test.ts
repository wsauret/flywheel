import { describe, expect, test } from "bun:test";

import { messageInput, type AgentLoopInput } from "../../../../../src/infra/agent-loop-events.js";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import { ChatTurnMailbox } from "../../../../../src/orchestration/chat/turn-mailbox.js";
import { RunLifecycle } from "../../../../../src/orchestration/agent-runtime/run-lifecycle.js";
import type { ConversationMessage, StreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { makeCaptureClient, makeFakeLLMClient, throwLoopError, waitUntil } from "./_loop-fixtures.js";
import type { AgentLoopTerminal } from "../../../../../src/orchestration/agent-runtime/agent-loop-types.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { consumeAgentLoopInput } from "../../../../../src/orchestration/agent-runtime/agent-loop-input-consumer.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { createProcessTool } from "../../../../../src/orchestration/agent-runtime/tools/process.js";

function cloneAgentMessage(message: ConversationMessage): ConversationMessage {
  return structuredClone(message);
}

function subagentBatchInput() {
  return messageInput(
    `<subagent_notifications>
<source>runtime</source>
<visibility>hidden_from_user</visibility>
<handling>Incorporate all completed subagent results into the task and continue.</handling>
<remaining_active>0</remaining_active>
<completed_count>1</completed_count>
<subagent_notification>
<description>Search</description>
<status>completed</status>
<result>
found config
</result>
</subagent_notification>
</subagent_notifications>`,
    { origin: "silent-system" },
  );
}

describe("experiment compaction continuation", () => {
  test("records continuation before a parked compact resumes the loop", async () => {
    const order: string[] = [];

    const result = await consumeAgentLoopInput(
      { kind: "compact" },
      {
        consumeMessage: () => "continue",
        consumeResume: async () => "continue",
        scheduleCompaction: () => { order.push("schedule"); },
        canCompact: () => true,
        refuseCompaction: () => {},
        onCompactionContinuation: async () => { order.push("resume"); },
      },
      { compactAfter: "park" },
    );

    expect(result).toBe("continue");
    expect(order).toEqual(["schedule", "resume"]);
  });
});

describe("agent loop silent-system subagent batches", () => {
  test("treats the completed subagent batch as the next model turn", async () => {
    const client = makeFakeLLMClient([{
      events: [
        { kind: "text_delta", text: "Combined synthesis.", blockKey: "synthesis" },
        { kind: "done", stopReason: "end_turn" },
      ],
    }]);

    const events: StreamEvent[] = [];
    const canonical: ConversationMessage[] = [];
    let drained = false;
    const result = await runAgentLoop({
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "wait for background work",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "silent-system-next-turn", promptCacheKey: "silent-system-next-turn", artifactScopeId: "silent-system-next-turn",
      retrievalSessionId: "silent-system-next-turn",
      onEvent: (event) => { events.push(event); },
      persistence: { history: { append: (message) => { canonical.push(cloneAgentMessage(message)); } } },
      seed: { kind: "fresh" },
      inputSource: {
        drainPending: () => {
          if (drained) return null;
          drained = true;
          return subagentBatchInput();
        },
        prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }),
      },
    });

    expect(result.kind).toBe("input_closed");
    expect(events.some((event) => event.kind === "text_delta" && event.text === "Combined synthesis.")).toBe(true);
    expect(canonical.some((message) =>
      message.kind === "user" &&
      typeof message.content === "string" &&
      message.content.includes("<subagent_notifications>"),
    )).toBe(true);
    expect(canonical.some((message) =>
      message.kind === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "text" && block.text === "Combined synthesis."),
    )).toBe(true);
  });

  test("drains a silent-system notification enqueued during a tool batch into the very next model call", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "noop", input: {} } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [
        { kind: "text_delta", text: "Acted on the recommendation.", blockKey: "recommendation" },
        { kind: "done", stopReason: "end_turn" },
      ] },
    ]);

    const queued: AgentLoopInput[] = [];
    const tool: RuntimeTool = {
      name: "noop",
      action: "shell_exec",
      description: "No-op tool",
      inputSchema: { type: "object" },
      isConcurrencySafe: true,
      execute: async () => {
        // A background review settles while the batch runs: the host enqueues
        // one silent-system notification on the loop's input source.
        queued.push(messageInput("<skill_recommendation>rec-1</skill_recommendation>", { origin: "silent-system" }));
        return { content: "ok", outcome: "ok" };
      },
    };

    const result = await runAgentLoop({
      client,
      tools: new RequestToolMap([[tool.name, tool]]),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "start work",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "silent-system-tool-batch", promptCacheKey: "silent-system-tool-batch", artifactScopeId: "silent-system-tool-batch",
      retrievalSessionId: "silent-system-tool-batch",
      onEvent: () => {},
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      inputSource: {
        drainPending: () => queued.shift() ?? null,
        prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }),
      },
    });

    expect(result.kind).toBe("input_closed");
    expect(capturedMessages).toHaveLength(2);
    // The post-tool-batch drain point delivered the notification before the
    // next model call: it rides in as the trailing user message, after the
    // tool result, not deferred to turn end.
    const followUp = capturedMessages[1] ?? [];
    const last = followUp.at(-1);
    if (last?.kind !== "user" || typeof last.content !== "string") throw new Error("expected a trailing user message");
    expect(last.content).toContain("<skill_recommendation>");
    const deliveries = followUp.filter((message) =>
      message.kind === "user" &&
      typeof message.content === "string" &&
      message.content.includes("<skill_recommendation>"),
    );
    expect(deliveries).toHaveLength(1);
  });

  test("a wait's runtime notice enters history labeled, apart from an unlabeled silent nudge", async () => {
    const { client } = makeCaptureClient([
      { events: [{ kind: "tool_use", toolCall: { id: "tc_1", name: "noop", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "text_delta", text: "Read the nudge.", blockKey: "a" }, { kind: "done", stopReason: "end_turn" }] },
      { events: [{ kind: "text_delta", text: "Read the result.", blockKey: "b" }, { kind: "done", stopReason: "end_turn" }] },
    ]);
    const mailbox = new ChatTurnMailbox();
    const tool: RuntimeTool = {
      name: "noop", action: "shell_exec", description: "No-op tool", inputSchema: { type: "object" }, isConcurrencySafe: true,
      execute: async () => {
        mailbox.enqueueSilentSystem("<repetition_nudge/>");
        mailbox.enqueueRuntimeNotice("<wait_notification/>");
        return { content: "ok", outcome: "ok" };
      },
    };
    const canonical: ConversationMessage[] = [];
    const result = await runAgentLoop({
      client, tools: new RequestToolMap([[tool.name, tool]]), systemPrompt: stableSystemPrompt("test"), instruction: "start work",
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "runtime-notice-label", promptCacheKey: "runtime-notice-label", artifactScopeId: "runtime-notice-label", retrievalSessionId: "runtime-notice-label",
      onEvent: () => {},
      persistence: { history: { append: (message) => { canonical.push(cloneAgentMessage(message)); } } },
      seed: { kind: "fresh" },
      inputSource: {
        drainPending: () => mailbox.drainPending(),
        prepareWaitForInput: () => ({ commit: async () => mailbox.drainPending(), cancel: async () => {} }),
      },
    });

    expect(result.kind).toBe("input_closed");
    expect(canonical.filter((message) => message.kind === "user")).toEqual([
      { kind: "user", content: "start work", origin: "system" },
      { kind: "user", content: "<repetition_nudge/>", origin: "system" },
      { kind: "user", content: "<wait_notification/>", origin: "system", runtimeNotice: true },
    ]);
  });

  test("bounded input source waits for managed background settlement before completing", async () => {
    const task = Promise.withResolvers<BackgroundWorkResult>();
    const mailbox = new ChatTurnMailbox();
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: (notification) => mailbox.enqueueSilentSystem(notification),
    });
    const background = createBackgroundExecutionOwner(registry);
    registry.track({
      done: task.promise,
      meta: { id: "background-1", type: "background_command", description: "long build", toolUseId: "tool-1" },
    });
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "tool_use", toolCall: { id: "wait-build", name: "process", input: { action: "wait", soft_timeout: 30 } } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "text_delta", text: "Build settled.", blockKey: "settled" }, { kind: "done", stopReason: "end_turn" }] },
    ]);
    let settled = false;

    const resultPromise = runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("You are a helpful assistant."),
      instruction: "Complete the build",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "silent-system-background-settlement", promptCacheKey: "silent-system-background-settlement", artifactScopeId: "silent-system-background-settlement",
      retrievalSessionId: "silent-system-background-settlement",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: mailbox,
      completeOnIdle: {},
      background,
      tools: new RequestToolMap([["process", createProcessTool(registry)]]),
    }).finally(() => { settled = true; });

    await Bun.sleep(0);
    expect(capturedMessages).toHaveLength(1);
    expect(settled).toBe(false);

    task.resolve({ status: "completed", content: "build complete" });
    const result = await resultPromise;

    expect(result.kind).toBe("completed");
    expect(capturedMessages).toHaveLength(2);
    expect(JSON.stringify(capturedMessages[1])).toContain("background_command_notification");
    await background.close();
  });

  test("a legacy sleep asks to wait, while text over remaining work needs a fresh explicit estimate before parking", async () => {
    const mailbox = new ChatTurnMailbox();
    const lifecycle = new RunLifecycle<AgentLoopTerminal>();
    // As in production: the registry always keys a notification, and the chat delivers it as a background notification.
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text, key) => mailbox.enqueueBackgroundNotification({ text, ...(key ? { key } : {}) }) });
    const first = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({ done: first.promise, meta: { id: "build-1", type: "background_command", description: "first build", toolUseId: "tool-build-1" } });
    registry.track({ done: Promise.withResolvers<BackgroundWorkResult>().promise, meta: { id: "build-2", type: "background_command", description: "second build", toolUseId: "tool-build-2" } });
    const bash: RuntimeTool = {
      name: "bash",
      action: "shell_exec",
      description: "Shell",
      inputSchema: { type: "object" },
      isConcurrencySafe: true,
      execute: async () => ({ content: "", outcome: "ok" }),
    };
    const { client, capturedMessages } = makeCaptureClient([
      { events: [
        { kind: "text_delta", text: "Both builds run.", blockKey: "running" },
        { kind: "tool_use", toolCall: { id: "tc_sleep", name: "bash", input: { command: "sleep 5" } } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [{ kind: "text_delta", text: "The first build passed.", blockKey: "first" }, { kind: "done", stopReason: "end_turn" }] },
      { events: [{ kind: "tool_use", toolCall: { id: "wait-second", name: "process", input: { action: "wait", soft_timeout: 30 } } }, { kind: "done", stopReason: "tool_use" }] },
    ]);
    const parks: { activeBackgroundCount: number; waitRequested: boolean }[] = [];
    let loopError: Error | undefined;
    void lifecycle.done.catch((error) => { loopError = error instanceof Error ? error : new Error(String(error)); });

    expect(lifecycle.start((signal) => runAgentLoop({
      client,
      tools: new RequestToolMap([[bash.name, bash], ["process", createProcessTool(registry)]]),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "run both builds",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "wait-requested-park", promptCacheKey: "wait-requested-park", artifactScopeId: "wait-requested-park", retrievalSessionId: "wait-requested-park",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: mailbox,
      background: createBackgroundExecutionOwner(registry),
      signal,
      currentTurn: lifecycle,
      lifecycle: {
        onTurnParked: ({ activeBackgroundCount, waitRequested }) => { parks.push({ activeBackgroundCount, waitRequested }); },
      },
    }))).toBe(true);

    await waitUntil(() => parks.length >= 1 || loopError !== undefined, "the sleep did not park the turn");
    throwLoopError(loopError);
    first.resolve({ status: "completed", content: "first build passed" });
    await waitUntil(() => parks.length >= 2 || loopError !== undefined, "the turn that ended in text did not park");
    throwLoopError(loopError);
    expect(parks).toEqual([
      { activeBackgroundCount: 2, waitRequested: true },
      { activeBackgroundCount: 1, waitRequested: true },
    ]);
    expect(capturedMessages).toHaveLength(3);
    expect(JSON.stringify(capturedMessages[2])).toContain("fresh remaining-work estimate");

    lifecycle.abort({ kind: "aborted" });
    await lifecycle.done;
  });

});
