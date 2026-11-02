/**
 * Runtime notices to a hosted agent on a fake host: the production Agent SDK client of hosted agents, the bundled
 * engine, and a local Anthropic host. A notice that follows a parked batch rides on the batch's last result through
 * the open tool call, with no dispatch; every other input, and a notice that no result can carry, dispatches.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { formatChildInterruptedNotification, formatSubagentNotificationBatch } from "../../../../../src/orchestration/agent-runtime/background-work-notifications.js";
import { formatRuntimeNotification } from "../../../../../src/orchestration/agent-runtime/runtime-notifications.js";
import { captureForkMessages } from "../../../../../src/orchestration/agent-runtime/agent-loop-history.js";
import { toOpenAIResponsesInput } from "../../../../../src/orchestration/agent-runtime/llm/conversions/openai-responses.js";
import { openAIResponsesTarget, resolveOpenAISystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/openai-adapter-helpers.js";
import { conversationTierEntry, DISPATCH_TEXT, ENGINE_INSTRUCTIONS } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/engine-text.js";
import { parseClaudeReminder } from "../../../../../src/orchestration/agent-runtime/llm/claude-reminders.js";
import { createHostRegistry, type HostRegistry } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-registry.js";
import { createHostLauncher } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { agentLoop, dispatchedIds, hostScript, isDispatcher, LOOKUP, registryProxy, SYSTEM, textOf, TREE, wireMessages, type WireBlock } from "./_agent-host.js";
import { captureDiagnostics, onFakeHost, removeEngineProbes, streamedToolCalls, type FakeHostRun, type StreamResult } from "./_claude-sdk-client.js";
import type { FakeReply, RecordedRequest } from "./_fake-host.js";

const temporary = temporaryDirectories();
removeEngineProbes();
const diagnostics = captureDiagnostics();

let registry: HostRegistry;
afterEach(async () => { await registry.drain(); });
const agentHosts = registryProxy(() => registry);

const PROCESS = { name: "process", description: "Waits on background work.", input_schema: { type: "object", properties: { action: { type: "string" } }, required: ["action"] } };
const ACK = "Wait acknowledged for at most 240 seconds. The loop parks after this turn's other tool calls finish.";
const completion = (value: string) => formatSubagentNotificationBatch([{
  meta: { type: "subagent", description: "Compute the value", sessionId: "c0ffee000001", toolUseId: "toolu_child" },
  result: { status: "completed", content: `The value is ${value} <&> "quoted"\n  trailing spaces  ` },
}], 0);
const INTERRUPTED = formatChildInterruptedNotification({ description: "Compute the value", sessionId: "c0ffee000002" });
const EXPIRED = formatRuntimeNotification({ tag: "wait_expired", fields: [["seconds", "240"], ["pending", "1"], ["processes", "[]"]], handling: "This wait expired once." });
const NO_REPLY = formatRuntimeNotification({ tag: "reply_wait_notification", handling: "The child ended its turn without a reply to you.", fields: [["session_id", "c0ffee000003"], ["status", "no_reply"]] });

const WAIT = { tool: "process", input: { action: "wait" } } as const;
const LOOK = { tool: "lookup", input: { key: "k" } } as const;
const DONE: FakeReply = { blocks: [{ thinking: "Done." }, { text: "Done." }] };
const calls = (...tools: readonly (typeof WAIT | typeof LOOK)[]): FakeReply => ({ blocks: [{ thinking: "Next." }, ...tools] });

/** The brief that names an agent's case, from the first user message of its request. */
const caseOf = (request: RecordedRequest) => {
  const first = wireMessages(request).find((message) => message.role === "user");
  const texts = first === undefined ? [] : typeof first.content === "string" ? [first.content] : first.content.flatMap((block) => block.text === undefined ? [] : [block.text]);
  return texts.map((text) => /^Case (\S+)\./u.exec(text)?.[1]).find((name) => name !== undefined) ?? "";
};

/** Each agent's answers, by its case and the number of its requests so far. */
function scripted(steps: { readonly [name: string]: readonly FakeReply[] }) {
  const seen = new Map<string, number>();
  return hostScript((request) => {
    const name = caseOf(request);
    const index = seen.get(name) ?? 0;
    seen.set(name, index + 1);
    return steps[name]?.[index] ?? DONE;
  });
}

