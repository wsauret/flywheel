/**
 * The shared agent host on a fake host: the production Agent SDK client of hosted agents, the bundled engine, and a
 * local Anthropic host with a placeholder login. Each case drives conversations as the agent loop does: it adds the
 * client's appends and request entries to history before each request and stores each answer as the loop does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { agentFilePath } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/agent-file.js";
import type { LaunchedHost } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { AGENT_APPENDIX, AGENT_IDENTITY, conversationTierEntry, DISPATCH_TEXT, ENGINE_INSTRUCTIONS } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/engine-text.js";
import { createHostRegistry, type HostRegistry } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-registry.js";
import { createHostLauncher, describeCliLogin } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { engineShell } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/engine-environment.js";
import { cliLaunch } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-launch.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../../src/infra/process-supervisor.js";
import { SYSTEM_PROMPT_SEPARATOR } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { canonicalShell, parseClaudeReminder } from "../../../../../src/orchestration/agent-runtime/llm/claude-reminders.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { agentLoop, dispatchedIds, effortOf, hiddenRequests, hostScript, isDispatcher, lastUserTexts, LOOKUP, lookupThenAnswer, registryProxy, SYSTEM, systemTexts, textOf, TREE, wireMessages, type WireBlock } from "./_agent-host.js";
import { captureDiagnostics, onFakeHost, removeEngineProbes, streamedText, streamedToolCalls, until, type StagedSdkClient, type StreamResult } from "./_claude-sdk-client.js";
import { declaredTools, type FakeReply, type RecordedRequest } from "./_fake-host.js";

const temporary = temporaryDirectories();
removeEngineProbes();
const diagnostics = captureDiagnostics();

let registry: HostRegistry;
afterEach(async () => { await registry.drain(); });
const agentHosts = registryProxy(() => registry);

/** The fields of an agent file row that the cases read: the type and tool name of each block of its message. */
const AgentFileRow = Schema.Struct({
  message: Schema.optionalKey(Schema.Struct({ content: Schema.Union([Schema.String, Schema.Array(Schema.Struct({ type: Schema.String, name: Schema.optionalKey(Schema.String) }))]) })),
});

describe("the shared agent host on a fake host", () => {
  test("a hosted agent starts by a dispatch, extends its turn through its tool calls, and resumes under its id on a steer", async () => {
    registry = createHostRegistry();
    await onFakeHost(temporary, hostScript(lookupThenAnswer), async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const first = await agent.request();
      expect(first.error).toBeUndefined();
      const [call] = streamedToolCalls(first);
      expect(call?.name).toBe("lookup");
      agent.result(call?.id ?? "", "VALUE");
      const second = await agent.request();
      expect(second.error).toBeUndefined();
      expect(streamedText(second)).toBe("The value is ready.");
      agent.history.push({ kind: "user", origin: "human", content: "Say it again." });
      const third = await agent.request();
      expect(third.error).toBeUndefined();

      const agentRequests = host.requests.filter((request) => !isDispatcher(request));
      expect(agentRequests).toHaveLength(3);
      const system = systemTexts;
      expect(system(agentRequests[0]!)[1]).toBe(AGENT_IDENTITY);
      expect(system(agentRequests[0]!)[2]?.endsWith(AGENT_APPENDIX)).toBe(true);
      expect(lastUserTexts(agentRequests[0]!).at(-1)).toBe(DISPATCH_TEXT);
      // The tool round extended the turn: no dispatch wrapper and no second start.
      expect(lastUserTexts(agentRequests[1]!)).not.toContain(DISPATCH_TEXT);
      expect(lastUserTexts(agentRequests[2]!).at(-1)).toBe(DISPATCH_TEXT);
      // Canonical history records the engine's text once and one wrapper for each dispatch.
      const entries = agent.history.filter((message) => message.kind === "user" && message.origin === "system").map(textOf);
      expect(entries.filter((text) => text === ENGINE_INSTRUCTIONS)).toHaveLength(1);
      expect(entries.filter((text) => text === DISPATCH_TEXT)).toHaveLength(2);
      // The thinking of each answer keeps the service's signature, so a resume sends it back as it came.
      const answers = agent.history.filter((message) => message.kind === "assistant");
      const signatures = answers.flatMap((message) => message.kind === "assistant" && typeof message.content !== "string" ? message.content.flatMap((block) => block.type === "thinking" ? [block.signature] : []) : []);
      expect(signatures.length).toBeGreaterThan(0);
      expect(signatures.every((signature) => signature?.startsWith("fake-signature-") === true)).toBe(true);
      // The steer resumed the same agent from its file: the earlier turn is in its request, in the same order.
      expect(wireMessages(agentRequests[2]!).length).toBeGreaterThan(wireMessages(agentRequests[1]!).length);
      expect(new Set(host.requests.map((request) => request.sessionId)).size).toBe(1);
    }, { seams: { agentHosts } });
  }, 120_000);

  test("parallel agents of one tree share one engine process, a cancel ends only its agent, and the end of a parked agent's lifetime is no failure", async () => {
    registry = createHostRegistry();
    let launches = 0;
    const slow = (request: RecordedRequest): FakeReply => lastUserTexts(request).some((text) => text.startsWith("Hang")) ? { blocks: [{ text: "partial" }], open: true } : lookupThenAnswer(request);
    await onFakeHost(temporary, hostScript(slow), async ({ host, stage, projectRoot }) => {
      const clients = await Promise.all(Array.from({ length: 8 }, () => stage({ sharedHost: TREE })));
      const agents = clients.map((client, index) => agentLoop(client, projectRoot, `Task ${index}.`));
      const hanging = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Hang.");
      const cancel = new AbortController();
      const [cancelled, ...firsts] = await Promise.all([
        hanging.request(cancel.signal, (event) => { if (event.kind === "text_delta") cancel.abort(new Error("cancelled by the test")); }),
        ...agents.map((agent) => agent.request()),
      ]);
      expect(cancelled?.error?.message).toBe("cancelled by the test");
      expect(firsts.map((result) => result.error)).toEqual(firsts.map(() => undefined));
      // Half of the agents end at their tool call, as an agent ends at its handoff: no result reaches the call.
      const answering = agents.slice(0, 4);
      for (const [index, agent] of answering.entries()) agent.result(streamedToolCalls(firsts[index]!)[0]?.id ?? "", `VALUE ${index}`);
      const seconds = await Promise.all(answering.map((agent) => agent.request()));
      expect(seconds.map(streamedText)).toEqual(answering.map(() => "The value is ready."));
      // A person stops one agent while it waits on its tool call.
      await clients[4]!.stop();
      expect(launches).toBe(1);
      expect(new Set(host.requests.map((request) => request.sessionId)).size).toBe(1);
    }, { seams: { agentHosts, createHostLauncher: (config) => { const launch = createHostLauncher(config); return (input) => { launches += 1; return launch(input); }; } } });
    // The cancel stops its task with the abort's reason, and the stop of the agent that waits on its tool names the
    // abort with no failure. The agents that answered ended their own tasks, and the end of each other parked agent's
    // lifetime stops its task with no failure. Each stop has one record.
    const parkedEnd = { path: "running", cause: "lifetime-end", reason: undefined };
    expect(diagnostics.payloads("provider.claude_sdk.host.task_stopped").map(({ path, cause, reason }) => ({ path, cause, reason }))).toEqual([
      { path: "running", cause: "abort", reason: "Error" }, { path: "running", cause: "abort", reason: undefined }, parkedEnd, parkedEnd, parkedEnd,
    ]);
    expect(diagnostics.payloads("provider.claude_sdk.host.agent_ended")).toEqual([]);
  }, 180_000);
});

