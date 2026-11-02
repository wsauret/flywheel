import { describe, expect, test } from "bun:test";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import type { ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { createProcessTool } from "../../../../../src/orchestration/agent-runtime/tools/process.js";
import { createHandoffTool } from "../../../../../src/orchestration/agent-runtime/tools/handoff.js";
import { ChatTurnMailbox } from "../../../../../src/orchestration/chat/turn-mailbox.js";
import { WorkflowInjectionQueue } from "../../../../../src/orchestration/workflow-host/injection-queue.js";
import { createWorkflowLoopObservers } from "../../../../../src/orchestration/workflow-host/loop-observers.js";
import { SUBAGENT_HANDOFF_SCHEMA } from "../../../../../src/orchestration/modules/subagents/execution/prompts.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { assemblyPinned, RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { makeCaptureClient } from "./_loop-fixtures.js";

const waitCall = (id: string, seconds: number, processId?: string) => ({ events: [
  { kind: "tool_use", toolCall: { id, name: "process", input: { action: "wait", soft_timeout: seconds, ...(processId === undefined ? {} : { process_id: processId }) } } },
  { kind: "done", stopReason: "tool_use" },
] satisfies ProviderStreamEvent[] });

describe("finite managed waits", () => {
  test.each((["root", "subagent", "workflow"] as const).flatMap((kind) =>
    (["ahead", "expired", "nothing_pending", "queued_message", "person_interrupt"] as const).map((scenario) => ({ kind, scenario }))))("restores a $scenario wait in a $kind loop without an unsolicited request", async ({ kind, scenario }) => {
    const inputSource = kind === "root" ? new ChatTurnMailbox() : new WorkflowInjectionQueue();
    const stop = new AbortController();
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => inputSource.enqueueRuntimeNotice(text) });
    if (scenario !== "nothing_pending") registry.track({
      done: new Promise<BackgroundWorkResult>(() => {}),
      meta: { id: "pending", type: "background_command", description: "pending" },
    });
    if (scenario === "queued_message") {
      if (inputSource instanceof ChatTurnMailbox) inputSource.enqueueNextTurn("new instruction");
      else inputSource.enqueueMessage("new instruction");
    } else if (inputSource instanceof ChatTurnMailbox) inputSource.enqueueHold();
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "done", stopReason: "end_turn" }] },
    ], { onRequest: () => { stop.abort(); } });
    const durations: number[] = [];
    const deadlineMs = Date.now() + (scenario === "expired" ? -1000 : 60_000);
    await runAgentLoop({
      client, tools: await assemblyPinned(new RequestToolMap()), systemPrompt: stableSystemPrompt("test"),
      instruction: "", executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: kind, promptCacheKey: kind, artifactScopeId: kind, retrievalSessionId: kind,
      seed: { kind: "resume", priorMessages: [{ kind: "user", origin: "system", content: "Interrupted by the runtime." }] },
      persistence: { history: { append: () => {} } },
      background: createBackgroundExecutionOwner(registry), inputSource, signal: stop.signal,
      lifecycle: {
        restoredWait: { deadlineMs },
        ...(kind === "root" || scenario === "person_interrupt" ? { maintenance: { awaitsPerson: scenario === "person_interrupt", turnEndWaits: scenario === "person_interrupt" } } : {}),
        onTurnParked: () => { if (scenario === "person_interrupt") stop.abort(); },
      },
      scheduleWaitExpiry: (seconds, expire) => {
        durations.push(seconds);
        if (scenario === "expired") queueMicrotask(expire);
        else stop.abort();
        return () => {};
      },
      onEvent: () => {},
    });
    const wakes = scenario !== "ahead" && scenario !== "person_interrupt";
    expect(capturedMessages).toHaveLength(wakes ? 1 : 0);
    if (scenario === "ahead") {
      expect(durations).toHaveLength(1);
      expect(durations[0]).toBeGreaterThan(59);
      expect(durations[0]).toBeLessThanOrEqual(60);
    }
    if (scenario === "expired") expect(JSON.stringify(capturedMessages[0])).toContain("wait_expired");
    if (scenario === "nothing_pending") expect(JSON.stringify(capturedMessages[0])).toContain("nothing_pending");
    if (scenario === "queued_message") expect(JSON.stringify(capturedMessages[0])).toContain("new instruction");
    if (scenario === "person_interrupt") expect(durations).toEqual([]);
  });

  test.each((["root", "subagent", "workflow"] as const).map((kind) => ({ kind })))("one-shot expiry requires a fresh estimate and preserves work in a $kind loop", async ({ kind }) => {
    const inputSource = kind === "root" ? new ChatTurnMailbox() : new WorkflowInjectionQueue();
    const task = Promise.withResolvers<BackgroundWorkResult>();
    const enqueueNotification = (text: string) => inputSource.enqueueRuntimeNotice(text);
    const registry = kind === "root"
      ? createBackgroundWorkRegistry({ kind: "chat", enqueueNotification })
      : createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification });
    const observers = inputSource instanceof WorkflowInjectionQueue && registry.kind === "workflow"
      ? createWorkflowLoopObservers({ parentChannel: true, injectionQueue: inputSource, backgroundTasks: registry, emit: () => {}, sessionId: kind })
      : undefined;
    registry.track({ done: task.promise, meta: { id: "pending-1", type: "background_command", description: "pending" } });
    const stop = new AbortController();
    const responses: { events: ProviderStreamEvent[] }[] = [
      // The native wait ignores a named process and parks on every process.
      waitCall("wait-1", 7200, "pending-1"),
      { events: [{ kind: "text_delta", text: "Still working.", blockKey: "progress" }, { kind: "done", stopReason: "end_turn" }] },
      waitCall("wait-2", 180),
      kind === "root"
        ? { events: [{ kind: "text_delta", text: "Done.", blockKey: "done" }, { kind: "done", stopReason: "end_turn" }] }
        : { events: [{ kind: "tool_use", toolCall: { id: "handoff", name: "handoff", input: { summary: "done", files_modified: [] } } }, { kind: "done", stopReason: "tool_use" }] },
    ];
    const { client, capturedMessages } = makeCaptureClient(responses);
    const durations: number[] = [];
    const pendingAtExpiry: number[] = [];
    let handoffs = 0;
    let cleared = 0;
    const process = createProcessTool(registry);
    const result = await runAgentLoop({
      client, tools: new RequestToolMap([["process", process], ["handoff", createHandoffTool({ schema: SUBAGENT_HANDOFF_SCHEMA })]]),
      systemPrompt: stableSystemPrompt("test"), instruction: "wait", executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: kind, promptCacheKey: kind, artifactScopeId: kind, retrievalSessionId: kind,
      seed: { kind: "fresh" }, persistence: { history: { append: () => {} } },
      background: createBackgroundExecutionOwner(registry), inputSource, signal: stop.signal,
      ...(kind === "root" ? {} : { handoff: { schema: SUBAGENT_HANDOFF_SCHEMA, onContent: () => { handoffs++; } } }),
      scheduleWaitExpiry: (seconds, expire) => {
        durations.push(seconds);
        if (durations.length === 1) queueMicrotask(() => { pendingAtExpiry.push(registry.awaitedTaskCount()); expire(); });
        else task.resolve({ status: "completed", content: "done" });
        return () => { cleared++; };
      },
      lifecycle: { onTurnEnded: observers?.onTurnEnded, onTurnParked: ({ park }) => { if (kind === "root" && park === "idle") stop.abort(); } },
      onEvent: () => {},
    });
    expect(result.kind).toBe(kind === "root" ? "aborted" : "completed");
    expect(handoffs).toBe(kind === "root" ? 0 : 1);
    expect(durations).toEqual([7200, 180]);
    expect(pendingAtExpiry).toEqual([1]);
    expect(cleared).toBe(2);
    expect(JSON.stringify(capturedMessages[1])).toContain("wait_expired");
    expect(JSON.stringify(capturedMessages[1])).toContain("Wait acknowledged for at most 7200 seconds");
    expect(JSON.stringify(capturedMessages[3])).toContain("Wait acknowledged for at most 180 seconds");
    expect(JSON.stringify(capturedMessages[2])).toContain("fresh remaining-work estimate");
    expect(registry.awaitedTaskCount()).toBe(0);
  });

  test.each(["root", "subagent", "workflow"] as const)("an explicit wait includes a background service but not a child that its parent interrupted, expires, and rewaits for completion in a %s loop", async (kind) => {
    const inputSource = kind === "root" ? new ChatTurnMailbox() : new WorkflowInjectionQueue();
    const task = Promise.withResolvers<BackgroundWorkResult>();
    const enqueueNotification = (text: string) => inputSource.enqueueRuntimeNotice(text);
    const registry = kind === "root"
      ? createBackgroundWorkRegistry({ kind: "chat", enqueueNotification })
      : createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification });
    registry.track({ done: task.promise, service: true, meta: { id: "background-build", type: "background_command", description: "build" } });
    registry.track({
      done: new Promise<never>(() => {}),
      meta: { id: "interrupted-child", type: "workflow", description: "paused" },
      interruption: { interruptedBy: () => "agent", observe: () => () => {} },
    });
    const observers = inputSource instanceof WorkflowInjectionQueue && registry.kind === "workflow"
      ? createWorkflowLoopObservers({ parentChannel: true, injectionQueue: inputSource, backgroundTasks: registry, emit: () => {}, sessionId: kind })
      : undefined;
    const stop = new AbortController();
    const durations: number[] = [];
    const counts: number[] = [];
    const { client, capturedMessages } = makeCaptureClient([
      waitCall("wait-1", 7200),
      waitCall("wait-2", 180),
      kind === "root"
        ? { events: [{ kind: "done", stopReason: "end_turn" }] }
        : { events: [{ kind: "tool_use", toolCall: { id: "handoff", name: "handoff", input: { summary: "done", files_modified: [] } } }, { kind: "done", stopReason: "tool_use" }] },
    ], { onRequest: () => {
      if (capturedMessages.length === 3 && durations.length === 0) {
        stop.abort();
        task.resolve({ status: "completed", content: "done" });
      }
    } });
    const result = await runAgentLoop({
      client, tools: new RequestToolMap([["process", createProcessTool(registry)], ["handoff", createHandoffTool({ schema: SUBAGENT_HANDOFF_SCHEMA })]]),
      systemPrompt: stableSystemPrompt("test"), instruction: "wait", executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: kind, promptCacheKey: kind, artifactScopeId: kind, retrievalSessionId: kind,
      seed: { kind: "fresh" }, persistence: { history: { append: () => {} } },
      background: createBackgroundExecutionOwner(registry), inputSource, signal: stop.signal,
      ...(kind === "root" ? {} : { handoff: { schema: SUBAGENT_HANDOFF_SCHEMA, onContent: () => {} } }),
      scheduleWaitExpiry: (seconds, expire) => {
        durations.push(seconds);
        if (durations.length === 1) queueMicrotask(expire);
        else task.resolve({ status: "completed", content: "done" });
        return () => {};
      },
      lifecycle: { onTurnEnded: observers?.onTurnEnded, onTurnParked: ({ park, activeBackgroundCount }) => {
        if (park === "waiting_on_work") counts.push(activeBackgroundCount);
        else if (kind === "root" && park === "idle") stop.abort();
      } },
      onEvent: () => {},
    });
    expect(durations).toEqual([7200, 180]);
    expect(result.kind).toBe(kind === "root" ? "aborted" : "completed");
    expect(counts).toEqual([1, 1]);
    expect(JSON.stringify(capturedMessages[1])).toContain("wait_expired");
    expect(JSON.stringify(capturedMessages[1])).toContain("<pending>1</pending>");
    expect(JSON.stringify(capturedMessages[2])).toContain("background_command_notification");
    expect(registry.awaitedTaskCount()).toBe(0);
    expect(registry.activeTaskCount()).toBe(1);
  });

  test.each(["root", "subagent", "workflow"] as const)("a %s loop that never waits gets one pending-work nudge, then the runtime waits the default four minutes without a notice to the person", async (kind) => {
    const inputSource = kind === "root" ? new ChatTurnMailbox() : new WorkflowInjectionQueue();
    const enqueueNotification = (text: string) => inputSource.enqueueRuntimeNotice(text);
    const registry = kind === "root"
      ? createBackgroundWorkRegistry({ kind: "chat", enqueueNotification })
      : createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification });
    const observers = inputSource instanceof WorkflowInjectionQueue && registry.kind === "workflow"
      ? createWorkflowLoopObservers({ parentChannel: true, injectionQueue: inputSource, backgroundTasks: registry, emit: () => {}, sessionId: kind })
      : undefined;
    registry.track({ done: new Promise<never>(() => {}), meta: { id: "pending-1", type: "subagent", description: "pending" } });
    const stop = new AbortController();
    const statusTurn = { events: [{ kind: "text_delta", text: "Still working.", blockKey: "status" }, { kind: "done", stopReason: "end_turn" }] } satisfies { events: ProviderStreamEvent[] };
    const { client, capturedMessages } = makeCaptureClient([statusTurn, statusTurn, statusTurn], {
      onRequest: () => { if (capturedMessages.length > 3) stop.abort(); },
    });
    const durations: number[] = [];
    const notices: string[] = [];
    const result = await runAgentLoop({
      client, tools: new RequestToolMap([["process", createProcessTool(registry)], ["handoff", createHandoffTool({ schema: SUBAGENT_HANDOFF_SCHEMA })]]),
      systemPrompt: stableSystemPrompt("test"), instruction: "work", executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: kind, promptCacheKey: kind, artifactScopeId: kind, retrievalSessionId: kind,
      seed: { kind: "fresh" }, persistence: { history: { append: () => {} } },
      background: createBackgroundExecutionOwner(registry), inputSource, signal: stop.signal,
      ...(kind === "root" ? {} : { handoff: { schema: SUBAGENT_HANDOFF_SCHEMA, onContent: () => {} } }),
      scheduleWaitExpiry: (seconds, expire) => {
        durations.push(seconds);
        queueMicrotask(durations.length === 1 ? expire : () => { stop.abort(); });
        return () => {};
      },
      lifecycle: { onTurnEnded: observers?.onTurnEnded },
      onSystemMessage: (message) => { notices.push(message); },
      onEvent: () => {},
    });
    expect(result.kind).toBe("aborted");
    expect(capturedMessages).toHaveLength(3);
    expect(JSON.stringify(capturedMessages[1])).toContain("Managed work is still pending");
    expect(JSON.stringify(capturedMessages[2])).toContain("wait_expired");
    expect(JSON.stringify(capturedMessages[2]).split("Managed work is still pending")).toHaveLength(2);
    expect(durations).toEqual([240, 240]);
    expect(notices).toEqual([]);
  });
});