type Loop = ReturnType<typeof agentLoop>;

/** A hosted parent of the tree whose brief names its case, with the lookup and process tools. */
async function parent({ stage, projectRoot }: FakeHostRun, name: string, systemPrompt = SYSTEM): Promise<Loop> {
  const agent = agentLoop(await stage({ sharedHost: TREE }), projectRoot, `Case ${name}. Do the work.`, systemPrompt);
  agent.tools = [LOOKUP, PROCESS];
  return agent;
}
const parents = (run: FakeHostRun, names: readonly string[]) => Promise.all(names.map((name) => parent(run, name)));
const notice = (agent: Loop, text: string) => { agent.history.push({ kind: "user", origin: "system", runtimeNotice: true, content: text }); };
const ids = (result: StreamResult) => streamedToolCalls(result).map((call) => call.id);
const agentRequests = (requests: readonly RecordedRequest[], name: string) => requests.filter((request) => !isDispatcher(request) && caseOf(request) === name);

/** The text blocks of each tool result of a request's newest user message, and its other text blocks. */
function tail(request: RecordedRequest) {
  const last = wireMessages(request).at(-1);
  const blocks: readonly WireBlock[] = last === undefined || typeof last.content === "string" ? [] : last.content;
  const texts = (block: WireBlock) => typeof block.content === "string" ? [block.content] : Array.isArray(block.content) ? block.content.map((part: WireBlock) => part.text ?? "") : [];
  return {
    results: blocks.filter((block) => block.type === "tool_result").map((block) => ({ id: block.tool_use_id, isError: block.is_error === true, texts: texts(block) })),
    input: blocks.flatMap((block) => block.type === "text" && block.text !== undefined ? [block.text] : []),
  };
}

const folds = (result: StreamResult) => result.events.flatMap((event) => event.kind === "transport_context" ? event.context.additions.filter(({ kind }) => kind.startsWith("tool-result:")) : []);
const coordinator = (result: StreamResult) => result.events.flatMap((event) => event.kind === "transport_context" ? event.context.additions.filter(({ kind }) => kind === "coordinator") : []);
const wrappers = (agent: Loop) => agent.history.filter((message) => message.kind === "user" && message.content === DISPATCH_TEXT).length;
const dispatchPayload = (agentId: string) => diagnostics.payloads("provider.claude_sdk.host.agent_dispatched").filter((payload) => payload["agentId"] === agentId);