describe("the shared agent host's own decisions", () => {
  test("siblings with different conversation tiers send byte-identical system blocks, and each one's first message holds its own tier", async () => {
    registry = createHostRegistry();
    await onFakeHost(temporary, hostScript(() => ({ blocks: [{ thinking: "Done." }, { text: "Done." }] })), async ({ host, stage, projectRoot }) => {
      const tiers = ["# Session identity\n\nYou are session one.", "# Session identity\n\nYou are session two."];
      const agents = await Promise.all(tiers.map(async (conversation, index) => agentLoop(await stage({ sharedHost: TREE }), projectRoot, `Report ${index}.`, { ...SYSTEM, conversation })));
      const results = await Promise.all(agents.map((agent) => agent.request()));
      expect(results.map((result) => result.error)).toEqual([undefined, undefined]);
      const sent = host.requests.filter((request) => !isDispatcher(request));
      expect(sent).toHaveLength(2);
      // Block 0 is the engine's billing header, whose suffix the engine derives from each conversation's own text.
      const shared = (request: RecordedRequest) => { const blocks = request.body["system"]; return JSON.stringify(Array.isArray(blocks) ? blocks.slice(1) : blocks); };
      expect(shared(sent[0]!)).toBe(shared(sent[1]!));
      for (const [index, tier] of tiers.entries()) {
        const request = sent.find((candidate) => lastUserTexts(candidate).some((text) => text.startsWith(`Report ${index}.`)));
        if (request === undefined) throw new Error(`no request of agent ${index}`);
        const first = wireMessages(request)[0];
        const texts = first === undefined || typeof first.content === "string" ? [] : first.content.flatMap((block) => block.text === undefined ? [] : [block.text.trimEnd()]);
        expect(texts).toContain(conversationTierEntry(tier));
        expect(systemTexts(request).some((text) => text.includes(tier))).toBe(false);
        // History records the entry with the bytes that the model reads.
        expect(agents[index]!.history.some((message) => textOf(message) === conversationTierEntry(tier))).toBe(true);
      }
    }, { seams: { agentHosts } });
  }, 120_000);

  test("a result that the engine rewrites by a fixed rule extends the agent's turn, and the record names the rewrite", async () => {
    const cases: readonly { readonly content: readonly { type: "text"; text: string }[]; readonly isError?: true; readonly sent: string; readonly rewrite?: string }[] = [
      { content: [{ type: "text", text: "Error: no key named k." }], isError: true, sent: "Error: no key named k." },
      { content: [{ type: "text", text: "Error: no key" }, { type: "text", text: "named k.\n" }], isError: true, sent: "Error: no key\nnamed k.", rewrite: "error-joined" },
      { content: [], sent: "(mcp__runtime__lookup completed with no output)", rewrite: "no-output" },
    ];
    for (const { content, isError, sent, rewrite } of cases) {
      registry = createHostRegistry();
      await onFakeHost(temporary, hostScript(lookupThenAnswer), async ({ host, stage, projectRoot }) => {
        const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
        const [call] = streamedToolCalls(await agent.request());
        agent.history.push({ kind: "toolResult", toolUseId: call?.id ?? "", content: [...content], ...(isError ? { isError } : {}) });
        const second = await agent.request();
        expect(second.error).toBeUndefined();
        const agentRequests = host.requests.filter((request) => !isDispatcher(request));
        expect(agentRequests).toHaveLength(2);
        expect(host.requests.filter(isDispatcher)).toHaveLength(2);
        const last = wireMessages(agentRequests[1]!).at(-1);
        const result = typeof last?.content === "string" ? undefined : last?.content.find((block) => block.type === "tool_result");
        expect(result?.is_error).toBe(isError);
        const text = typeof result?.content === "string" ? result.content : Array.isArray(result?.content) ? result.content.map((block: WireBlock) => block.text).join("") : undefined;
        expect(text).toBe(sent);
        const recorded = second.events.flatMap((event) => event.kind === "transport_context" ? event.context.additions.filter(({ kind }) => kind.startsWith("tool-result:")) : []);
        expect(recorded).toEqual(rewrite === undefined ? [] : [{ part: "message", kind: `tool-result:${rewrite}`, at: 2, value: call?.id ?? "" }]);
      }, { seams: { agentHosts } });
      await registry.drain();
    }
  }, 180_000);

  test("a stop while the dispatcher answers ends the request at once, and the agent never sends a request", async () => {
    registry = createHostRegistry();
    let dispatcherAsked = false;
    await onFakeHost(temporary, (request, index) => {
      if (isDispatcher(request)) {
        dispatcherAsked = true;
        return { blocks: [{ text: "thinking about it" }], open: true };
      }
      return hostScript(lookupThenAnswer)(request, index);
    }, async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const stop = new AbortController();
      const pending = agent.request(stop.signal);
      await until(() => dispatcherAsked, "the dispatcher's request");
      stop.abort(new Error("stopped by the test"));
      const result = await pending;
      expect(result.error?.message).toBe("stopped by the test");
      await Bun.sleep(500);
      expect(host.requests.filter((request) => !isDispatcher(request))).toHaveLength(0);
    }, { seams: { agentHosts } });
  }, 120_000);

  test("the close of a host while an agent streams fails the agent's request, and its one record is the host's close", async () => {
    registry = createHostRegistry();
    let engineStops = 0;
    const createCountingLauncher = (config: Parameters<typeof createHostLauncher>[0]) => {
      const launch = createHostLauncher(config);
      return (input: Parameters<ReturnType<typeof createHostLauncher>>[0]): LaunchedHost => {
        const launched = launch(input);
        return { ...launched, stopTask: (agentId) => { engineStops += 1; return launched.stopTask(agentId); } };
      };
    };
    await onFakeHost(temporary, hostScript(() => ({ blocks: [{ text: "partial" }], open: true })), async ({ stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Hang.");
      const result = await agent.request(undefined, (event) => { if (event.kind === "text_delta") void registry.drain(); });
      expect(result.error).toBeDefined();
      await until(() => diagnostics.payloads("provider.claude_sdk.host.closed").length === 1, "the host's close");
    }, { seams: { agentHosts, createHostLauncher: createCountingLauncher } });
    expect(diagnostics.payloads("provider.claude_sdk.host.task_stopped")).toEqual([]);
    expect(engineStops).toBe(0);
  }, 120_000);

  test("a dispatcher message whose text the dispatcher changed is denied, so the agent never reads it, and the dispatch fails after its tries", async () => {
    registry = createHostRegistry();
    await onFakeHost(temporary, (request, index) => {
      if (!isDispatcher(request)) return lookupThenAnswer(request);
      const reply = hostScript(lookupThenAnswer)(request, index);
      return { blocks: reply.blocks.map((block) => "tool" in block && typeof block.input === "object" && block.input !== null ? { ...block, input: { ...block.input, message: "Go." } } : block) };
    }, async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const result = await agent.request();
      expect(result.error?.message).toContain("did not start the agent");
      expect(diagnostics.payloads("provider.claude_sdk.host.dispatch_denied").map(({ fault }) => fault)).toEqual(["changed", "changed", "changed"]);
      await Bun.sleep(1_000);
      expect(host.requests.filter((request) => !isDispatcher(request))).toHaveLength(0);
    }, { seams: { agentHosts } });
  }, 120_000);

  test("a dispatcher that repeats a denied message on every step sends three requests a frame, the dispatch fails after its tries, and the host starts the next agent", async () => {
    registry = createHostRegistry();
    let repeating = true;
    await onFakeHost(temporary, (request, index) => {
      if (!isDispatcher(request) || !repeating) return hostScript(lookupThenAnswer)(request, index);
      const to = JSON.stringify(request.body).match(/agents: (a[0-9a-f]{16})/u)?.[1];
      return { blocks: [{ tool: "SendMessage", input: { to, message: "Go." } }] };
    }, async ({ host, stage, projectRoot }) => {
      const first = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const failed = await first.request();
      expect(failed.error?.message).toContain("did not start the agent");
      expect(host.requests.filter(isDispatcher)).toHaveLength(9);
      expect(diagnostics.payloads("provider.claude_sdk.host.dispatch_denied")).toHaveLength(9);
      expect(diagnostics.payloads("provider.claude_sdk.host.delivery_missed")).toHaveLength(2);
      expect(host.requests.filter((request) => !isDispatcher(request))).toHaveLength(0);
      repeating = false;
      const next = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      expect(streamedToolCalls(await next.request())).toHaveLength(1);
      expect(host.requests.filter((request) => !isDispatcher(request))).toHaveLength(1);
      expect(diagnostics.payloads("provider.claude_sdk.host.closed")).toEqual([]);
    }, { seams: { agentHosts } });
  }, 180_000);

  test("the plugin drops an agent's completion notice before the dispatcher's model could read it", async () => {
    registry = createHostRegistry();
    await onFakeHost(temporary, hostScript(() => ({ blocks: [{ text: "Done." }] })), async ({ host, stage, projectRoot }) => {
      const agents = await Promise.all(Array.from({ length: 3 }, async (_, index) => agentLoop(await stage({ sharedHost: TREE }), projectRoot, `Task ${index}.`)));
      for (const agent of agents) expect((await agent.request()).error).toBeUndefined();
      // Each agent completed before the next dispatch, so the engine had a notice for each one to offer.
      const dispatcher = host.requests.filter(isDispatcher);
      expect(dispatcher.length).toBe(6);
      expect(dispatcher.some((request) => JSON.stringify(request.body["messages"]).includes("task-notification"))).toBe(false);
    }, { seams: { agentHosts } });
  }, 120_000);
});

