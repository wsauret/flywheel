import { describe, expect, jest, test } from "bun:test";
import type { SDKMessage, SDKTaskNotificationMessage, SDKTaskStartedMessage } from "@anthropic-ai/claude-agent-sdk";
import { Cause, Effect, Queue } from "effect";
import { classifyAnthropicError } from "../../../../../../src/orchestration/agent-runtime/llm/anthropic-adapter-helpers.js";
import { LlmStreamError, ProviderRequestValidationError, QuotaExhaustedError } from "../../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { AGENT_HOST_PLUGIN } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-gate.js";
import { openAgentHost } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host.js";
import { hostValues } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-registry.js";
import type { CliUserFrame, HostLaunch, LaunchedHost } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { queueIterable } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/queue-iterable.js";
import { temporaryDirectories } from "../../../../../helpers/directories.js";
import { apiErrorLine, assistantError, cliInit, ENVELOPE, includedReport, forwardDiagnostics, payloads, rateLimitReport, refused, responseBlock, sentBlock } from "../_bridge-harness.js";
import { silentVersions, type SilentVersions } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/stderr-signals.js";
import type { ExtraUsage, ExtraUsageStop } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/extra-usage-guard.js";
import { hostSessionFolder } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-file.js";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

forwardDiagnostics();
const directory = temporaryDirectories();

const COORDINATORS = [{ wireModelId: "claude-haiku-5-5", model: "claude-haiku-5-5" }, { wireModelId: "claude-sonnet-5-5", model: "claude-sonnet-5-5" }] as const;

/** A request of the host plugin's hook: the start of a turn, or a step that asks for admission. */
type HookRequest =
  | { readonly turnId: string; readonly text: string }
  | { readonly turnId: string; readonly index: number; readonly messageCount: number; readonly agentId: string | null };

const unused = (): never => { throw new Error("the host reads only whether its engine could not start"); };

/** One host on a fake engine. `emit` sends the engine's messages; `nextFrame` reads the user row id of the next
 *  dispatch frame; `openFrame` reads the next frame and opens its turn at the host's gate, as the engine's plugin
 *  does; `ask` sends the plugin's other hook requests. */