describe("a runtime notice after a parked batch", () => {
  test("rides on the wait's result byte for byte, also after a pause in which the host hears nothing, with no dispatch and a record of the fold, and no other protocol reads the engine's text", async () => {
    registry = createHostRegistry();
    const NOTICE = completion("4217");
    await onFakeHost(temporary, scripted({ wait: [calls(WAIT), DONE] }), async (run) => {
      const { host } = run;
      const tier = "# Session identity\n\nYou are session one.";
      const agent = await parent(run, "wait", { ...SYSTEM, conversation: tier });
      const first = await agent.request();
      const [waitId] = ids(first);
      agent.result(waitId ?? "", ACK);
      notice(agent, NOTICE);
      const before = host.requests.length;
      await Bun.sleep(1_500);
      expect(host.requests.length).toBe(before);
      const second = await agent.request();
      expect(second.error).toBeUndefined();

      const sent = agentRequests(host.requests, "wait");
      expect(sent).toHaveLength(2);
      expect(tail(sent[1]!)).toEqual({ results: [{ id: waitId, isError: false, texts: [ACK, NOTICE] }], input: [] });
      expect(dispatchedIds(host.requests)).toHaveLength(1);
      expect(wrappers(agent)).toBe(1);
      expect(folds(second)).toEqual([{ part: "message", kind: "tool-result:notice-folded", at: 2, value: waitId }]);
      // Canonical history keeps the notice as its own entry after the result.
      expect(agent.history.findIndex((message) => message.kind === "user" && message.content === NOTICE)).toBe(agent.history.findIndex((message) => message.kind === "toolResult") + 1);

      // A fork or a failover of this history to another provider reads none of the engine's text and none of the
      // host's conversation-tier entry, while durable history keeps all of them. The failover reads the conversation
      // tier once, in its instructions.
      const history = [...agent.history];
      const model = history.flatMap((message) => parseClaudeReminder(textOf(message) ?? "")?.kind === "model" ? [textOf(message) ?? ""] : []);
      expect(model).toHaveLength(1);
      const hostText = [ENGINE_INSTRUCTIONS, DISPATCH_TEXT, ...model, conversationTierEntry(tier)];
      for (const text of hostText) expect(history.some((message) => textOf(message) === text)).toBe(true);
      const openai = openAIResponsesTarget("openai_api", "o4");
      const failover = JSON.stringify(toOpenAIResponsesInput(openai, history));
      const instructions = resolveOpenAISystemPrompt({ messages: history, systemPrompt: { ...SYSTEM, conversation: tier }, isChatGPT: false });
      const fork = JSON.stringify(toOpenAIResponsesInput(openai, await captureForkMessages(history)));
      const encoded = (text: string) => JSON.stringify(text).slice(1, -1);
      for (const text of hostText) {
        expect(failover).not.toContain(encoded(text));
        expect(fork).not.toContain(encoded(text));
      }
      expect(failover).not.toContain(encoded(tier));
      expect(instructions.split(tier)).toHaveLength(2);
      expect(fork).toContain(encoded(NOTICE));
    }, { seams: { agentHosts } });
  }, 120_000);

  test("folds in history order: on a later step's result, on each wait of an expiry and a rewait, and with several notices in one tail", async () => {
    registry = createHostRegistry();
    const NOTICE = completion("77");
    await onFakeHost(temporary, scripted({ later: [calls(LOOK), calls(LOOK), DONE], expiry: [calls(WAIT), calls(WAIT), DONE], several: [calls(WAIT), DONE] }), async (run) => {
      const { host } = run;
      const [later, expiry, several] = await Promise.all([parent(run, "later"), parent(run, "expiry"), parent(run, "several")]);
      const loops = [later, expiry, several];
      const firsts = await Promise.all(loops.map((agent) => agent.request()));

      // A notice that arrives while the next step runs rides on that step's batch.
      later.result(ids(firsts[0]!)[0] ?? "", "VALUE 1");
      const laterSecond = await later.request();
      const [secondLookup] = ids(laterSecond);
      later.result(secondLookup ?? "", "VALUE 2");
      notice(later, NOTICE);
      const laterThird = await later.request();
      expect(tail(agentRequests(host.requests, "later")[2]!).results).toEqual([{ id: secondLookup, isError: false, texts: ["VALUE 2", NOTICE] }]);
      expect(folds(laterThird)).toEqual([{ part: "message", kind: "tool-result:notice-folded", at: 4, value: secondLookup }]);

      // An expiry folds into the first wait's result and the completion into the second's; the third request's record
      // names both.
      const [firstWait] = ids(firsts[1]!);
      expiry.result(firstWait ?? "", ACK);
      notice(expiry, EXPIRED);
      const [secondWait] = ids(await expiry.request());
      expiry.result(secondWait ?? "", ACK);
      notice(expiry, NOTICE);
      const expiryThird = await expiry.request();
      const sentExpiry = agentRequests(host.requests, "expiry");
      expect(tail(sentExpiry[1]!).results).toEqual([{ id: firstWait, isError: false, texts: [ACK, EXPIRED] }]);
      expect(tail(sentExpiry[2]!).results).toEqual([{ id: secondWait, isError: false, texts: [ACK, NOTICE] }]);
      expect(folds(expiryThird)).toEqual([
        { part: "message", kind: "tool-result:notice-folded", at: 2, value: firstWait },
        { part: "message", kind: "tool-result:notice-folded", at: 4, value: secondWait },
      ]);

      // A child completion and a child-interrupt notice ride in the order history holds them.
      const [wait] = ids(firsts[2]!);
      several.result(wait ?? "", ACK);
      notice(several, NOTICE);
      notice(several, INTERRUPTED);
      notice(several, NO_REPLY);
      await several.request();
      expect(tail(agentRequests(host.requests, "several")[1]!).results).toEqual([{ id: wait, isError: false, texts: [ACK, NOTICE, INTERRUPTED, NO_REPLY] }]);

      expect(dispatchedIds(host.requests)).toHaveLength(3);
      expect(loops.map(wrappers)).toEqual([1, 1, 1]);
    }, { seams: { agentHosts } });
  }, 180_000);

  test("in a mixed batch, the earlier result passes unchanged and the last success result carries the notice", async () => {
    registry = createHostRegistry();
    const NOTICE = completion("5");
    await onFakeHost(temporary, scripted({ mixed: [calls(LOOK, WAIT), DONE], errorFirst: [calls(LOOK, WAIT), DONE] }), async (run) => {
      const { host } = run;
      const loops = await parents(run, ["mixed", "errorFirst"]);
      const firsts = await Promise.all(loops.map((agent) => agent.request()));
      const batches = firsts.map(ids);
      loops[0]!.result(batches[0]![0] ?? "", "VALUE");
      loops[1]!.result(batches[1]![0] ?? "", "Error: no key named k.", true);
      for (const [index, agent] of loops.entries()) {
        agent.result(batches[index]![1] ?? "", ACK);
        notice(agent, NOTICE);
      }
      const seconds = await Promise.all(loops.map((agent) => agent.request()));
      expect(seconds.map((result) => result.error)).toEqual([undefined, undefined]);
      expect(tail(agentRequests(host.requests, "mixed")[1]!)).toEqual({ results: [
        { id: batches[0]![0], isError: false, texts: ["VALUE"] }, { id: batches[0]![1], isError: false, texts: [ACK, NOTICE] },
      ], input: [] });
      expect(tail(agentRequests(host.requests, "errorFirst")[1]!)).toEqual({ results: [
        { id: batches[1]![0], isError: true, texts: ["Error: no key named k."] }, { id: batches[1]![1], isError: false, texts: [ACK, NOTICE] },
      ], input: [] });
      expect(dispatchedIds(host.requests)).toHaveLength(2);
    }, { seams: { agentHosts } });
  }, 120_000);
});