describe("the shared agent host's history and records", () => {
  test("a compaction rewrite starts the agent again from the compacted history, with the engine's text once per context", async () => {
    registry = createHostRegistry();
    await onFakeHost(temporary, hostScript(lookupThenAnswer), async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const [call] = streamedToolCalls(await agent.request());
      agent.result(call?.id ?? "", "VALUE");
      expect((await agent.request()).error).toBeUndefined();
      // The compaction replaces the history with the brief and its summary; a new input follows.
      agent.history.splice(0, agent.history.length, { kind: "user", origin: "human", content: "Find the value." }, { kind: "assistant", content: [{ type: "text", text: "Summary: the value is VALUE." }] }, { kind: "user", origin: "human", content: "Say it again." });
      const resumed = await agent.request();
      expect(resumed.error).toBeUndefined();
      const entries = agent.history.filter((message) => message.kind === "user" && message.origin === "system").map(textOf);
      expect(entries.filter((text) => text === ENGINE_INSTRUCTIONS)).toHaveLength(1);
      expect(entries.filter((text) => text === DISPATCH_TEXT)).toHaveLength(1);
      const sent = host.requests.filter((request) => !isDispatcher(request)).at(-1);
      if (sent === undefined) throw new Error("no agent request");
      expect(lastUserTexts(sent).at(-1)).toBe(DISPATCH_TEXT);
      expect(systemTexts(sent)[1]).toBe(AGENT_IDENTITY);
      // The entries that the compaction removed reach the model no more.
      expect(JSON.stringify(wireMessages(sent))).not.toContain("tool_use");
      expect(JSON.stringify(wireMessages(sent))).toContain("Summary: the value is VALUE.");
      expect(new Set(host.requests.map((request) => request.sessionId)).size).toBe(1);
      expect(new Set(dispatchedIds(host.requests)).size).toBe(2);
    }, { seams: { agentHosts } });
  }, 120_000);

  test("a parked agent whose next request changes its tools starts on the host of its new tools in one attempt, from its history with Flywheel's tool ids", async () => {
    registry = createHostRegistry();
    let launches = 0;
    await onFakeHost(temporary, hostScript(lookupThenAnswer), async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const [call] = streamedToolCalls(await agent.request());
      agent.result(call?.id ?? "", "VALUE");
      agent.tools = [LOOKUP, { name: "extra", description: "Does more.", input_schema: { type: "object", properties: {} } }];
      const moved = await agent.request();
      expect(moved.error).toBeUndefined();
      expect(streamedText(moved)).toBe("The value is ready.");
      expect(launches).toBe(2);
      const sent = host.requests.filter((request) => !isDispatcher(request)).at(-1);
      if (sent === undefined) throw new Error("no agent request");
      expect(lastUserTexts(sent).at(-1)).toBe(DISPATCH_TEXT);
      const blocks = wireMessages(sent).flatMap((message) => typeof message.content === "string" ? [] : message.content);
      expect(blocks.some((block) => block.type === "tool_use" && JSON.stringify(block).includes(call?.id ?? "?"))).toBe(true);
      expect(blocks.some((block) => block.type === "tool_result" && block.tool_use_id === call?.id)).toBe(true);
      expect(diagnostics.payloads("provider.claude_sdk.host.agent_dispatched").map(({ moved: hostMoved }) => hostMoved)).toEqual([false, true]);
    }, { seams: { agentHosts, createHostLauncher: (config) => { const launch = createHostLauncher(config); return (input) => { launches += 1; return launch(input); }; } } });
  }, 120_000);

  test("a parked agent whose next request crosses a mask zone starts again with the wrapper on its first attempt", async () => {
    registry = createHostRegistry();
    const lookups = (request: RecordedRequest): FakeReply => {
      const results = wireMessages(request).flatMap((message) => typeof message.content === "string" ? [] : message.content.filter((block) => block.type === "tool_result")).length;
      return results < 2 ? { blocks: [{ thinking: "I need a value." }, { tool: "lookup", input: { key: `k${results}` } }] } : { blocks: [{ thinking: "Done." }, { text: "Both values are ready." }] };
    };
    await onFakeHost(temporary, hostScript(lookups), async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find two values.");
      const [first] = streamedToolCalls(await agent.request());
      agent.result(first?.id ?? "", "VALUE ONE");
      const [second] = streamedToolCalls(await agent.request());
      agent.result(second?.id ?? "", "VALUE TWO");
      // The loop's mask zone now shortens the first result, so the agent's copy is no prefix of the request.
      agent.outbound = (messages) => messages.map((message) => message.kind === "toolResult" && message.toolUseId === first?.id ? { ...message, content: [{ type: "text", text: "[masked]" }] } : message);
      const masked = await agent.request();
      expect(masked.error).toBeUndefined();
      expect(streamedText(masked)).toBe("Both values are ready.");
      const sent = host.requests.filter((request) => !isDispatcher(request));
      expect(sent).toHaveLength(3);
      expect(lastUserTexts(sent[2]!).at(-1)).toBe(DISPATCH_TEXT);
      expect(diagnostics.payloads("provider.claude_sdk.host.agent_dispatched").map(({ trigger }) => trigger)).toEqual(["first-request", "history"]);
      expect(agent.history.filter((message) => textOf(message) === DISPATCH_TEXT)).toHaveLength(2);
    }, { seams: { agentHosts } });
  }, 120_000);

  test("the dispatcher declares only SendMessage, runs on the cheap model, and each of its requests is recorded once by a later record", async () => {
    registry = createHostRegistry();
    await onFakeHost(temporary, hostScript(lookupThenAnswer), async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const first = await agent.request();
      const [call] = streamedToolCalls(first);
      agent.result(call?.id ?? "", "VALUE");
      const second = await agent.request();
      const dispatcher = host.requests.filter(isDispatcher);
      expect(dispatcher.map((request) => declaredTools(request.body))).toEqual(dispatcher.map(() => ["SendMessage"]));
      expect(dispatcher.map((request) => request.body["model"])).toEqual(dispatcher.map(() => "claude-haiku-5-5"));
      expect(host.requests.filter((request) => !isDispatcher(request)).map((request) => request.body["model"])).toEqual(["claude-sonnet-5-5", "claude-sonnet-5-5"]);
      expect([...hiddenRequests(first), ...hiddenRequests(second)]).toHaveLength(dispatcher.length);
    }, { model: "claude-sonnet-5-5", seams: { agentHosts } });
  }, 120_000);

  test("one host serves agents of several Claude models: each request runs on its agent's model and reads that model's line, its answer is priced on that model, and a model change dispatches again on the same host", async () => {
    registry = createHostRegistry();
    let launches = 0;
    const haiku = { wireModelId: "claude-haiku-5-5", contextLimit: 200_000 };
    const opus = { wireModelId: "claude-opus-5-5", contextLimit: 1_000_000 };
    await onFakeHost(temporary, hostScript(lookupThenAnswer), async ({ host, stage, projectRoot }) => {
      const clients = [await stage({ sharedHost: TREE, model: haiku }), await stage({ sharedHost: TREE, model: opus })];
      const [fast, deep] = clients.map((client) => agentLoop(client, projectRoot, "Find the value."));
      const firsts = await Promise.all([fast!.request(), deep!.request()]);
      for (const [index, agent] of [fast!, deep!].entries()) agent.result(streamedToolCalls(firsts[index]!)[0]?.id ?? "", "VALUE");
      // The person moves the Haiku agent to Opus while it is parked on its tool call: a new client continues its
      // history, whose newest input is the tool result.
      clients.push(await stage({ sharedHost: TREE, model: opus }));
      const parked = agentLoop(clients[2]!, projectRoot, "");
      parked.history.splice(0, parked.history.length, ...fast!.history);
      const switched = await parked.request();
      const second = await deep!.request();
      // The person moves it back to Haiku with a new message.
      clients.push(await stage({ sharedHost: TREE, model: haiku }));
      const back = agentLoop(clients[3]!, projectRoot, "Say it again.");
      back.history.unshift(...parked.history);
      const third = await back.request();
      const results = [...firsts, switched, second, third];
      expect(results.map((result) => result.error)).toEqual(results.map(() => undefined));
      expect(results.map((result) => result.events.findLast((event) => event.kind === "done")?.metadata?.model))
        .toEqual(["claude-haiku-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-opus-5-5", "claude-haiku-5-5"]);
      // Each answer is priced on the rate card of the model that answered it: 100 input and 5 output tokens.
      const price = (result: StreamResult, client: StagedSdkClient) => {
        const usage = result.events.findLast((event) => event.kind === "usage");
        if (usage?.kind !== "usage") throw new Error("no usage");
        const priced = client.staged.attempt.priceFor({ input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens ?? 0, cacheWrite: usage.cacheCreateTokens, reasoning: usage.reasoningTokens });
        return priced.status === "priced" ? priced.amountUsd : priced.reason;
      };
      expect([price(firsts[0]!, clients[0]!), price(firsts[1]!, clients[1]!), price(switched, clients[2]!), price(second, clients[1]!), price(third, clients[3]!)])
        .toEqual([0.000_125, 0.000_625, 0.000_625, 0.000_625, 0.000_125]);
      expect(launches).toBe(1);
      expect(new Set(host.requests.map((request) => request.sessionId)).size).toBe(1);
      const agentRequests = host.requests.filter((request) => !isDispatcher(request));
      // The engine words each model reminder itself from the identity that the agent file holds, so the wire is read
      // by the model ID that each of its model lines names.
      const modelLines = (texts: readonly string[]) => texts.flatMap((text) => [...text.matchAll(/^You are powered by the model\b.*?\bID is (\S+?)\.(?: |$)/gmu)].map((match) => match[1] ?? ""));
      const wireLines = (request: RecordedRequest) => modelLines([...systemTexts(request), ...wireMessages(request).flatMap((message) => typeof message.content === "string" ? [message.content] : message.content.flatMap((block) => block.text === undefined ? [] : [block.text]))]);
      const line = (model: string) => model === "claude-haiku-5-5" ? "claude-haiku-5-5" : "claude-opus-5-5[1m]";
      const historyLines = (history: readonly ConversationMessage[]) => history.flatMap((message) => {
        const reminder = parseClaudeReminder(textOf(message) ?? "");
        return reminder?.kind === "model" ? [reminder.modelId] : [];
      });
      const served = agentRequests.map((request) => ({ model: request.body["model"], extended: request.betas.some((beta) => beta.startsWith("context-1m")), lines: wireLines(request) }));
      // Each first request reads one model line, its own model's. After each model change the request reads every line
      // that its history holds, the newest naming its new model, as its own engine would show them; the engine adds none.
      expect(served.slice(0, 2).toSorted((left, right) => String(left.model).localeCompare(String(right.model))))
        .toEqual([haiku, opus].map(({ wireModelId }) => ({ model: wireModelId, extended: wireModelId === opus.wireModelId, lines: [line(wireModelId)] })));
      expect(served.slice(2)).toEqual([
        { model: opus.wireModelId, extended: true, lines: [line(haiku.wireModelId), line(opus.wireModelId)] },
        { model: opus.wireModelId, extended: true, lines: [line(opus.wireModelId)] },
        { model: haiku.wireModelId, extended: false, lines: [line(haiku.wireModelId), line(opus.wireModelId), line(haiku.wireModelId)] },
      ]);
      // Every model line on the wire states a model reminder of canonical history and is a reminder addition of the transport record.
      for (const [index, [agent, result]] of ([[parked, switched], [deep!, second], [back, third]] as const).entries()) {
        const lines = served[index + 2]!.lines;
        expect(historyLines(agent.history)).toEqual(lines);
        expect(result.events.flatMap((event) => event.kind === "transport_context" ? event.context.additions.filter(({ kind }) => kind === "reminder:model") : [])).toHaveLength(lines.length);
      }
      // The dispatcher runs on the host's launch model, with no rewrite.
      expect(host.requests.filter(isDispatcher).map((request) => request.body["model"])).toEqual(host.requests.filter(isDispatcher).map(() => "claude-haiku-5-5"));
    }, { seams: { agentHosts, createHostLauncher: (config) => { const launch = createHostLauncher(config); return (input) => { launches += 1; return launch(input); }; } } });
  }, 120_000);

  test("a parked agent whose next request changes its effort continues its turn at that effort, with no dispatch", async () => {
    registry = createHostRegistry();
    await onFakeHost(temporary, hostScript(lookupThenAnswer), async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const [call] = streamedToolCalls(await agent.request());
      agent.result(call?.id ?? "", "VALUE");
      const dispatcher = host.requests.filter(isDispatcher).length;
      agent.effort = "high";
      const continued = await agent.request();
      expect(continued.error).toBeUndefined();
      expect(streamedText(continued)).toBe("The value is ready.");
      expect(host.requests.filter(isDispatcher)).toHaveLength(dispatcher);
      expect(host.requests.filter((request) => !isDispatcher(request)).map(effortOf)).toEqual(["medium", "high"]);
      expect(diagnostics.payloads("provider.claude_sdk.host.agent_dispatched")).toHaveLength(1);
    }, { seams: { agentHosts } });
  }, 120_000);

  test("a hosted request ends while the dispatcher's request of its frame still runs", async () => {
    registry = createHostRegistry();
    await onFakeHost(temporary, (request, index) => {
      // The dispatcher's answer after its SendMessage results never ends, so its frame stays open.
      if (isDispatcher(request) && wireMessages(request).at(-1)?.role === "user" && JSON.stringify(wireMessages(request).at(-1)).includes("tool_result")) return { blocks: [{ text: "Sen" }], open: true };
      return hostScript(() => ({ blocks: [{ thinking: "Done." }, { text: "Done." }] }))(request, index);
    }, async ({ stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Report.");
      const result = await agent.request();
      expect(result.error).toBeUndefined();
      expect(streamedText(result)).toBe("Done.");
    }, { seams: { agentHosts } });
  }, 120_000);

  test("an agent's rows that the engine writes before it reports the task's start reach the request", async () => {
    registry = createHostRegistry();
    // The host reads the engine's task start a second late, after the agent's step streamed and its row was written.
    const lateStart = (launched: LaunchedHost): LaunchedHost => ({
      ...launched,
      messages: (async function* () {
        for await (const message of launched.messages) {
          if (message.type === "system" && message.subtype === "task_started") await Bun.sleep(1_000);
          yield message;
        }
      })(),
    });
    await onFakeHost(temporary, hostScript(() => ({ blocks: [{ thinking: "Done." }, { text: "Done." }] })), async ({ stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Report.");
      const result = await agent.request();
      expect(result.error).toBeUndefined();
      expect(streamedText(result)).toBe("Done.");
    }, { seams: { agentHosts, createHostLauncher: (config) => { const launch = createHostLauncher(config); return (input) => lateStart(launch(input)); } } });
  }, 120_000);

  test("the host cuts the dispatcher's conversation after each frame, and no frame goes out while the cut runs", async () => {
    registry = createHostRegistry();
    const cut = Promise.withResolvers<void>();
    let cuts = 0;
    let dispatcherAtCut = 0;
    const heldCut = (launched: LaunchedHost): LaunchedHost => ({
      ...launched,
      rewind: (target, lastSeen) => Effect.promise(async () => { cuts += 1; await cut.promise; }).pipe(Effect.andThen(launched.rewind(target, lastSeen))),
    });
    await onFakeHost(temporary, hostScript(() => ({ blocks: [{ thinking: "Done." }, { text: "Done." }] })), async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Report.");
      expect((await agent.request()).error).toBeUndefined();
      await until(() => cuts === 1, "the cut after the first frame");
      dispatcherAtCut = host.requests.filter(isDispatcher).length;
      agent.history.push({ kind: "user", origin: "human", content: "After the cut." });
      const next = agent.request();
      await Bun.sleep(1_000);
      expect(host.requests.filter(isDispatcher)).toHaveLength(dispatcherAtCut);
      cut.resolve();
      expect((await next).error).toBeUndefined();
      const after = host.requests.filter(isDispatcher).slice(dispatcherAtCut);
      expect(after.length).toBeGreaterThan(0);
      // The cut emptied the conversation, so the second frame's first request holds only that frame.
      expect(wireMessages(after[0]!).filter((message) => message.role === "assistant")).toEqual([]);
      await until(() => cuts === 2, "the cut after the second frame");
    }, { seams: { agentHosts, createHostLauncher: (config) => { const launch = createHostLauncher(config); return (input) => heldCut(launch(input)); } } });
  }, 120_000);

  test("an agent that answered keeps its host while its lifetime lasts, and the host closes when the last lifetime that uses it ends", async () => {
    registry = createHostRegistry();
    let launches = 0;
    await onFakeHost(temporary, hostScript(() => ({ blocks: [{ thinking: "Done." }, { text: "Done." }] })), async ({ stage, projectRoot }) => {
      const staged = await stage({ sharedHost: TREE });
      const agent = agentLoop(staged, projectRoot, "Report.");
      expect((await agent.request()).error).toBeUndefined();
      agent.history.push({ kind: "user", origin: "human", content: "Again." });
      expect((await agent.request()).error).toBeUndefined();
      expect(launches).toBe(1);
      expect(diagnostics.payloads("provider.claude_sdk.host.closed")).toEqual([]);
      await staged.replace();
      await until(() => diagnostics.payloads("provider.claude_sdk.host.closed").length === 1, "the unused host's close");
    }, { seams: { agentHosts, createHostLauncher: (config) => { const launch = createHostLauncher(config); return (input) => { launches += 1; return launch(input); }; } } });
  }, 120_000);

  test("a second message of the dispatcher to one agent is denied, in its first step or after its results, and the agent runs once under its id", async () => {
    registry = createHostRegistry();
    // The dispatcher sends the agent's message twice in one response, sends it a third time after the results, and
    // answers after that denial in a third step.
    await onFakeHost(temporary, (request) => {
      if (!isDispatcher(request)) return lookupThenAnswer(request);
      const answered = wireMessages(request).filter((message) => message.role === "assistant").length;
      const send = { tool: "SendMessage", input: { to: JSON.stringify(request.body).match(/agents: (a[0-9a-f]{16})/u)?.[1], message: "Continue." } };
      return answered === 0 ? { blocks: [send, send] } : answered === 1 ? { blocks: [send] } : { blocks: [{ text: "Sent" }] };
    }, async ({ host, stage, projectRoot }) => {
      const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Find the value.");
      const first = await agent.request();
      expect(first.error).toBeUndefined();
      const [call] = streamedToolCalls(first);
      agent.result(call?.id ?? "", "VALUE");
      const second = await agent.request();
      expect(streamedText(second)).toBe("The value is ready.");
      await until(() => diagnostics.payloads("provider.claude_sdk.host.frame").length === 1, "the frame's end");
      expect(diagnostics.payloads("provider.claude_sdk.host.dispatch_denied").map(({ fault }) => fault)).toEqual(["duplicate", "duplicate"]);
      const dispatcher = host.requests.filter(isDispatcher);
      expect(dispatcher).toHaveLength(3);
      const denials = dispatcher.slice(1).map((request) => {
        const last = wireMessages(request).at(-1);
        return typeof last?.content === "string" ? [] : last?.content.filter((block) => block.type === "tool_result").map((block) => block.is_error === true) ?? [];
      });
      expect(denials).toEqual([[false, true], [true]]);
      // The agent read one dispatch, and its turn continued through its tool call with no second one.
      const agentRequests = host.requests.filter((request) => !isDispatcher(request));
      expect(agentRequests).toHaveLength(2);
      expect(agentRequests.map((request) => lastUserTexts(request).filter((text) => text === DISPATCH_TEXT).length)).toEqual([1, 0]);
      expect(diagnostics.payloads("provider.claude_sdk.host.agent_dispatched")).toHaveLength(1);
      expect(diagnostics.payloads("provider.claude_sdk.host.task_stopped")).toEqual([]);
      expect(diagnostics.payloads("provider.claude_sdk.host.closed")).toEqual([]);
    }, { seams: { agentHosts } });
  }, 120_000);

  test("an agent that moves to another provider while it waits on a tool result and back starts under a new id, and reads only what it said and did", async () => {
    registry = createHostRegistry();
    const patchResult = "Success. Updated value.txt with VALUE.";
    const reasoningSummary = "Private plan of the other model: check the value twice.";
    const encryptedReasoning = "gAAAAB-encrypted-reasoning-of-the-other-model";
    const reply = (request: RecordedRequest): FakeReply => JSON.stringify(wireMessages(request)).includes(patchResult)
      ? { blocks: [{ thinking: "The patch is in." }, { text: "The file is patched." }] }
      : lookupThenAnswer(request);
    // The role shows thinking as progress updates, so the agent's thinking on the engine is what it said to its person.
    const providerOptions = { anthropic: { thinking_display: "updates" } } as const;
    await onFakeHost(temporary, hostScript(reply), async ({ host, stage, projectRoot, configDir }) => {
      const engine = await stage({ sharedHost: TREE });
      const agent = agentLoop(engine, projectRoot, "Find the value, then write it to value.txt.");
      agent.providerOptions = providerOptions;
      const [lookup] = streamedToolCalls(await agent.request());
      // The person moves the agent to an OpenAI model while it waits on its lookup: the runner replaces the engine's client.
      await engine.replace();
      await until(() => diagnostics.payloads("provider.claude_sdk.host.task_stopped").length === 1, "the stop of the parked agent");
      agent.result(lookup?.id ?? "", "VALUE");
      // The other provider's turn: its private reasoning, its reply, and a patch under its own call id, whose result
      // the agent waits on when the person moves it back.
      agent.history.push({
        kind: "assistant", accessProvider: "chatgpt", provider: "openai", api: "openai-responses", model: "gpt-6-luna",
        content: [
          { type: "reasoning", id: "rs_0a1b2c3d", encrypted_content: encryptedReasoning, summary: [{ type: "summary_text", text: reasoningSummary }] },
          { type: "text", text: "The value is VALUE; I will write it to value.txt." },
          { type: "tool_use", id: "call_Q1w2E3r4T5y6", providerItemId: "fc_0a1b2c3d", providerCallId: "call_Q1w2E3r4T5y6", name: "apply_patch", input: { input: "*** Begin Patch\n*** Add File: value.txt\n+VALUE\n*** End Patch" } },
        ],
      });
      agent.result("call_Q1w2E3r4T5y6", patchResult);
      const back = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "");
      back.providerOptions = providerOptions;
      back.history.splice(0, back.history.length, ...agent.history);
      const returned = await back.request();
      expect(returned.error).toBeUndefined();
      expect(streamedText(returned)).toBe("The file is patched.");

      // The engine's client ended with its lifetime, which stopped the parked agent's task with no failure.
      expect(diagnostics.payloads("provider.claude_sdk.host.task_stopped").map(({ cause, reason }) => ({ cause, reason }))).toEqual([{ cause: "lifetime-end", reason: undefined }]);
      expect(diagnostics.payloads("provider.claude_sdk.host.agent_ended")).toEqual([]);
      const dispatched = diagnostics.payloads("provider.claude_sdk.host.agent_dispatched");
      expect(dispatched).toHaveLength(2);
      expect(dispatched[1]?.["agentId"]).not.toBe(dispatched[0]?.["agentId"]);
      expect(back.history.filter((message) => textOf(message) === ENGINE_INSTRUCTIONS)).toHaveLength(1);

      // The return dispatch wrote the agent's whole conversation to its file, and the engine sent it.
      const sent = host.requests.filter((request) => !isDispatcher(request)).at(-1);
      if (sent === undefined) throw new Error("no agent request");
      const file = readFileSync(agentFilePath({ configDir, cwd: projectRoot, sessionId: String(dispatched[1]?.["sessionId"]) }, String(dispatched[1]?.["agentId"])), "utf8");
      const rows = file.trim().split("\n").map((line) => Schema.decodeUnknownSync(AgentFileRow)(JSON.parse(line)));
      const calls = rows.flatMap(({ message }) => typeof message?.content === "string" ? [] : message?.content.flatMap((block) => block.type === "tool_use" ? [block.name] : []) ?? []);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.filter((name) => !declaredTools(sent.body).includes(name ?? ""))).toEqual([]);
      for (const read of [file, JSON.stringify(sent.body)]) {
        // The patch, whose tool this request does not declare, reads as neutral context with its result.
        expect(read).toContain("Earlier operation call_Q1w2E3r4T5y6");
        expect(read).toContain(patchResult);
        // The other model's private reasoning is no part of what the engine reads.
        expect(read).not.toContain(reasoningSummary);
        expect(read).not.toContain(encryptedReasoning);
        // What the agent said and did is: its progress update, its replies, and its lookup with its result.
        for (const kept of ["I need the value.", "The value is VALUE; I will write it to value.txt.", lookup?.id ?? "?"]) expect(read).toContain(kept);
      }
    }, { seams: { agentHosts } });
  }, 120_000);
});