function fakeEngineHost(options: { readonly dispatcherStepDeadlineMs?: number; readonly recordBoundMs?: number; readonly silentVersions?: SilentVersions; readonly extraUsage?: ExtraUsage } = {}) {
  const messages = Effect.runSync(Queue.unbounded<SDKMessage, Error | Cause.Done>());
  let launch: HostLaunch | undefined;
  const quotaMarks: (number | undefined)[] = [];
  const usageStops: ExtraUsageStop[] = [];
  const configDir = directory("host-login-");
  // The host asks for the engine's next message only after it read every earlier one, so a request past the emitted
  // count tells the test that the host read them all.
  let emitted = 0;
  let asked = 0;
  let readAll = Promise.withResolvers<void>();
  const launchHost = (input: HostLaunch): LaunchedHost => {
    launch = input;
    const reader = queueIterable(messages)[Symbol.asyncIterator]();
    return {
      messages: { [Symbol.asyncIterator]: () => ({ next: () => {
        asked += 1;
        if (asked > emitted) readAll.resolve();
        return reader.next();
      } }) },
      process: { spawn: unused, exited: unused, running: unused, cannotStart: () => false, terminate: unused, close: unused },
      stopTask: async () => {},
      reloadPlugins: async () => {},
      rewind: () => Effect.succeed({ rewound: true }),
      stop: () => Effect.succeed({ interrupted: false, lockWaitMs: 0, lockTimedOut: false, terminated: true }),
      close: async () => { Effect.runSync(Queue.end(messages)); },
    };
  };
  const host = openAgentHost({
    launchHost, configDir, cwd: directory("host-cwd-"), coordinators: COORDINATORS,
    values: hostValues({ tools: [], wireModelId: "claude-opus-5-5", contextLimit: 200_000, thinking: { type: "adaptive" }, extraBody: {}, eagerInputStreaming: true, promptCaching: true, effort: "high" }),
    markQuotaExhausted: (resetsAtMs) => {
      quotaMarks.push(resetsAtMs);
      return { exhaustion: { exhaustedAtMs: 0, resetsAtMs: resetsAtMs ?? 300_000 }, newlyExhausted: true, reportedResetAtMs: resetsAtMs };
    },
    recordModelRefusal: () => {},
    extraUsage: "allow", reportsExtraUsage: true, onExtraUsageStop: (stop) => { usageStops.push(stop); }, recordUsage: () => {},
    silentVersions: silentVersions(),
    ...options,
  });
  const prompt: AsyncIterator<CliUserFrame> | undefined = launch?.prompt[Symbol.asyncIterator]();
  const nextFrame = async (): Promise<CliUserFrame | undefined> => {
    const next = await prompt?.next();
    return next?.done === false ? next.value : undefined;
  };
  const ask = async (path: "/turn" | "/step" | "/item", body: HookRequest | { readonly agentId: string; readonly item: unknown }) => {
    const response = await fetch(`http://localhost${path}`, { method: "POST", unix: launch?.gate.socketPath, body: JSON.stringify(body) });
    return response.json();
  };
  return {
    host, quotaMarks, usageStops, configDir, ask,
    /** The engine ends its output. */
    end: () => { Effect.runSync(Queue.end(messages)); },
    emit: (...sent: SDKMessage[]) => {
      for (const message of sent) Queue.offerUnsafe(messages, message);
      emitted += sent.length;
      if (asked <= emitted) readAll = Promise.withResolvers<void>();
    },
    /** Resolves once the host read every message that the engine sent. */
    read: () => readAll.promise,
    /** Writes lines of the engine's debug output. */
    stderr: (lines: readonly string[]) => { for (const line of lines) launch?.onStderrLine(line); },
    nextFrame: async () => (await nextFrame())?.uuid ?? "",
    openFrame: async (turnId: string) => {
      const frame = await nextFrame();
      const text = frame?.message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("") ?? "";
      await ask("/turn", { turnId, text });
      return frame?.uuid ?? "";
    },
  };
}

/** The engine's complete message of a dispatcher step. */
const dispatcherMessage = (id: string): SDKMessage => {
  const message = assistantError(undefined, "Sending.");
  return { ...message, message: { ...message.message, id } };
};

const noListener = { ended: () => {}, refused: () => {} };

async function closedRecord() {
  for (let tick = 0; tick < 50 && payloads("provider.claude_sdk.host.closed").length === 0; tick += 1) await Bun.sleep(1);
  return payloads("provider.claude_sdk.host.closed");
}

