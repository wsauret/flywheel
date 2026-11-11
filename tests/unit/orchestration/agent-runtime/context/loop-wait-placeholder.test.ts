import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import type { ProviderStreamEvent, StreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { createProcessTool } from "../../../../../src/orchestration/agent-runtime/tools/process.js";
import { makeCaptureClient, makeFakeLLMClient } from "./_loop-fixtures.js";
import { createHandoffTool } from "../../../../../src/orchestration/agent-runtime/tools/handoff.js";
import { messageInput } from "../../../../../src/infra/agent-loop-events.js";
import { createEmit, EventBus } from "../../../../../src/infra/event-bus.js";
import { createRunnerBusBridge } from "../../../../../src/orchestration/runner/bus-bridge.js";
import { SessionEventAdapter } from "../../../../../src/orchestration/session-store/event-adapter.js";
import { createOutputSession } from "../../../../../src/orchestration/runner/output-session.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

const loopIdentity = { userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", providerSessionKey: "wait-placeholder", promptCacheKey: "wait-placeholder", artifactScopeId: "wait-placeholder", retrievalSessionId: "wait-placeholder" };

function toolMap(...tools: RuntimeTool[]): RequestToolMap {
  return new RequestToolMap(tools.map((tool) => [tool.name, tool]));
}

function ownerWithInFlightTask() {
  // One never-resolving subagent keeps the registry's active set non-empty.
  const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
  registry.track({ done: new Promise<never>(() => {}), meta: { id: "bg_1", type: "subagent", description: "in flight" } });
  return createBackgroundExecutionOwner(registry);
}

function processTool(): RuntimeTool {
  return createProcessTool(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }));
}