describe("the engine text that Flywheel records for a hosted agent", () => {
  test("equals what the bundled engine sends, for every model of the engine's lineup", async () => {
    let lineup: readonly string[] = [];
    await onFakeHost(temporary, () => ({ blocks: [] }), async ({ configDir, seams }) => {
      const supervisor = createProcessSupervisor();
      const launcher = createLauncherScope(supervisor);
      try {
        const launch = cliLaunch({ type: "external", configDir }, launcher, seams);
        if (launch.kind !== "ready") throw new Error(`no engine launch: ${launch.kind}`);
        lineup = [...new Set((await describeCliLogin(launch.config, AbortSignal.timeout(30_000))).models.flatMap((model) => typeof model.resolvedModel === "string" ? [model.resolvedModel] : []))];
      } finally {
        await launcher.close();
        await supervisor.dispose();
      }
    });
    expect(lineup.length).toBeGreaterThan(0);
    for (const model of lineup) {
      registry = createHostRegistry();
      await onFakeHost(temporary, hostScript(() => ({ blocks: [{ thinking: "Done." }, { text: "Done." }] })), async ({ host, stage, projectRoot }) => {
        const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, "Report.");
        expect((await agent.request()).error).toBeUndefined();
        const sent = host.requests.find((request) => !isDispatcher(request));
        if (sent === undefined) throw new Error(`${model}: no agent request`);
        const system = systemTexts(sent);
        expect({ model, identity: system[1] }).toEqual({ model, identity: AGENT_IDENTITY });
        expect({ model, prompt: system[2] }).toEqual({ model, prompt: `${SYSTEM.stable}${SYSTEM_PROMPT_SEPARATOR}${SYSTEM.session}${AGENT_APPENDIX}` });
        expect({ model, wrapper: lastUserTexts(sent).at(-1) }).toEqual({ model, wrapper: DISPATCH_TEXT });
        // Each reminder that history records reaches the model, in the user blocks or the system message of the model's
        // layout. The engine words each reminder itself from the facts of the agent file, so the wire is read by its facts.
        // The environment states the shell that the engine names, which on Windows with Git Bash is bash (PI-MODEL-081).
        const shell = engineShell({ platform: process.platform, hostEnvironment: process.env });
        const texts = wireMessages(sent).flatMap((message) => typeof message.content === "string" ? [message.content] : message.content.flatMap((block) => block.text === undefined ? [] : [block.text]));
        const reminders = agent.history.flatMap((message) => {
          const text = message.kind === "user" && message.origin === "system" ? textOf(message) : undefined;
          const reminder = text === undefined ? undefined : parseClaudeReminder(text);
          return reminder === undefined ? [] : [reminder];
        });
        expect(reminders.map((reminder) => reminder.kind).toSorted()).toEqual(["date", "environment", "model"]);
        for (const reminder of reminders) {
          const facts = reminder.kind === "model" ? [reminder.modelId] : reminder.kind === "date" ? [reminder.date]
            : reminder.kind === "environment" ? [reminder.workingDirectory, reminder.platform, shell ?? reminder.shell ?? canonicalShell(), reminder.osVersion] : [];
          expect({ model, reminder: reminder.kind, stated: texts.some((text) => facts.every((value) => text.includes(value))) }).toEqual({ model, reminder: reminder.kind, stated: true });
        }
      }, { model, seams: { agentHosts } });
      await registry.drain();
    }
  }, 300_000);
});
