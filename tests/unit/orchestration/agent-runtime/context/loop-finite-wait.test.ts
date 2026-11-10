import { describe, expect, test } from "bun:test";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js";
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js";
import type { ConversationMessage, ProviderStreamEvent, ToolCall } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { RuntimeTool, ToolResult } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { AgentLoopTerminal, RestoredAgentWait } from "../../../../../src/orchestration/agent-runtime/agent-loop-types.js";
import { RunLifecycle } from "../../../../../src/orchestration/agent-runtime/run-lifecycle.js";
import { SILENT_REPLY_NUDGE } from "../../../../../src/orchestration/agent-runtime/reply-nudge.js";
import { createProcessTool, DEFAULT_WAIT_SECONDS } from "../../../../../src/orchestration/agent-runtime/tools/process.js";
import { createHandoffTool } from "../../../../../src/orchestration/agent-runtime/tools/handoff.js";
import { ChatTurnMailbox } from "../../../../../src/orchestration/chat/turn-mailbox.js";
import { WorkflowInjectionQueue } from "../../../../../src/orchestration/workflow-host/injection-queue.js";
import { createWorkflowLoopObservers } from "../../../../../src/orchestration/workflow-host/loop-observers.js";
import { SUBAGENT_HANDOFF_SCHEMA } from "../../../../../src/orchestration/modules/subagents/execution/prompts.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { assemblyPinned, RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { makeCaptureClient, withSessionNotes } from "./_loop-fixtures.js";

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
        restoredWait: { expiry: { seconds: 60, deadlineMs }, replyWaitIds: [] },
        ...(kind === "root" || scenario === "person_interrupt" ? { maintenance: scenario === "person_interrupt" ? { personWait: { turnEnd: "recorded" as const } } : {} } : {}),
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

  /** Runs a loop that restarts with `input` queued, the restored or
   *  continued wait `wait`, and one pending command, a service when
   *  `service`; returns its first park after a text answer and the expiries
   *  it armed. */
  async function restartedRun(kind: "root" | "workflow", wait: { readonly restoredWait?: RestoredAgentWait; readonly continuedWait?: RestoredAgentWait }, queue: (source: ChatTurnMailbox | WorkflowInjectionQueue) => void, service = false) {
    const inputSource = kind === "root" ? new ChatTurnMailbox() : new WorkflowInjectionQueue();
    const stop = new AbortController();
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => inputSource.enqueueRuntimeNotice(text) });
    registry.track({ done: new Promise<BackgroundWorkResult>(() => {}), ...(service ? { service: true } : {}), meta: { id: "pending", type: "background_command", description: "pending" } });
    queue(inputSource);
    const { client, capturedMessages } = makeCaptureClient([{ events: said("Noted.") }, { events: said("Still pending.") }]);
    const parks: { park: string; waitRequested: boolean }[] = [];
    const expiries: number[] = [];
    await runAgentLoop({
      client, tools: await assemblyPinned(new RequestToolMap()), systemPrompt: stableSystemPrompt("test"),
      instruction: "", executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: kind, promptCacheKey: kind, artifactScopeId: kind, retrievalSessionId: kind,
      seed: { kind: "resume", priorMessages: [{ kind: "user", origin: "system", content: "Interrupted by the runtime." }] },
      persistence: { history: { append: () => {} } },
      background: createBackgroundExecutionOwner(registry), inputSource, signal: stop.signal,
      lifecycle: {
        ...wait,
        ...(kind === "root" ? { maintenance: {} } : {}),
        onTurnParked: ({ park, waitRequested }) => { parks.push({ park, waitRequested }); stop.abort(); },
      },
      scheduleWaitExpiry: (seconds) => { expiries.push(seconds); return () => {}; },
      onEvent: () => {},
    });
    return { parks, expiries, requests: capturedMessages.length };
  }

  test.each((["root", "workflow"] as const).flatMap((kind) => (["session_message", "module_notice"] as const).map((input) => ({ kind, input }))))("a restored wait in a $kind loop outlives a queued $input that only re-drives the turn", async ({ kind, input }) => {
    const r = await restartedRun(kind, { restoredWait: { expiry: { seconds: 60, deadlineMs: Date.now() + 60_000 }, replyWaitIds: [] } }, (source) => {
      if (input === "module_notice") {
        if (source instanceof ChatTurnMailbox) source.enqueueSilentSystem("<skill_recommendation>runtime data</skill_recommendation>");
        else source.enqueue("<skill_recommendation>runtime data</skill_recommendation>", { silent: true });
      } else if (source instanceof ChatTurnMailbox) source.enqueueNextTurn({ text: "Unrelated note.", producer: peer("other") });
      else source.enqueueMessage({ text: "Unrelated note.", producer: peer("other") });
    });
    expect(r.requests).toBe(1);
    expect(r.parks[0]).toEqual({ park: "waiting_on_work", waitRequested: true });
    expect(r.expiries).toHaveLength(1);
    expect(r.expiries[0]).toBeCloseTo(60, 0);
  });

  // The input that owes the request is already in the restored history, so
  // nothing is queued; only the restore reader's evidence says the request is owed.
  test.each((["root", "workflow"] as const).map((kind) => ({ kind })))("a restored wait on a service in a $kind loop answers the input it owes, then parks waiting on the original deadline", async ({ kind }) => {
    const r = await restartedRun(kind, { restoredWait: { expiry: { seconds: 60, deadlineMs: Date.now() + 60_000 }, replyWaitIds: [], requestOwed: true } }, () => {}, true);
    expect(r.requests).toBe(1);
    expect(r.parks[0]).toEqual({ park: "waiting_on_work", waitRequested: true });
    expect(r.expiries).toHaveLength(1);
    expect(r.expiries[0]).toBeCloseTo(60, 0);
  });

  test("a restored wait that the owed input woke answers that input and opens no wait on a service", async () => {
    const r = await restartedRun("root", { restoredWait: { expiry: { seconds: 60, deadlineMs: Date.now() + 60_000 }, replyWaitIds: [], requestOwed: true, woken: true } }, () => {}, true);
    expect(r.requests).toBe(1);
    expect(r.parks[0]).toEqual({ park: "idle", waitRequested: false });
    expect(r.expiries).toEqual([]);
  });

  test.each([
    { resumer: "a planned successor", continues: true },
    { resumer: "a person", continues: false },
  ])("the Resume of $resumer after a cut in the middle of a turn keeps the turn's open wait only under continuation authority", async ({ continues }) => {
    const continuedWait = { expiry: { seconds: 60, deadlineMs: Date.now() + 60_000 }, replyWaitIds: [] };
    const r = await restartedRun("root", continues ? { continuedWait } : {}, (source) => { source.enqueueResume(); });
    // A person's Resume ended the wait, so the runtime's one pending-work
    // nudge answers first, and the park waits its own default duration.
    expect(r.requests).toBe(continues ? 1 : 2);
    expect(r.parks[0]).toEqual({ park: "waiting_on_work", waitRequested: true });
    expect(r.expiries).toHaveLength(1);
    expect(r.expiries[0]).toBeCloseTo(continues ? 60 : DEFAULT_WAIT_SECONDS, 0);
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
    expect(durations).toHaveLength(2);
    expect(durations[0]).toBeCloseTo(7200, 0);
    expect(durations[1]).toBeCloseTo(180, 0);
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
    expect(durations).toHaveLength(2);
    expect(durations[0]).toBeCloseTo(7200, 0);
    expect(durations[1]).toBeCloseTo(180, 0);
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
    expect(durations).toHaveLength(2);
    expect(durations[0]).toBeCloseTo(240, 0);
    expect(durations[1]).toBeCloseTo(240, 0);
    expect(notices).toEqual([]);
  });
});