describe("the shared agent host", () => {
  test("fails closed when the engine sends an admitted agent's request without its agent header: the step fails as silent debug output, the host refuses its next step and closes, and a new host on that version closes when its engine names it", async () => {
    const versions = silentVersions();
    const { host, emit, ask, stderr } = fakeEngineHost({ recordBoundMs: 10, silentVersions: versions });
    const agentId = "a0000000000000001";
    emit(cliInit({ session_id: host.sessionId, claude_code_version: "2.1.999", plugins: [{ name: AGENT_HOST_PLUGIN, path: "/plugins/agent-host" }] }));
    await Bun.sleep(1);
    await host.admit(agentId, {}, { item: () => {}, done: () => {} });
    expect(await ask("/step", { turnId: "t", index: 0, messageCount: 1, agentId })).toMatchObject({ admit: true });
    stderr([
      ...sentBlock("log_1"), ...responseBlock("error", 404, { "request-id": "req_1" }, "log_1"),
      apiErrorLine(404, '{"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-5-5"},"request_id":"req_1"}'),
    ]);
    const failure = await host.requestFailure(agentId);
    expect(failure).toBeInstanceOf(ProviderRequestValidationError);
    expect(failure.message).toContain("The Claude engine 2.1.999");
    expect(payloads("provider.claude_sdk.debug_output.silent")).toEqual([{ sessionId: host.sessionId, cliVersion: "2.1.999", rule: "agent-header-missing" }]);
    // A chat bridge on the same version refuses to serve too.
    expect(versions.check({ sessionId: "chat", cliVersion: "2.1.999", admitted: 0, requestLines: [] })).toBe("2.1.999");
    await expect(host.admit(agentId, {}, { item: () => {}, done: () => {} })).rejects.toThrow(ProviderRequestValidationError);
    expect(await closedRecord()).toMatchObject([{ sessionId: host.sessionId, reason: "debug-output" }]);

    const next = fakeEngineHost({ silentVersions: versions });
    const dispatch = next.host.dispatch("a0000000000000002", noListener).then(() => undefined, (error: unknown) => error);
    next.emit(cliInit({ session_id: next.host.sessionId, claude_code_version: "2.1.999", plugins: [{ name: AGENT_HOST_PLUGIN, path: "/plugins/agent-host" }] }));
    expect(await dispatch).toBeInstanceOf(ProviderRequestValidationError);
    expect(await next.host.ended).toBeInstanceOf(ProviderRequestValidationError);
    expect(payloads("provider.claude_sdk.debug_output.silent")).toHaveLength(1);
    await Promise.all([host.close("lifetime-end"), next.host.close("lifetime-end")]);
  });

  test("a coordinator request refused for the login's spent usage marks the login's quota once, fails the frame's agents with the quota failure, demotes no coordinator, and closes the host", async () => {
    const { host, quotaMarks, emit, nextFrame } = fakeEngineHost();
    const dispatches = ["a0000000000000001", "a0000000000000002"].map((agentId) => host.dispatch(agentId, { ended: () => {}, refused: () => {} }).then(() => undefined, (error: unknown) => error));
    const settled = Promise.all(dispatches);
    const reset = 1_791_900_000;
    emit(cliInit({ session_id: host.sessionId, claude_code_version: "2.1.296", plugins: [{ name: AGENT_HOST_PLUGIN, path: "/plugins/agent-host" }] }));
    // The engine answers every coordinator request of the login with its weekly-limit refusal, whatever the model.
    for (;;) {
      const uuid = await Promise.race([nextFrame(), settled.then(() => undefined)]);
      if (uuid === undefined) break;
      const [report, result] = refused("rate_limit", 429, "You've hit your weekly limit · resets 1am (America/Los_Angeles)");
      emit(rateLimitReport({ status: "rejected", rateLimitType: "seven_day", resetsAt: reset }));
      emit(report, { ...result, user_message_uuid: uuid });
    }
    const failures = await settled;
    for (const failure of failures) expect(failure).toBeInstanceOf(QuotaExhaustedError);
    expect(quotaMarks).toEqual([reset * 1000]);
    expect(await host.ended).toBeInstanceOf(QuotaExhaustedError);
    expect(payloads("provider.claude_sdk.host.coordinator_demoted")).toEqual([]);
    expect(payloads("provider.claude_sdk.host.coordinator_exhausted")).toEqual([]);
    for (let tick = 0; tick < 20 && payloads("provider.claude_sdk.host.closed").length === 0; tick += 1) await Bun.sleep(1);
    expect(payloads("provider.claude_sdk.host.closed")).toMatchObject([{ sessionId: host.sessionId, reason: "quota" }]);
  });

  test("a task's end reaches its agent's listener once, and the host keeps no listener of an ended task, so its later close tells that agent nothing", async () => {
    const { host, emit, nextFrame } = fakeEngineHost();
    const agentId = "a0000000000000001";
    const ends: string[] = [];
    const dispatched = host.dispatch(agentId, { ended: (end) => { ends.push(end); }, refused: () => {} });
    await nextFrame();
    const started: SDKTaskStartedMessage = { type: "system", subtype: "task_started", task_id: agentId, description: "agent", ...ENVELOPE };
    const ended: SDKTaskNotificationMessage = { type: "system", subtype: "task_notification", task_id: agentId, status: "completed", output_file: "", summary: "", ...ENVELOPE };
    emit(started, ended);
    await dispatched;
    await host.settled(agentId);
    await host.close("lifetime-end");
    expect(ends).toEqual(["completed"]);
  });

  test.each([
    ["before its first step", 0, 0],
    ["before its first message", 1, 0],
    ["between its steps", 2, 1],
  ] as const)("a dispatcher that makes no progress %s within the deadline closes the host once as stalled and fails the waiting dispatch as transient", async (_position, admittedSteps, messages) => {
    const deadlineMs = 25;
    // The watchdog's clock is faked, so a slow runner cannot stretch a gap between two progresses past the deadline.
    jest.useFakeTimers();
    const { host, emit, read, ask, openFrame } = fakeEngineHost({ dispatcherStepDeadlineMs: deadlineMs });
    let failure: unknown;
    try {
      const dispatched = host.dispatch("a0000000000000001", noListener).then(() => undefined, (error: unknown) => error);
      emit(cliInit({ session_id: host.sessionId, plugins: [{ name: AGENT_HOST_PLUGIN, path: "/plugins/agent-host" }] }));
      await openFrame("frame");
      // Each progress comes within the deadline and the frame outlives it, so each one armed the watchdog again.
      jest.advanceTimersByTime(deadlineMs - 1);
      if (admittedSteps > 0) expect(await ask("/step", { turnId: "frame", index: 0, messageCount: 1, agentId: null })).toMatchObject({ admit: true });
      if (messages > 0) {
        jest.advanceTimersByTime(deadlineMs - 1);
        emit(dispatcherMessage("msg_step_0"));
        await read();
        jest.advanceTimersByTime(deadlineMs - 1);
        expect(await ask("/step", { turnId: "frame", index: 1, messageCount: 3, agentId: null })).toMatchObject({ admit: true });
      }
      jest.advanceTimersByTime(deadlineMs);
      failure = await dispatched;
    } finally {
      jest.useRealTimers();
    }
    if (!(failure instanceof LlmStreamError)) throw new Error("the dispatch did not fail as a stream error");
    expect(failure.kind).toBe("transient");
    expect(await host.ended).toBe(failure);
    expect(await closedRecord()).toMatchObject([{ sessionId: host.sessionId, reason: "dispatcher-stalled" }]);
    expect(payloads("provider.claude_sdk.host.dispatcher_stalled")).toEqual([{ sessionId: host.sessionId, agents: 1, admittedSteps, messages, deadlineMs }]);
  });

  test("a dispatcher turn that the engine ends with an error fails the frame's dispatch as transient, keeps the host, and leaves the gate no record of the frame", async () => {
    const { host, emit, ask, openFrame } = fakeEngineHost({ dispatcherStepDeadlineMs: 25 });
    const first = host.dispatch("a0000000000000001", noListener).then(() => undefined, (error: unknown) => error);
    emit(cliInit({ session_id: host.sessionId, plugins: [{ name: AGENT_HOST_PLUGIN, path: "/plugins/agent-host" }] }));
    const uuid = await openFrame("frame");
    await ask("/step", { turnId: "frame", index: 0, messageCount: 1, agentId: null });
    // The engine ends a response without bytes itself and reports the timeout.
    const [report, result] = refused("unknown", null, "API Error: Request timed out.");
    emit(report, { ...result, user_message_uuid: uuid });
    expect(classifyAnthropicError(await first)).toMatchObject({ kind: "transient" });
    // The ended frame's turn admits no more steps, and its watchdog no longer runs.
    expect(await ask("/step", { turnId: "frame", index: 1, messageCount: 3, agentId: null })).toEqual({ admit: false });
    await Bun.sleep(30);
    expect(payloads("provider.claude_sdk.host.dispatcher_stalled")).toEqual([]);
    // The host serves the next frame.
    const second = host.dispatch("a0000000000000002", noListener);
    await openFrame("next");
    emit({ type: "system", subtype: "task_started", task_id: "a0000000000000002", description: "agent", ...ENVELOPE } satisfies SDKTaskStartedMessage);
    await second;
    await host.close("lifetime-end");
    expect(payloads("provider.claude_sdk.host.closed")).toMatchObject([{ reason: "lifetime-end" }]);
  });
});