describe("a runtime notice that no open call can carry dispatches", () => {
  test("after a failed, blank, or full last result, as top-level text under a new agent id, and never inside an error", async () => {
    registry = createHostRegistry();
    const NOTICE = completion("9");
    const cases = [
      { name: "failed", reason: "error", content: [{ type: "text" as const, text: "Error: no key named k." }], isError: true as const },
      { name: "blank", reason: "rewrite", content: [] },
      { name: "full", reason: "over-limit", content: [{ type: "text" as const, text: "x".repeat(499_990) }] },
    ];
    await onFakeHost(temporary, scripted(Object.fromEntries(cases.map(({ name }) => [name, [calls(WAIT, LOOK), DONE]]))), async (run) => {
      const { host } = run;
      for (const { name, reason, content, ...error } of cases) {
        const agent = await parent(run, name);
        const [wait, lookup] = ids(await agent.request());
        const started = dispatchedIds(host.requests).at(-1) ?? "";
        agent.result(wait ?? "", ACK);
        agent.history.push({ kind: "toolResult", toolUseId: lookup ?? "", content, ...error });
        notice(agent, NOTICE);
        const second = await agent.request();
        expect(second.error).toBeUndefined();
        const restarted = dispatchedIds(host.requests).at(-1) ?? "";
        expect(restarted).not.toBe(started);
        expect(dispatchPayload(restarted)).toEqual([expect.objectContaining({ plan: "start", trigger: "notice-carrier", reason, resumed: false })]);
        expect(wrappers(agent)).toBe(2);
        const sent = tail(agentRequests(host.requests, name)[1]!);
        // The agent file holds the notice as the message's own text, which the engine ends with a newline.
        expect(sent.input.some((text) => text.trimEnd() === NOTICE.trimEnd())).toBe(true);
        expect(sent.results.some((result) => result.texts.some((text) => text.includes(NOTICE)))).toBe(false);
      }
    }, { seams: { agentHosts } });
  }, 180_000);

  test("after the agent answered, by one dispatch that resumes it under its id", async () => {
    registry = createHostRegistry();
    await onFakeHost(temporary, scripted({ answered: [DONE, DONE] }), async (run) => {
      const { host } = run;
      const agent = await parent(run, "answered");
      await agent.request();
      notice(agent, completion("3"));
      const second = await agent.request();
      expect(second.error).toBeUndefined();
      const [first, again] = dispatchedIds(host.requests);
      expect(again).toBe(first);
      expect(dispatchPayload(first ?? "").map((payload) => payload["resumed"])).toEqual([false, true]);
      expect(coordinator(second)).toHaveLength(1);
      expect(wrappers(agent)).toBe(2);
    }, { seams: { agentHosts } });
  }, 120_000);
});