type Events = ProviderStreamEvent[];
const call = (id: string, name: string, input: ToolCall["input"] = {}): ProviderStreamEvent => ({ kind: "tool_use", toolCall: { id, name, input } });
const said = (text: string): Events => [{ kind: "text_delta", text, blockKey: text }, { kind: "done", stopReason: "end_turn" }];
const batch = (...calls: ProviderStreamEvent[]): Events => [...calls, { kind: "done", stopReason: "tool_use" }];
const LAUNCH_WAIT = batch(call("launch-1", "launch"), call("wait-1", "process", { action: "wait", soft_timeout: 7200 }));
const WAIT = batch(call("wait-1", "process", { action: "wait", soft_timeout: 7200 }));
const ASK = batch(call("ask-1", "ask"));
const SAVE = batch(call("save-1", "checkpoint_replace", { section: "currentState", value: "watching CI" }));
const peer = (sessionId: string) => ({ kind: "session" as const, sessionId, conversationId: `${sessionId}-conversation`, toolUseId: `${sessionId}-call`, hop: 0 });

interface OpenWaitWorld {
  readonly mailbox: ChatTurnMailbox;
  /** Ends the background command at this index of the order of launch. */
  finish(index: number): void;
  answer(): void;
  interrupt(): void;
}

/** Runs a chat loop over real background work with one service already
 *  running. Each park runs the next arrival of `atParks`; the first park
 *  without one ends the run. `expire` names the armed expiries, by order,
 *  that fire at once. */