describe("agent loop wait settlement", () => {
  const handoffDirectory = temporaryDirectories();

  // Wait-shaped calls execute as ordinary tool calls (every provider transcript
  // must carry a result for every call; a stateful transport permanently
  // rejects a conversation whose recorded call has no output). The park
  // semantics settle after the batch: work in flight parks the turn, nothing
  // in flight answers with a silent wait_notification.
  test("with background work pending, a wait-shaped bash call executes and the turn parks instead of re-requesting", async () => {
    const client = makeFakeLLMClient([{
      events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "bash", input: { command: "echo waiting" } } },
        { kind: "done", stopReason: "tool_use" },
      ],
    }]);

    const events: StreamEvent[] = [];
    const result = await runAgentLoop({
      client,
      tools: toolMap({
        name: "bash", action: "shell_exec", description: "wait placeholder",
        inputSchema: { type: "object" }, isConcurrencySafe: true,
        execute: async () => ({ content: "placeholder acknowledged", outcome: "ok" }),
      }),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "wait for background work",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      background: ownerWithInFlightTask(),
      onEvent: (event) => { events.push(event); },
    });

    // The single-turn client proves the loop did not re-request: the wait-only
    // batch ended the turn.
    expect(result.kind).toBe("completed");
    expect(events.some((event) => event.kind === "tool_use")).toBe(true);
    expect(events.some((event) => event.kind === "tool_result")).toBe(true);
    expect(JSON.stringify(events)).toContain("placeholder acknowledged");
  });

  test("with background work pending, a wait tool call records a parked acknowledgement and the turn parks", async () => {
    const client = makeFakeLLMClient([{
      events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "process", input: { action: "wait", note: "reviewer results" } } },
        { kind: "done", stopReason: "tool_use" },
      ],
    }]);

    const events: StreamEvent[] = [];
    const result = await runAgentLoop({
      client,
      tools: toolMap(processTool()),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "wait for background work",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      background: ownerWithInFlightTask(),
      onEvent: (event) => { events.push(event); },
    });

    expect(result.kind).toBe("completed");
    expect(events.some((event) => event.kind === "tool_use")).toBe(true);
    const toolResults = events.filter((event) => event.kind === "tool_result");
    expect(toolResults).toHaveLength(1);
    expect(JSON.stringify(toolResults[0])).toContain("Wait acknowledged");
  });

  test("B1 native process wait lets the loop settle incremental background results", async () => {
    const first = Promise.withResolvers<BackgroundWorkResult>();
    const second = Promise.withResolvers<BackgroundWorkResult>();
    const queued: ReturnType<typeof messageInput>[] = [];
    const canonicalNotifications: string[] = [];
    let wake: (() => void) | null = null;
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: (text) => {
        queued.push(messageInput(text, { origin: "silent-system" }));
        wake?.();
        wake = null;
      },
    });
    registry.track({ done: first.promise, meta: { id: "first", type: "subagent", description: "First" } });
    registry.track({ done: second.promise, meta: { id: "second", type: "subagent", description: "Second" } });

    const waitTurn = (id: string) => ({
      events: [
        { kind: "tool_use", toolCall: { id, name: "process", input: { action: "wait" } } },
        { kind: "done", stopReason: "tool_use" },
      ] satisfies ProviderStreamEvent[],
    });
    const client = makeFakeLLMClient([
      waitTurn("tc_1"),
      waitTurn("tc_2"),
      {
        events: [
          { kind: "text_delta", text: "Both results incorporated.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    let parkCount = 0;
    const result = await runAgentLoop({
      client,
      tools: toolMap(createProcessTool(registry)),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "wait for both subagents",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: {
        history: {
          append: (message) => {
            if (message.kind === "user" && typeof message.content === "string" && message.content.includes("<subagent_notifications>")) {
              canonicalNotifications.push(message.content);
            }
          },
        },
      },
      seed: { kind: "fresh" },
      background: createBackgroundExecutionOwner(registry),
      inputSource: {
        drainPending: () => queued.shift() ?? null,
        prepareWaitForInput: () => ({
          commit: async () => {
            parkCount++;
            if (parkCount === 1) first.resolve({ status: "completed", content: "one" });
            if (parkCount === 2) second.resolve({ status: "completed", content: "two" });
            if (queued.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
            return queued.shift() ?? null;
          },
          cancel: async () => {},
        }),
      },
      onEvent: () => {},
      completeOnIdle: {},
    });

    expect(result.kind).toBe("completed");
    expect(parkCount).toBe(2);
    expect(canonicalNotifications).toHaveLength(2);
    expect(canonicalNotifications[0]).toContain("<remaining_active>1</remaining_active>");
    expect(canonicalNotifications[1]).toContain("<remaining_active>0</remaining_active>");
  });

  test("a non-subagent task returns an interrupted wait to Waiting after parallel chat work", async () => {
    const task = Promise.withResolvers<BackgroundWorkResult>();
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} });
    registry.track({ done: task.promise, meta: { id: "benchmark-1", type: "benchmark", description: "Explorer benchmark" } });

    const eventBus = new EventBus();
    const bridge = createRunnerBusBridge({ emit: createEmit(eventBus), sessionId: "background-wait" });
    const waitingStates: boolean[] = [];
    const outputSession = createOutputSession({ executionCwd: "/scratch", updateEntry: () => {} });
    const adapter = new SessionEventAdapter({
      updateEntry: (patch) => {
        if (patch.waitingOnBackgroundWork !== undefined && patch.waitingOnBackgroundWork !== waitingStates.at(-1)) waitingStates.push(patch.waitingOnBackgroundWork);
      },
      outputSession,
    });
    adapter.connect(eventBus);

    const client = makeFakeLLMClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "wait-1", name: "process", input: { action: "wait" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "done", stopReason: "end_turn" },
        ],
      },
      {
        events: [
          { kind: "tool_use", toolCall: { id: "wait-2", name: "process", input: { action: "wait", soft_timeout: 30 } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
    ]);
    let parkCount = 0;

    const result = await runAgentLoop({
      client,
      tools: toolMap(createProcessTool(registry)),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "wait for the benchmark",
      executionCwd: "/scratch",
      ...loopIdentity,
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "background-wait", promptCacheKey: "background-wait",
      artifactScopeId: "background-wait",
      retrievalSessionId: "background-wait",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      background: createBackgroundExecutionOwner(registry),
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => {
            parkCount++;
            if (parkCount === 1) return messageInput("Do this other work while the benchmark runs.");
            task.resolve({ status: "completed", content: "done" });
            return null;
          },
          cancel: async () => {},
        }),
      },
      lifecycle: bridge.lifecycle,
      onEvent: () => {},
    });

    adapter.disconnect();
    outputSession.dispose();
    expect(result.kind).toBe("input_closed");
    expect(waitingStates).toEqual([true, false, true]);
  });

  test("without background work, a wait tool call is acknowledged and answered by a silent wait_notification", async () => {
    const client = makeFakeLLMClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "process", input: { action: "wait" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "done", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const queued: ReturnType<typeof messageInput>[] = [];
    const silent: string[] = [];
    const events: StreamEvent[] = [];
    const result = await runAgentLoop({
      client,
      tools: toolMap(processTool()),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "wait for background work",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      inputSource: {
        drainPending: () => queued.shift() ?? null,
        enqueueRuntimeNotice: (text) => {
          silent.push(text);
          queued.push(messageInput(text, { origin: "silent-system" }));
        },
      },
      onEvent: (event) => { events.push(event); },
    });

    expect(result.kind).toBe("completed");
    // The wait executes like any tool call: its acknowledgement is durable.
    expect(events.some((event) => event.kind === "tool_use")).toBe(true);
    expect(events.some((event) => event.kind === "tool_result")).toBe(true);
    // The model learns the wait was a no-op through the silent channel, which
    // re-drives the loop into turn 2.
    expect(silent).toHaveLength(1);
    expect(silent[0]).toContain("<wait_notification>");
    expect(silent[0]).toContain("hidden_from_user");
  });

  test("a wait batched with other calls runs them first, then parks before the next model request", async () => {
    // Regression: a wait parked only when it was the batch's only call. Batched
    // beside other calls, its acknowledgement promised a park, the loop asked
    // the model again at once, and the model wrote a fake notification of its
    // own. The batch's other calls run first, and the wait settles after the
    // batch, so the dispatch made in this same batch counts as live work.
    let settle: ((result: BackgroundWorkResult) => void) | null = null;
    const queued: ReturnType<typeof messageInput>[] = [];
    let wake: (() => void) | null = null;
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: (text) => {
        queued.push(messageInput(text, { origin: "silent-system" }));
        wake?.();
        wake = null;
      },
    });
    const launchTool: RuntimeTool = {
      name: "launch",
      action: "ui_meta",
      description: "registers a background task",
      inputSchema: { type: "object", properties: {} },
      isConcurrencySafe: true,
      execute: async () => {
        const done = new Promise<BackgroundWorkResult>((resolve) => { settle = resolve; });
        registry.track({ done, meta: { id: "bg_1", type: "subagent", description: "spawned mid-turn" } });
        return { content: "launched", outcome: "ok" };
      },
    };
    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "launch", input: {} } },
          { kind: "tool_use", toolCall: { id: "tc_2", name: "process", input: { action: "wait" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "incorporated", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const silent: string[] = [];
    let parkCount = 0;
    const result = await runAgentLoop({
      client,
      tools: toolMap(launchTool, createProcessTool(registry)),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "dispatch then wait",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      background: createBackgroundExecutionOwner(registry),
      inputSource: {
        drainPending: () => queued.shift() ?? null,
        enqueueRuntimeNotice: (text) => { silent.push(text); },
        prepareWaitForInput: () => ({
          commit: async () => {
            parkCount++;
            settle?.({ status: "completed", content: "subagent result" });
            if (queued.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
            return queued.shift() ?? null;
          },
          cancel: async () => {},
        }),
      },
      onEvent: () => {},
      completeOnIdle: {},
    });

    expect(result.kind).toBe("completed");
    expect(parkCount).toBe(1);
    // Work was in flight when the batch settled, so no no-op notice.
    expect(silent).toHaveLength(0);
    // The loop asked the model again only after the park, and that request
    // carries the real notification.
    expect(capturedMessages).toHaveLength(2);
    expect(JSON.stringify(capturedMessages[1]?.at(-1))).toContain("subagent result");
  });

  test("a refused handoff over live work keeps input open until the verifier settles", async () => {
    const handoffPath = join(handoffDirectory("flywheel-handoff-"), "handoff.json");
    const client = makeFakeLLMClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "handoff", input: { summary: "done" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_2", name: "process", input: { action: "wait", note: "verifier" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_3", name: "handoff", input: { summary: "verified" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
    ]);

    const queued: ReturnType<typeof messageInput>[] = [];
    let wake: (() => void) | null = null;
    const registry = createBackgroundWorkRegistry({
      kind: "workflow",
      enqueueNotification: (text) => {
        queued.push(messageInput(text, { origin: "silent-system" }));
        wake?.();
      },
    });
    let settleTask: (() => void) | null = null;
    registry.track({
      done: new Promise((resolve) => {
        settleTask = () => { resolve({ status: "completed", content: "verifier passed" }); };
      }),
      meta: { id: "bg_1", type: "background_command", description: "verifier" },
    });

    let parkCount = 0;
    const result = await runAgentLoop({
      client,
      tools: new RequestToolMap([
        ["handoff", createHandoffTool({ schema: { input: { type: "object", properties: { summary: { type: "string", description: "summary" } }, required: ["summary"] } } })],
        ["process", createProcessTool(registry)],
      ]),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "implement then verify",
      executionCwd: "/scratch",
      ...loopIdentity,
      handoff: {
        onContent: (content) => {
          writeFileSync(handoffPath, JSON.stringify(content, null, 2));
        },
      },
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      background: createBackgroundExecutionOwner(registry),
      inputSource: {
        drainPending: () => queued.shift() ?? null,
        prepareWaitForInput: () => ({
          commit: async () => {
            parkCount++;
            // Settle only once parked, mirroring a verifier that finishes while
            // the worker waits; the settle notification wakes the park.
            settleTask?.();
            settleTask = null;
            if (queued.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
            return queued.shift() ?? null;
          },
          cancel: async () => {},
        }),
      },
      onEvent: () => {},
    });

    expect(result.kind).toBe("completed");
    expect(parkCount).toBe(1);
  });

  test("a turn that completes on idle requests an estimated wait before a background command settles, a server included", async () => {
    // A post-workflow follow-up completes on idle, and its host closes its
    // background owner once the turn completes. A command, a server
    // included, must have ended by then, so a close in a planned
    // replacement's stop never meets a command whose turn ended normally.
    const client = makeFakeLLMClient([
      { events: [{ kind: "tool_use", toolCall: { id: "tc_1", name: "start", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "text_delta", text: "The server runs.", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
      { events: [
        { kind: "tool_use" as const, toolCall: { id: "tc_wait", name: "process", input: { action: "wait", soft_timeout: 30 } } },
        { kind: "done" as const, stopReason: "tool_use" as const },
      ] },
      { events: [{ kind: "text_delta" as const, text: "The server finished.", blockKey: "text" }, { kind: "done" as const, stopReason: "end_turn" as const }] },
    ]);
    const queued: ReturnType<typeof messageInput>[] = [];
    let wake: (() => void) | null = null;
    const registry = createBackgroundWorkRegistry({
      kind: "workflow",
      enqueueNotification: (text) => {
        queued.push(messageInput(text, { origin: "silent-system" }));
        wake?.();
      },
    });
    const command = Promise.withResolvers<BackgroundWorkResult>();
    const start: RuntimeTool = {
      name: "start",
      action: "shell_exec",
      description: "starts a background command",
      inputSchema: { type: "object" },
      isConcurrencySafe: true,
      execute: async () => {
        registry.track({ done: command.promise, meta: { id: "bg_1", type: "background_command", description: "server" } });
        return { content: "Running in background as managed process bg_1.", outcome: "ok" };
      },
    };
    let parkCount = 0;

    const result = await runAgentLoop({
      client,
      tools: toolMap(start, createProcessTool(registry)),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "start the server",
      executionCwd: "/scratch",
      ...loopIdentity,
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "complete-on-idle", promptCacheKey: "complete-on-idle",
      artifactScopeId: "complete-on-idle",
      retrievalSessionId: "complete-on-idle",
      completeOnIdle: {},
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      background: createBackgroundExecutionOwner(registry),
      inputSource: {
        drainPending: () => queued.shift() ?? null,
        prepareWaitForInput: () => ({
          commit: async () => {
            parkCount++;
            command.resolve({ status: "completed", content: "server exited 0" });
            if (queued.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
            return queued.shift() ?? null;
          },
          cancel: async () => {},
        }),
      },
      onEvent: () => {},
    });

    expect(result.kind).toBe("completed");
    expect(parkCount).toBe(1);
    expect(registry.activeTaskCount()).toBe(0);
  });

  test("a step that ends its turn over a running background server gets the pending-work nudge instead of parking idle, and hands off only after it stops the server", async () => {
    const call = (id: string, name: string, input: { [key: string]: unknown }) => ({ events: [{ kind: "tool_use" as const, toolCall: { id, name, input } }, { kind: "done" as const, stopReason: "tool_use" as const }] });
    const { client, capturedMessages } = makeCaptureClient([
      call("tc_1", "start", {}),
      { events: [{ kind: "text_delta", text: "The server runs.", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
      call("tc_2", "handoff", { summary: "early" }),
      call("tc_3", "stop", {}),
      call("tc_4", "handoff", { summary: "served" }),
      { events: [{ kind: "text_delta", text: "Done.", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
    ]);
    const registry = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} });
    const server = Promise.withResolvers<BackgroundWorkResult>();
    const start: RuntimeTool = { name: "start", action: "shell_exec", description: "starts a server", inputSchema: { type: "object" }, isConcurrencySafe: true, execute: async () => {
      registry.track({ done: server.promise, meta: { id: "bg_1", type: "background_command", description: "server" } });
      return { content: "Running in background as managed process bg_1.", outcome: "ok" };
    } };
    const stop: RuntimeTool = { name: "stop", action: "shell_exec", description: "stops the server", inputSchema: { type: "object" }, isConcurrencySafe: true, execute: async () => {
      server.resolve({ status: "cancelled", content: "" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { content: "Stopped process bg_1.", outcome: "ok" };
    } };
    const handedOff: unknown[] = [];
    let parkCount = 0;
    const result = await runAgentLoop({
      client, tools: new RequestToolMap([["start", start], ["stop", stop], ["handoff", createHandoffTool({ schema: { input: { type: "object", properties: { summary: { type: "string", description: "summary" } }, required: ["summary"] } } })]]),
      systemPrompt: stableSystemPrompt("test"), instruction: "start the server, then hand off",
      executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", providerSessionKey: "service-handoff", promptCacheKey: "service-handoff", artifactScopeId: "service-handoff", retrievalSessionId: "service-handoff",
      handoff: { onContent: (content) => { handedOff.push(content); } }, persistence: { history: { append: () => {} } }, seed: { kind: "fresh" }, background: createBackgroundExecutionOwner(registry),
      inputSource: { drainPending: () => null, prepareWaitForInput: () => ({ commit: async () => { parkCount++; return null; }, cancel: async () => {} }) },
      onEvent: () => {},
    });

    expect(result.kind).toBe("completed");
    expect(parkCount).toBe(0);
    expect(JSON.stringify(capturedMessages[2])).toContain("Managed work is still pending");
    expect(JSON.stringify(capturedMessages[3])).toContain("Still running: server");
    expect(handedOff).toEqual([{ summary: "served" }]);
    expect(registry.activeTaskCount()).toBe(0);
  });

  test("a running benchmark parks a wait, and its one notification wakes the loop", async () => {
    // A benchmark is not a subagent: it settles alone, through the standalone
    // notification path, and that single notification must be enough to wake a
    // loop that parked on it.
    const finish = Promise.withResolvers<BackgroundWorkResult>();
    const queued: ReturnType<typeof messageInput>[] = [];
    let wake: (() => void) | null = null;
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: (text) => {
        queued.push(messageInput(text, { origin: "silent-system" }));
        wake?.();
        wake = null;
      },
    });
    registry.track({
      done: finish.promise,
      meta: { id: "benchmark-explorer-2026", type: "benchmark", description: "run explorer benchmark" },
    });

    const client = makeFakeLLMClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "process", input: { action: "wait", note: "benchmark report" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "report incorporated", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const notifications: string[] = [];
    let parkCount = 0;
    const result = await runAgentLoop({
      client,
      tools: toolMap(createProcessTool(registry)),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "wait for the benchmark",
      executionCwd: "/scratch",
      ...loopIdentity,
      persistence: {
        history: {
          append: (message) => {
            if (message.kind === "user" && typeof message.content === "string" && message.content.includes("<benchmark_notification>")) {
              notifications.push(message.content);
            }
          },
        },
      },
      seed: { kind: "fresh" },
      background: createBackgroundExecutionOwner(registry),
      inputSource: {
        drainPending: () => queued.shift() ?? null,
        prepareWaitForInput: () => ({
          commit: async () => {
            parkCount++;
            finish.resolve({ status: "completed", content: "Benchmark explorer-2026 completed. Report: report.md." });
            if (queued.length === 0) await new Promise<void>((resolve) => { wake = resolve; });
            return queued.shift() ?? null;
          },
          cancel: async () => {},
        }),
      },
      onEvent: () => {},
      completeOnIdle: {},
    });

    expect(result.kind).toBe("completed");
    expect(parkCount).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toContain("Benchmark explorer-2026 completed");
  });
});