describe("any input that is not only runtime notices dispatches", () => {
  test("a person's message, a session message of every relation, an unlabeled nudge, and a notice beside unlabeled input or text equal to it", async () => {
    registry = createHostRegistry();
    const NOTICE = completion("1");
    const session = (relation: "parent" | "child" | "sibling", waits: boolean): ConversationMessage => ({
      kind: "user", content: `A ${relation} message.`,
      producer: { kind: "session", sessionId: `${relation}0000001`, conversationId: `${relation}-conversation`, toolUseId: "toolu_send", hop: 0, envelope: { name: relation, relation, waits } },
    });
    const inputs = {
      person: [{ kind: "user", origin: "human", content: "A person's words." }],
      steer: [session("parent", false)],
      peer: [session("sibling", false)],
      question: [session("child", true)],
      reply: [session("child", false)],
      nudge: [{ kind: "user", origin: "system", content: "<repetition_nudge/>" }],
      beside: [{ kind: "user", origin: "system", runtimeNotice: true, content: NOTICE }, { kind: "user", origin: "human", content: "A person's words." }],
      equal: [{ kind: "user", origin: "system", runtimeNotice: true, content: NOTICE }, { kind: "user", origin: "system", content: NOTICE }],
    } satisfies { readonly [name: string]: readonly ConversationMessage[] };
    const entries = Object.entries(inputs);
    const names = entries.map(([name]) => name);
    await onFakeHost(temporary, scripted(Object.fromEntries(names.map((name) => [name, [calls(WAIT), DONE]]))), async (run) => {
      const { host } = run;
      const loops = await parents(run, names);
      const firsts = await Promise.all(loops.map((agent) => agent.request()));
      for (const [index, agent] of loops.entries()) {
        agent.result(ids(firsts[index]!)[0] ?? "", ACK);
        agent.history.push(...entries[index]![1]);
      }
      const seconds = await Promise.all(loops.map((agent) => agent.request()));
      expect(seconds.map((result) => result.error)).toEqual(names.map(() => undefined));
      const restarts = diagnostics.payloads("provider.claude_sdk.host.agent_dispatched").filter((payload) => payload["plan"] === "start" && payload["trigger"] !== "first-request");
      expect(restarts.map((payload) => payload["trigger"])).toEqual(names.map(() => "results-with-input"));
      expect(loops.map(wrappers)).toEqual(names.map(() => 2));
      expect(dispatchedIds(host.requests)).toHaveLength(names.length * 2);
    }, { seams: { agentHosts } });
  }, 180_000);
});

describe("the work of runtime notices", () => {
  test("two hosted parents of one tree that each read three notices run in one engine, and the dispatcher sends only their starts", async () => {
    registry = createHostRegistry();
    let launches = 0;
    const waiting = [calls(WAIT), calls(WAIT), calls(WAIT), DONE];
    await onFakeHost(temporary, scripted({ one: waiting, two: waiting }), async (run) => {
      const { host } = run;
      const loops = await parents(run, ["one", "two"]);
      let results = await Promise.all(loops.map((agent) => agent.request()));
      for (let round = 0; round < 3; round += 1) {
        for (const [index, agent] of loops.entries()) {
          agent.result(ids(results[index]!)[0] ?? "", ACK);
          notice(agent, completion(`${index}-${round}`));
        }
        results = await Promise.all(loops.map((agent) => agent.request()));
        expect(results.map((result) => result.error)).toEqual([undefined, undefined]);
      }
      expect(launches).toBe(1);
      expect(dispatchedIds(host.requests)).toHaveLength(2);
      expect(results.map((result) => folds(result).length)).toEqual([3, 3]);
    }, { seams: { agentHosts, createHostLauncher: (config) => { const launch = createHostLauncher(config); return (input) => { launches += 1; return launch(input); }; } } });
  }, 180_000);
});