async function openWaitRun(input: {
  readonly responses: readonly Events[];
  readonly atParks: readonly ((world: OpenWaitWorld) => void)[];
  readonly humanFacing?: boolean;
  readonly seed?: ConversationMessage;
  readonly contextLimit?: number;
  readonly expire?: readonly number[];
}) {
  const mailbox = new ChatTurnMailbox();
  const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text, key) => mailbox.enqueueBackgroundNotification({ text, ...(key ? { key } : {}) }) });
  const commands: PromiseWithResolvers<BackgroundWorkResult>[] = [];
  const track = () => {
    const command = Promise.withResolvers<BackgroundWorkResult>();
    registry.track({ done: command.promise, service: true, kill: { run: () => { command.resolve({ status: "completed", content: "stopped" }); } }, meta: { id: `bash-bg-${commands.length}`, type: "background_command", description: "watch", notificationKey: `command:bash-bg-${commands.length}` } });
    commands.push(command);
  };
  track();
  const reply = Promise.withResolvers<BackgroundWorkResult>();
  const launch: RuntimeTool = {
    name: "launch", action: "shell_exec", description: "launch", inputSchema: { type: "object" }, isConcurrencySafe: true,
    execute: async (): Promise<ToolResult> => { track(); return { content: "Running in background.", outcome: "ok" }; },
  };
  const ask: RuntimeTool = {
    name: "ask", action: "shell_exec", description: "opens a reply wait", inputSchema: { type: "object" }, isConcurrencySafe: true,
    execute: async (_input, context): Promise<ToolResult> => {
      registry.track({ done: reply.promise, wait: true, meta: { id: "reply-wait:ask-1", type: "reply_wait", description: "Waiting on peer", toolUseId: context?.toolUseId ?? "ask-1", notificationKey: "reply-wait:ask-1" } });
      return { content: "Sent; waiting for the reply.", outcome: "ok" };
    },
  };
  const notes = withSessionNotes(new Map([["process", createProcessTool(registry)], ["launch", launch], ["ask", ask]]));
  const { client, capturedMessages } = makeCaptureClient([...input.responses, said("Woken."), said("Woken.")].map((events) => ({ events })), input.contextLimit === undefined ? {} : { contextLimit: input.contextLimit });
  const run = new RunLifecycle<AgentLoopTerminal>();
  const world: OpenWaitWorld = {
    mailbox,
    finish: (index) => { commands[index]?.resolve({ status: "completed", content: "exit 0" }); },
    // The reply-wait layer ends the wait without a notice, then the reply commits.
    answer: () => { reply.resolve({ status: "completed", content: "" }); queueMicrotask(() => { mailbox.enqueueNextTurn({ text: "Here is my answer.", producer: peer("peer") }); }); },
    interrupt: () => { run.interrupt(); },
  };
  const parks: { park: string; active: number; waitRequested: boolean; afterRequest: number }[] = [];
  const expiries: number[] = [];
  run.start((signal) => runAgentLoop({
    client, tools: notes.tools, checkpoint: notes.checkpoint, systemPrompt: stableSystemPrompt("test"),
    instruction: null, executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    providerSessionKey: "open-wait", promptCacheKey: "open-wait", artifactScopeId: "open-wait", retrievalSessionId: "open-wait",
    ...(input.humanFacing ? { humanFacing: true } : {}),
    seed: { kind: "resume", priorMessages: [input.seed ?? { kind: "user", content: "Watch CI.", origin: "human" }] },
    persistence: { history: { append: () => {} } },
    background: createBackgroundExecutionOwner(registry), inputSource: mailbox, signal, currentTurn: run,
    scheduleWaitExpiry: (seconds, expire) => {
      expiries.push(seconds);
      if (input.expire?.includes(expiries.length)) queueMicrotask(expire);
      return () => {};
    },
    lifecycle: {
      onTurnParked: ({ park, activeBackgroundCount, waitRequested }) => {
        parks.push({ park, active: activeBackgroundCount, waitRequested, afterRequest: capturedMessages.length });
        const arrive = input.atParks[parks.length - 1];
        queueMicrotask(() => { if (arrive) arrive(world); else run.abort({ kind: "aborted" }); });
      },
    },
    onEvent: () => {},
  }));
  await run.done;
  for (const command of commands) command.resolve({ status: "completed", content: "" });
  reply.resolve({ status: "completed", content: "" });
  const requests = capturedMessages.map((messages) => JSON.stringify(messages));
  return { parks, expiries, requests };
}