describe("the shared agent host's usage guard", () => {
  const PLUGIN = { plugins: [{ name: AGENT_HOST_PLUGIN, path: "/plugins/agent-host" }] };
  /** Admits one step of `agentId` and answers it with a complete response. */
  async function servedStep(engine: ReturnType<typeof fakeEngineHost>, agentId: string, index: number) {
    await engine.host.admit(agentId, {}, { item: () => {}, done: () => {} });
    expect(await engine.ask("/step", { turnId: "t", index, messageCount: index + 1, agentId })).toMatchObject({ admit: true });
    await engine.ask("/item", { agentId, item: { kind: "stop", stopReason: "tool_use", usage: null } });
  }

  test("with paid use off, an agent step after a complete response whose usage report the engine never sent stops the account once and tells the person", async () => {
    const engine = fakeEngineHost({ extraUsage: "refuse" });
    const agentId = "a0000000000000001";
    engine.emit(cliInit({ session_id: engine.host.sessionId, ...PLUGIN }));
    await servedStep(engine, agentId, 0);
    // The engine's output ends without the report that the response owes.
    engine.end();

    await expect(engine.host.admit(agentId, {}, { item: () => {}, done: () => {} })).rejects.toThrow("sent no usage report");
    expect(engine.usageStops).toMatchObject([{ evidence: "unreported" }]);
    await engine.host.close("lifetime-end");
  });

  /** Opens a dispatch frame whose first dispatcher step streams a response: the service answered with a success, and
   *  the engine sent the response's first content block. */
  async function streamingDispatcher(engine: ReturnType<typeof fakeEngineHost>) {
    void engine.host.dispatch("a0000000000000009", noListener).catch(() => undefined);
    await engine.openFrame("frame");
    expect(await engine.ask("/step", { turnId: "frame", index: 0, messageCount: 1, agentId: null })).toMatchObject({ admit: true });
    engine.stderr([...sentBlock("log_d1"), ...responseBlock("start", 200, { "request-id": "req_d1" }, "log_d1")]);
    engine.emit(dispatcherMessage("msg_step_0"));
    await Bun.sleep(1);
  }

  test("with paid use off, a dispatcher response that still streams owes no report: an agent step admitted meanwhile waits for nothing and stops nothing", async () => {
    const engine = fakeEngineHost({ extraUsage: "refuse" });
    engine.emit(cliInit({ session_id: engine.host.sessionId, ...PLUGIN }));
    await streamingDispatcher(engine);

    const admitted = engine.host.admit("a0000000000000001", {}, { item: () => {}, done: () => {} }).then(() => "admitted");
    expect(await Promise.race([admitted, Bun.sleep(25).then(() => "held")])).toBe("admitted");
    expect(engine.usageStops).toEqual([]);
    await engine.host.close("lifetime-end");
  });

  test("with paid use off, the dispatcher's next step after a complete response and every agent admission that waits with it share one settlement: a report of extra usage that arrives meanwhile refuses them all and stops the account once", async () => {
    const engine = fakeEngineHost({ extraUsage: "refuse" });
    engine.emit(cliInit({ session_id: engine.host.sessionId, ...PLUGIN }));
    await streamingDispatcher(engine);
    // The dispatcher asks for its next step only after its response ended, so the response's report is owed.
    const next = engine.ask("/step", { turnId: "frame", index: 1, messageCount: 3, agentId: null });
    await Bun.sleep(5);
    const admissions = ["a0000000000000001", "a0000000000000002"].map((agentId) => engine.host.admit(agentId, {}, { item: () => {}, done: () => {} }).then(() => undefined, (error: unknown) => error));
    engine.emit(rateLimitReport({ status: "allowed", resetsAt: 1_791_540_527, rateLimitType: "five_hour", overageStatus: "allowed", isUsingOverage: true }));

    expect(await next).toEqual({ admit: false });
    for (const failure of await Promise.all(admissions)) expect(failure).toBeInstanceOf(QuotaExhaustedError);
    expect(engine.usageStops).toMatchObject([{ evidence: "extra-usage" }]);
    expect(engine.quotaMarks).toHaveLength(1);
    expect(await closedRecord()).toMatchObject([{ reason: "extra-usage" }]);
  });

  test("with paid use off, agent admissions that wait at the same time for a report that never comes stop the account once", async () => {
    const engine = fakeEngineHost({ extraUsage: "refuse" });
    engine.emit(cliInit({ session_id: engine.host.sessionId, ...PLUGIN }));
    await servedStep(engine, "a0000000000000001", 0);
    const admissions = ["a0000000000000001", "a0000000000000002"].map((agentId) => engine.host.admit(agentId, {}, { item: () => {}, done: () => {} }).then(() => undefined, (error: unknown) => error));
    engine.end();

    for (const failure of await Promise.all(admissions)) expect(failure).toBeInstanceOf(QuotaExhaustedError);
    expect(engine.usageStops).toMatchObject([{ evidence: "unreported" }]);
    expect(engine.quotaMarks).toHaveLength(1);
  });

  test("with paid use off, an agent continues after its tool response once the engine reported included usage, and a later response that brings no new report stops nothing", async () => {
    const engine = fakeEngineHost({ extraUsage: "refuse" });
    const agentId = "a0000000000000001";
    engine.emit(cliInit({ session_id: engine.host.sessionId, ...PLUGIN }));
    await servedStep(engine, agentId, 0);
    engine.emit(includedReport);
    // The engine reports again only when its reading changes.
    await servedStep(engine, agentId, 1);
    await servedStep(engine, agentId, 2);

    expect(engine.usageStops).toEqual([]);
    expect(engine.quotaMarks).toEqual([]);
    await engine.host.close("lifetime-end");
    expect(payloads("provider.claude_sdk.host.closed")).toMatchObject([{ reason: "lifetime-end" }]);
  });
});

describe("the shared agent host's close", () => {
  test.skipIf(process.platform === "win32")("keeps the session's lock until the process ends when another holder keeps its folder, still records the close, and resolves", async () => {
    const engine = fakeEngineHost();
    engine.emit(cliInit({ session_id: engine.host.sessionId, plugins: [{ name: AGENT_HOST_PLUGIN, path: "/plugins/agent-host" }] }));
    const folder = hostSessionFolder(engine.host.folder);
    mkdirSync(folder, { recursive: true });
    // A folder whose parent refuses writes cannot be removed, as a Windows file that another process holds open.
    chmodSync(dirname(folder), 0o555);
    try {
      await engine.host.close("lifetime-end");
    } finally {
      chmodSync(dirname(folder), 0o755);
    }

    expect(payloads("provider.claude_sdk.host.closed")).toMatchObject([{ sessionId: engine.host.sessionId, reason: "lifetime-end", artifactsKept: true }]);
    // A sweep that finds the lock leaves the folder to this process's end.
    expect(existsSync(join(engine.configDir, "session-locks", `${engine.host.sessionId}.lock`))).toBe(true);
  });
});