const WAITING = { park: "waiting_on_work", waitRequested: true };
const nudged = (request: string | undefined) => request?.includes(JSON.stringify(SILENT_REPLY_NUDGE)) === true;

describe("an open wait outlives every request that only re-drives the turn", () => {
  test("a background notification owes a reply, the agent launches a command and waits 7200 s with no text, the nudge draws a text reply: the turn parks waiting, and the completion continues the same turn", async () => {
    const r = await openWaitRun({
      humanFacing: true,
      seed: { kind: "user", content: "<background_command_notification>earlier ended</background_command_notification>", origin: "system", replyRequired: true },
      responses: [LAUNCH_WAIT, said("Watching CI; I will report when it settles.")],
      atParks: [(world) => { world.finish(1); }],
    });
    expect(nudged(r.requests[1])).toBe(true);
    expect(r.parks[0]).toMatchObject({ ...WAITING, active: 2, afterRequest: 2 });
    expect(r.expiries).toHaveLength(1);
    expect(r.expiries[0]).toBeCloseTo(7200, 0);
    // The completion wakes the waiting park, so it continues the turn
    // instead of opening one from an idle park.
    expect(r.requests[2]).toContain("background_command_notification");
  });

  test("a nudged reply that calls a tool without a wait keeps the wait to the turn's end", async () => {
    const r = await openWaitRun({
      humanFacing: true,
      responses: [LAUNCH_WAIT, [{ kind: "text_delta", text: "Checking once more.", blockKey: "check" }, call("list-1", "process", { action: "list" }), { kind: "done", stopReason: "tool_use" }], said("Still running.")],
      atParks: [],
    });
    expect(nudged(r.requests[1])).toBe(true);
    expect(r.parks[0]).toMatchObject({ ...WAITING, afterRequest: 3 });
    expect(r.expiries[0]).toBeCloseTo(7200, 0);
  });

  test("a nudge that lands past the automatic compaction threshold saves, compacts, and still parks on the wait", async () => {
    const r = await openWaitRun({
      humanFacing: true, contextLimit: 10_000,
      // The seed keeps the first request under the proactive trigger and puts the nudged request over it, so a change in the tool text moves both.
      seed: { kind: "user", content: `Watch CI.${"y".repeat(28_000)}`, origin: "human" },
      responses: [LAUNCH_WAIT, SAVE, said("Watching CI.")],
      atParks: [],
    });
    expect(r.requests[1]).toContain("Save the checkpoint now:");
    expect(r.parks[0]).toMatchObject({ ...WAITING, afterRequest: 3 });
    expect(r.expiries).toHaveLength(1);
    expect(r.expiries[0]).toBeCloseTo(7200, 0);
  });

  test("a repetition notice after the third identical wait batch keeps the wait that batch opened", async () => {
    const r = await openWaitRun({
      responses: [LAUNCH_WAIT, LAUNCH_WAIT, LAUNCH_WAIT, said("Still waiting.")],
      atParks: [(world) => { world.finish(1); }, (world) => { world.finish(2); }],
    });
    expect(r.requests[3]).toContain("repetition_notice");
    expect(r.parks.slice(0, 3)).toMatchObject([WAITING, WAITING, { ...WAITING, afterRequest: 4 }]);
    expect(r.expiries).toHaveLength(3);
    expect(r.expiries[2]).toBeCloseTo(7200, 0);
  });

  test.each([
    { arrival: "a person's /compact", responses: [WAIT, SAVE, said("Compacted; still waiting.")], arrive: (world: OpenWaitWorld) => { world.mailbox.enqueueCompact(); } },
    { arrival: "a module observer's notice", responses: [WAIT, said("Noted.")], arrive: (world: OpenWaitWorld) => { world.mailbox.enqueueSilentSystem("<skill_recommendation>runtime data</skill_recommendation>"); } },
    { arrival: "a message from another session that is not an awaited reply", responses: [WAIT, said("Noted.")], arrive: (world: OpenWaitWorld) => { world.mailbox.enqueueNextTurn({ text: "Unrelated note.", producer: peer("other") }); } },
  ])("$arrival at a waiting park keeps the wait and arms the rest of its deadline", async ({ responses, arrive }) => {
    const r = await openWaitRun({ responses, atParks: [arrive] });
    expect(r.parks.slice(0, 2)).toMatchObject([{ ...WAITING, active: 1, afterRequest: 1 }, { ...WAITING, active: 1 }]);
    expect(r.expiries).toHaveLength(2);
    expect(r.expiries[1]).toBeLessThanOrEqual(r.expiries[0]!);
    expect(r.expiries[1]).toBeCloseTo(7200, 0);
  });
});

describe("what ends an open wait", () => {
  const IDLE = { park: "idle", waitRequested: false };
  test.each([
    // A reply wait has no deadline, so it arms no expiry.
    { ending: "the awaited reply of a held reply wait", responses: [ASK, said("Thanks.")], arrive: (world: OpenWaitWorld) => { world.answer(); }, armed: 0 },
    { ending: "a person's message", responses: [WAIT, said("Going well.")], arrive: (world: OpenWaitWorld) => { world.mailbox.enqueueNextTurn("How is it going?"); }, armed: 1 },
    { ending: "a person's Resume", responses: [WAIT, said("Continuing.")], arrive: (world: OpenWaitWorld) => { world.mailbox.enqueueResume(); }, armed: 1 },
    { ending: "a background notification while other work still runs", responses: [LAUNCH_WAIT, said("One ended.")], arrive: (world: OpenWaitWorld) => { world.finish(1); }, armed: 1 },
  ])("$ending wakes the wait, and the text reply after it parks idle", async ({ responses, arrive, armed }) => {
    const r = await openWaitRun({ responses, atParks: [arrive] });
    expect(r.parks[0]).toMatchObject(WAITING);
    expect(r.parks[1]).toMatchObject({ ...IDLE, afterRequest: 2 });
    expect(r.expiries).toHaveLength(armed);
  });

  test("expiry ends it: the reply to the expiry notice parks idle and arms nothing", async () => {
    const r = await openWaitRun({ responses: [WAIT, said("Still running.")], atParks: [() => {}], expire: [1] });
    expect(r.requests[1]).toContain("wait_expired");
    expect(r.parks[0]).toMatchObject(WAITING);
    expect(r.parks[1]).toMatchObject({ ...IDLE, afterRequest: 2 });
    expect(r.expiries).toHaveLength(1);
  });

  test("an interrupt ends it: the interrupted park reports no open wait", async () => {
    const r = await openWaitRun({ responses: [WAIT], atParks: [(world) => { world.interrupt(); }] });
    expect(r.parks[0]).toMatchObject(WAITING);
    expect(r.parks[1]).toMatchObject({ park: "interrupted", waitRequested: false, afterRequest: 1 });
  });

  test("a new wait call supersedes it with its own duration", async () => {
    const r = await openWaitRun({
      responses: [WAIT, batch(call("wait-2", "process", { action: "wait", soft_timeout: 180 })), said("Noted.")],
      atParks: [(world) => { world.mailbox.enqueueSilentSystem("<skill_recommendation>runtime data</skill_recommendation>"); }],
    });
    expect(r.parks.slice(0, 2)).toMatchObject([WAITING, WAITING]);
    expect(r.expiries[1]).toBeCloseTo(180, 0);
  });

  test("no waitable work left ends it: after the agent stops the work it waited on, the turn parks idle and arms nothing", async () => {
    const r = await openWaitRun({
      responses: [WAIT, batch(call("stop-0", "process", { action: "stop", process_id: "bash-bg-0" })), said("Stopped the watch.")],
      atParks: [(world) => { world.mailbox.enqueueSilentSystem("<skill_recommendation>runtime data</skill_recommendation>"); }],
    });
    expect(r.parks[0]).toMatchObject(WAITING);
    expect(r.parks[1]).toMatchObject({ ...IDLE, active: 0, afterRequest: 3 });
    expect(r.expiries).toHaveLength(1);
  });
});
