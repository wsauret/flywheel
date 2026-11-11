/**
 * Conformance of the Agent SDK route on the engine that ships with Flywheel. Each case drives the production client,
 * the bridge, and the bundled engine against the fake host, and compares the request that reaches the host with the
 * request that the native Anthropic route prepares from the same canonical history (`prepareAnthropicRequest`). The
 * history of both routes carries the shared Claude reminders that the agent loop appends before each request
 * (agent-loop-history.ts). The comparison leaves out only what differs by design and the request audit names
 * (engine-additions.ts): the reminders, which the engine writes as its own system messages and `<system-reminder>`
 * blocks; the engine's own cache-mark placement; and the `runtime` MCP prefix of each tool name, which every runtime
 * text that names a tool by its wire name also carries. Every case also counts the host's requests, so a request that
 * Flywheel did not make fails it.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Redacted } from "effect";
import { providerModelInfo } from "../../../../../src/infra/llm/provider-model-info.js";
import type { ToolOutcome } from "../../../../../src/infra/tool-outcome.js";
import { toolResultMessages } from "../../../../../src/orchestration/agent-runtime/agent-state.js";
import { formatSubagentNotificationBatch } from "../../../../../src/orchestration/agent-runtime/background-work-notifications.js";
import { CONTINUATION_MESSAGES } from "../../../../../src/orchestration/agent-runtime/continuation-messages.js";
import { createAnthropicAdapter, prepareAnthropicRequest } from "../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import { createClaudeReminders } from "../../../../../src/orchestration/agent-runtime/llm/runtime-reminders.js";
import { interruptedToolText } from "../../../../../src/orchestration/agent-runtime/llm/heal-messages.js";
import type { ConversationMessage, ProviderStreamEvent, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { SILENT_REPLY_NUDGE } from "../../../../../src/orchestration/agent-runtime/reply-nudge.js";
import { formatRuntimeNotification } from "../../../../../src/orchestration/agent-runtime/runtime-notifications.js";
import { createHandoffTool } from "../../../../../src/orchestration/agent-runtime/tools/handoff.js";
import { formatWaitNoopNotification } from "../../../../../src/orchestration/agent-runtime/tools/process.js";
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import type { ClaudeAgentSdkSeams } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-launch.js";
import { createQueryLauncher, type LaunchedQuery } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { handoffToolSchemaFromOutput } from "../../../../../src/orchestration/workflow-host/handoff-tool-schema.js";
import { handoffNudge } from "../../../../../src/workflows/shared/handoff-observer.js";
import { compileOutput } from "../../../../../src/workflows/output-contract/compile.js";
import type { OutputObject } from "../../../../../src/workflows/output-contract/grammar.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { makeContext } from "../../../../unit/orchestration/agent-runtime/tools/_fixtures.js";
import { assistantMessage, captureDiagnostics, onFakeHost, removeEngineProbes, streamedText, streamedToolCalls, until, type FakeHostOptions, type FakeHostRun, type StreamResult } from "./_claude-sdk-client.js";
import { CREDENTIAL_BETAS, nativeBetasOnFakeHost, type FakeBlock, type FakeHost, type FakeReply, type RecordedRequest } from "./_fake-host.js";
import { SHELL_CAPABILITIES } from "../../../../helpers/prompt-capabilities.js";

const temporary = temporaryDirectories();
const { payloads } = captureDiagnostics();
removeEngineProbes();

const MODEL = "claude-sonnet-5-5";
const CONTEXT_LIMIT = 200_000;
const INFO = providerModelInfo({ provider: "anthropic", id: MODEL, contextLimit: CONTEXT_LIMIT, outputLimit: 64_000, reasoning: true });
const SYSTEM = { stable: "Stable prompt.", session: "Session tail.", conversation: "" };

function tool(name: string, properties: readonly string[]) {
  return { name, description: `The ${name} tool.`, input_schema: { type: "object", properties: Object.fromEntries(properties.map((property) => [property, { type: "string" }])) } };
}
const TOOLS = [tool("bash", ["command"]), tool("process", ["action"]), tool("handoff", ["summary"]), tool("message_session", ["to", "text"]), tool("read", ["path"])];

const human = (content: string): ConversationMessage => ({ kind: "user", origin: "human", content });
/** A message that the runtime pushes as user-role input: a nudge or a notification. */
const runtime = (content: string): ConversationMessage => ({ kind: "user", origin: "system", content });
/** A message from another session, in its session-message envelope. */
const fromSession = (content: string, relation: "sibling" | "parent" | "other"): ConversationMessage => ({
  kind: "user", content,
  producer: { kind: "session", sessionId: "ses_peer", conversationId: "conv_peer", toolUseId: "toolu_peer", hop: 1, envelope: { name: "peer \"seven\"", relation, waits: false, personWords: "tell the peer" } },
});
/** The durable turn-interruption record. It is display-only and never reaches a provider. */
const TURN_END: ConversationMessage = { kind: "system", content: "Interrupted by the person.", displayOnly: true };
const U1 = human("Start the task: µ ﬁ.");
const U2 = human("Stop, do X instead.");

type ToolCalls = ReturnType<typeof streamedToolCalls>;
/** The results of a batch's calls, in call order, as the loop records them. A result without text has no content. */
function results(calls: ToolCalls, outcomes: ReadonlyArray<readonly [text: string | undefined, outcome: ToolOutcome]>): ConversationMessage[] {
  return toolResultMessages(outcomes.map(([text, outcome], index) => ({
    toolUseId: calls[index]?.id ?? "", outcome, content: text === undefined ? [] : [{ type: "text", text }],
  })));
}

function request(messages: ConversationMessage[], extra: Partial<StreamOptions> = {}): StreamOptions {
  return { messages, tools: TOOLS, systemPrompt: SYSTEM, ...extra };
}

const REMINDERS = createClaudeReminders(MODEL, CONTEXT_LIMIT);
/** The history with the reminders that the agent loop appends to it before a request, on both Anthropic routes. */
function reminded(history: readonly ConversationMessage[], projectRoot: string): ConversationMessage[] {
  return [...history, ...REMINDERS(history, projectRoot, SHELL_CAPABILITIES)];
}

/** The request that the native Anthropic API route prepares for the same conversation. On that route the native
 *  route served each answer, so each answer carries its stamp and replays as the provider's own. */
function nativeBody(options: StreamOptions, model = MODEL) {
  const messages = options.messages.map((message) => message.kind === "assistant" && message.accessProvider !== undefined ? { ...message, accessProvider: "anthropic_api" } : message);
  const info = model === MODEL ? INFO : providerModelInfo({ provider: "anthropic", id: model, contextLimit: CONTEXT_LIMIT, outputLimit: 64_000, reasoning: true });
  return prepareAnthropicRequest({ accessProvider: "anthropic_api", model, wireModel: model, info, contextLimit: CONTEXT_LIMIT, options: { ...options, messages } });
}

/** Streams one request through the native Anthropic API adapter against the fake host, with a placeholder key. */
async function nativeStream(host: FakeHost, options: StreamOptions): Promise<StreamResult> {
  const client = await createAnthropicAdapter(Redacted.make("sk-ant-api03-qualification-placeholder"), MODEL, INFO, { baseURL: host.url });
  const events: ProviderStreamEvent[] = [];
  try {
    for await (const event of client.streamWithTools(options)) events.push(event);
    return { events, error: undefined };
  } catch (error) {
    return { events, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

type WireValue = { readonly [field: string]: unknown };
function isWireValue(value: unknown): value is WireValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function wireArray(value: unknown): readonly WireValue[] {
  if (!Array.isArray(value)) throw new Error("expected an array of wire objects");
  return value.filter(isWireValue);
}

/** One block without its cache mark. */
function unmarked({ cache_control: _mark, ...block }: WireValue): WireValue {
  return block["type"] === "tool_result" && Array.isArray(block["content"]) ? { ...block, content: wireArray(block["content"]).map(unmarked) } : block;
}

/** A wire value with every tool name in it, and every runtime text that names a tool, without the MCP prefix. */
function unprefixed(value: readonly WireValue[]): readonly WireValue[] {
  return wireArray(JSON.parse(JSON.stringify(value).replaceAll("mcp__runtime__", "")));
}

/** Whether a block is a `<system-reminder>` block: on the native route one of the shared Claude reminders, the
 *  only Flywheel text in that form, and on the SDK route the engine's own copy of one, or its account-email reminder.
 *  Decision D1 owns their difference. A reminder inside a tool result is not one of these blocks, so it still fails. */
function engineReminder(block: WireValue): boolean {
  return block["type"] === "text" && typeof block["text"] === "string" && block["text"].startsWith("<system-reminder>");
}

/** The conversation of a request body as the model reads it, without the engine's additions. */
function conversation(body: WireValue | undefined): readonly WireValue[] {
  return unprefixed(wireArray(body?.["messages"]).flatMap((message) => message["role"] === "system" ? [] : [{
    role: message["role"],
    content: wireArray(message["content"]).flatMap((block) => engineReminder(block) ? [] : [unmarked(block)]),
  }]));
}

/** Where a request states its effort: the top-level field, and each copy on a system message with the number of
 *  conversation messages before it. The engine's system messages also hold its own reminders (decision D1). */
function effortStatements(body: WireValue | undefined) {
  const messages = wireArray(body?.["messages"]);
  return {
    top: body?.["output_config"],
    copies: messages.flatMap((message, index) => message["role"] === "system" && message["output_config"] !== undefined
      ? [{ after: messages.slice(0, index).filter((earlier) => earlier["role"] !== "system").length, output_config: message["output_config"] }]
      : []),
  };
}

/** The messages of a request body with only the cache marks removed: the bytes that a prompt cache compares. */
function cachedBytes(body: WireValue | undefined): readonly WireValue[] {
  return wireArray(body?.["messages"]).map(({ cache_control: _mark, ...message }) => Array.isArray(message["content"]) ? { ...message, content: wireArray(message["content"]).map(unmarked) } : message);
}

function systemTexts(sent: RecordedRequest | undefined): readonly unknown[] {
  return wireArray(sent?.body["system"]).map((block) => block["text"]);
}

/** The gate of an engine version that passed its in-place self-test, which engine-wire.test.ts proves, so that the
 *  bridge chooses between a reload and a new engine as it does in production. A case needs no self-test engine. */
const SELF_TESTED: ClaudeAgentSdkSeams["inPlaceGate"] = () => ({ status: () => Effect.succeed("ready") });

function onHost(reply: (request: RecordedRequest, index: number) => FakeReply, use: (run: FakeHostRun) => Promise<void>, options: FakeHostOptions = {}): Promise<void> {
  return onFakeHost(temporary, reply, use, { model: MODEL, contextLimit: CONTEXT_LIMIT, ...options, seams: { inPlaceGate: SELF_TESTED, ...options.seams } });
}

/** A launcher that keeps each query that it launches. */
function launchedQueries() {
  const launched: LaunchedQuery[] = [];
  const createLauncher: ClaudeAgentSdkSeams["createLauncher"] = (config) => {
    const launch = createQueryLauncher(config);
    return (query) => {
      const started = launch(query);
      launched.push(started);
      return started;
    };
  };
  return { launched, createLauncher };
}

/** Answers the first request with `first` and every later one with a short text. */
const scripted = (first: FakeReply) => (_: RecordedRequest, index: number): FakeReply => index === 0 ? first : { blocks: [{ text: "ok" }] };

const BATCH: FakeReply = { blocks: [{ text: "Working on it." }, { tool: "bash", input: { command: "sleep 2" } }, { tool: "process", input: { action: "wait" } }] };
const BATCH_RESULTS = (calls: ToolCalls) => results(calls, [["RESULT-T1 line\n", "ok"], ["Waiting on 1 background task.", "ok"]]);
const ANSWER: FakeReply = { blocks: [{ text: "Done with step one." }] };
const SUBAGENT_DONE = formatSubagentNotificationBatch([{
  meta: { type: "subagent", description: "Read the README <and> summarize µ ﬁ", toolUseId: "toolu_SUB1", sessionId: "ses_child1" },
  result: { status: "completed", content: "The README says: build with `bun run build` & test." },
}], 0);
const WAIT_EXPIRED = formatRuntimeNotification({
  tag: "wait_expired",
  fields: [["seconds", "5"], ["pending", "1"], ["processes", JSON.stringify([{ id: "proc_1", kind: "command", elapsed_seconds: 5 }])]],
  handling: "This wait expired once. Expiry does not stop managed work. To wait again, call process(action='wait') with a fresh remaining-work estimate in soft_timeout seconds.",
});
// The loop writes this text inline (agent-loop.ts); the cases need only its shape.
const MANAGED_WORK_PENDING = "Managed work is still pending. To wait, call process(action='wait') with soft_timeout seconds from a fresh remaining-work estimate.";
const REPETITION_NOTICE = formatRuntimeNotification({
  tag: "repetition_notice",
  handling: "The same tool call has repeated 3 or more times with the same input. Do not repeat it again: try a different approach.",
});

/** One input that the runtime adds after a model answer, and the rows whose framing it proves. */
interface FramingCase {
  readonly name: string;
  readonly answer: FakeReply;
  readonly tail: (calls: ToolCalls) => ConversationMessage[];
}

// Bridge rule 11: every tail reaches the engine as one pushed user message, never under the engine's "next" wrapper.
const FRAMING: readonly FramingCase[] = [
  // INPUT.session-message-framing
  { name: "a session message after a tool batch", answer: BATCH, tail: (calls) => [...BATCH_RESULTS(calls), fromSession("Heads up: I changed src/a.ts <fyi>", "sibling")] },
  // INPUT.held-session-message, idle and parked on a wait
  { name: "a held session message before the person's next words", answer: ANSWER, tail: () => [fromSession("Held peer note", "other"), human("Next step.")] },
  { name: "a held session message after a wait batch", answer: BATCH, tail: (calls) => [...BATCH_RESULTS(calls), fromSession("Held peer note", "other"), human("Next step.")] },
  // LOOP.nudge.handoff, after an answer and after a wait batch
  { name: "the handoff nudge after an answer", answer: ANSWER, tail: () => [runtime(handoffNudge(true))] },
  { name: "the handoff nudge after a wait batch", answer: BATCH, tail: (calls) => [...BATCH_RESULTS(calls), runtime(handoffNudge(true))] },
  // LOOP.nudge.managed-work-pending
  { name: "the managed-work nudge after a handoff", answer: { blocks: [{ text: "Handing off." }, { tool: "handoff", input: { summary: "done" } }] }, tail: (calls) => [...results(calls, [["Handoff recorded.", "ok"]]), runtime(MANAGED_WORK_PENDING)] },
  // LOOP.nudge.turn-end-observers
  { name: "a batch observer's notice after a wait batch", answer: BATCH, tail: (calls) => [...BATCH_RESULTS(calls), runtime(REPETITION_NOTICE)] },
  // LOOP.reply.silent-reply-nudge, after an answer and after a wait batch
  { name: "the silent-reply nudge after an answer", answer: ANSWER, tail: () => [runtime(SILENT_REPLY_NUDGE)] },
  { name: "the silent-reply nudge after a wait batch", answer: BATCH, tail: (calls) => [...BATCH_RESULTS(calls), runtime(SILENT_REPLY_NUDGE)] },
  // LOOP.wait.expired
  { name: "an expired wait", answer: BATCH, tail: (calls) => [...BATCH_RESULTS(calls), runtime(WAIT_EXPIRED)] },
  // LOOP.wait.noop-notification
  { name: "a wait with nothing pending", answer: BATCH, tail: (calls) => [...BATCH_RESULTS(calls), runtime(formatWaitNoopNotification())] },
  // TOOL.message_session.wait
  { name: "the reply to a waiting message_session call", answer: { blocks: [{ tool: "message_session", input: { to: "parent", text: "Which option?" } }] }, tail: (calls) => [...results(calls, [["Sent. Waiting for the reply.", "ok"]]), fromSession("Use the second option.", "parent")] },
  // TOOL.process.wait
  { name: "the completion that wakes a process wait", answer: BATCH, tail: (calls) => [...BATCH_RESULTS(calls), runtime(SUBAGENT_DONE)] },
  // Two inputs in one tail, in their order.
  { name: "the person's words and a completion in one tail", answer: BATCH, tail: (calls) => [...BATCH_RESULTS(calls), human("Also check the README."), runtime(SUBAGENT_DONE)] },
];

/** Runs the first request, then the request with `tail`, and returns the engine's second request. */
async function secondRequest({ host, open, projectRoot }: FakeHostRun, tail: (calls: ToolCalls) => ConversationMessage[], extra: Partial<StreamOptions> = {}, model = MODEL) {
  const chat = await open();
  const opening = reminded([U1], projectRoot);
  const first = await chat.stream(request(opening, extra));
  expect(first.error).toBeUndefined();
  const messages = reminded([...opening, assistantMessage(first), ...tail(streamedToolCalls(first))], projectRoot);
  const second = await chat.stream(request(messages, extra));
  expect(second.error).toBeUndefined();
  expect(host.requests).toHaveLength(2);
  return { sent: host.requests[1], native: nativeBody(request(messages, extra), model), first };
}

describe("the shipped engine sends what the native Anthropic route sends", () => {
  for (const framing of FRAMING) {
    test(`${framing.name} reaches the model in the native framing`, async () => {
      await onHost(scripted(framing.answer), async (run) => {
        const { sent, native } = await secondRequest(run, framing.tail);
        expect(conversation(sent?.body)).toEqual(conversation(native.params));
      });
    }, 60_000);
  }

  // INTERRUPT.during-stream and LOOP.resume.person-resume
  const interrupts: ReadonlyArray<readonly [name: string, partial: readonly FakeBlock[], cutAt: "text_delta" | "tool_input_delta", next: ConversationMessage]> = [
    ["text", [{ text: "PARTIAL-ALPHA-BRAVO" }], "text_delta", U2],
    ["tool input", [{ text: "Calling the tool." }, { tool: "bash", input: { command: "ls" } }], "tool_input_delta", U2],
    ["text, then a Resume", [{ text: "PARTIAL-ALPHA-BRAVO" }], "text_delta", runtime(CONTINUATION_MESSAGES.resumed)],
  ];
  for (const [name, partial, cutAt, next] of interrupts) {
    test(`an interrupt during streamed ${name} sends nothing more, and the next request carries Flywheel's partial answer`, async () => {
      await onHost(scripted({ blocks: partial, open: true }), async ({ host, open, projectRoot }) => {
        const chat = await open();
        const interrupt = new AbortController();
        const opening = reminded([U1], projectRoot);
        const first = await chat.stream({ ...request(opening), signal: interrupt.signal }, (event) => { if (event.kind === cutAt) interrupt.abort(); });
        expect(first.events.some((event) => event.kind === "done")).toBe(false);
        // The loop commits what streamed as an incomplete answer, then the display-only turn-end record.
        expect(streamedText(first)).toBe(partial[0] !== undefined && "text" in partial[0] ? partial[0].text : "");
        const answer: ConversationMessage = { ...assistantMessage(first), incomplete: true };
        const messages = reminded([...opening, answer, TURN_END, next], projectRoot);
        const second = await chat.stream(request(messages));

        expect(second.error).toBeUndefined();
        expect(payloads("provider.claude_sdk.query.stopped")).toEqual([expect.objectContaining({ poisoned: true })]);
        expect(host.requests).toHaveLength(2);
        expect(conversation(host.requests[1]?.body)).toEqual(conversation(nativeBody(request(messages)).params));
      });
    }, 60_000);
  }

  // INTERRUPT.during-tools
  test("an interrupt while tools run reaches the model with Flywheel's tombstones and the person's words", async () => {
    await onHost(scripted(BATCH), async (run) => {
      const { sent, native } = await secondRequest(run, (calls) => [
        ...results(calls, [[interruptedToolText("bash"), "interrupted"], ["Tool 'process' was interrupted because the user typed a new message. Address the user's input first.", "interrupted"]]),
        TURN_END, U2,
      ]);
      expect(conversation(sent?.body)).toEqual(conversation(native.params));
    });
  }, 60_000);

  // TOOL.result.empty: bridge rule 2 rotates each result that a handler cannot deliver unchanged.
  const emptyResults: ReadonlyArray<readonly [name: string, outcomes: ReadonlyArray<readonly [string | undefined, ToolOutcome]>]> = [
    ["an empty result beside a text result", [[undefined, "ok"], ["x", "ok"]]],
    ["an empty result and an empty error", [[undefined, "ok"], [undefined, "error"]]],
    ["a blank result and a blank error", [["   ", "ok"], ["", "error"]]],
  ];
  for (const [name, outcomes] of emptyResults) {
    test(`a batch with ${name} reaches the model as native sends it`, async () => {
      await onHost(scripted(BATCH), async (run) => {
        const { sent, native } = await secondRequest(run, (calls) => results(calls, outcomes));
        expect(conversation(sent?.body)).toEqual(conversation(native.params));
      });
    }, 60_000);
  }

  // TOOL.result.text
  const texts: ReadonlyArray<readonly [name: string, parts: ReadonlyArray<{ readonly type: "text"; readonly text: string }>]> = [
    ["compatibility characters, a lone surrogate, and a blank part", [{ type: "text", text: "µ ﬁ lone:\ud800 end" }, { type: "text", text: "   " }, { type: "text", text: "second" }]],
    ["a trailing newline", [{ type: "text", text: "line one\n" }]],
    ["zero-width, bidi, byte-order, and private-use characters", [{ type: "text", text: "a\u200bb\u202ec\ufeffd\ue000e\u2066f\u2069g" }]],
  ];
  for (const [name, parts] of texts) {
    test(`a result with ${name} reaches the model with the native bytes`, async () => {
      await onHost(scripted({ blocks: [{ tool: "read", input: { path: "note.txt" } }] }), async (run) => {
        const { sent, native } = await secondRequest(run, (calls) => toolResultMessages([{ toolUseId: calls[0]?.id ?? "", outcome: "ok", content: [...parts] }]));
        expect(conversation(sent?.body)).toEqual(conversation(native.params));
      });
    }, 60_000);
  }

  // THINK.display
  for (const display of ["summarized", "omitted", "updates"] as const) {
    test(`thinking display ${display} reaches the wire with the native thinking field and betas`, async () => {
      await onHost(() => ({ blocks: [{ text: "ok" }] }), async ({ host, open, projectRoot }) => {
        const options = request(reminded([U1], projectRoot), { reasoningEffort: "medium", providerOptions: { anthropic: { thinking_display: display } } });
        expect((await (await open()).stream(options)).error).toBeUndefined();
        const native = nativeBody(options);
        const [sent] = host.requests;
        expect(sent?.body["thinking"]).toEqual(native.params.thinking);
        expect(sent?.betas.filter((beta) => !CREDENTIAL_BETAS.has(beta))).toEqual(nativeBetasOnFakeHost(native.betaHeader, MODEL));
      });
    }, 60_000);
  }

  // TOOL.input.name-repair-and-undeclared: toolAliases hand a bare declared name to its handler; the engine answers
  // any other name itself, and the bridge stops the query at the stop reason before the engine sends again.
  const names: ReadonlyArray<readonly [name: string, block: FakeBlock, answer: readonly [string, ToolOutcome]]> = [
    ["a declared tool's bare name", { tool: "read", input: { path: "note.txt" }, bare: true }, ["The scratch word is marigold.", "ok"]],
    ["an undeclared near-miss name", { tool: "Read", input: { path: "note.txt" } }, ["Unknown tool Read. Did you mean read?", "error"]],
  ];
  for (const [name, block, answer] of names) {
    test(`a call by ${name} reaches Flywheel, and the engine sends no request of its own`, async () => {
      await onHost(scripted({ blocks: [block] }), async (run) => {
        const { sent, native, first } = await secondRequest(run, (calls) => results(calls, [answer]));
        expect(streamedToolCalls(first)).toEqual([{ id: expect.any(String), name: "tool" in block ? block.tool : "", input: { path: "note.txt" } }]);
        expect(conversation(sent?.body)).toEqual(conversation(native.params));
      });
    }, 60_000);
  }

  // TOOL.execution.native-dispatch
  test("each call reaches Flywheel once, and its handler returns Flywheel's result unchanged", async () => {
    await onHost(scripted({ blocks: [{ tool: "bash", input: { command: "ls" } }, { tool: "read", input: { path: "note.txt" } }] }), async (run) => {
      const { sent, native, first } = await secondRequest(run, (calls) => results(calls, [["a.ts\nb.ts", "ok"], ["The scratch word is marigold.", "ok"]]));
      const calls = streamedToolCalls(first);
      expect(calls.map(({ name }) => name)).toEqual(["bash", "read"]);
      expect(new Set(calls.map(({ id }) => id)).size).toBe(2);
      // The parked handlers took both results, so one engine served both requests.
      expect(payloads("provider.claude_sdk.query.started")).toHaveLength(1);
      expect(conversation(sent?.body)).toEqual(conversation(native.params));
    });
  }, 60_000);

  // SYS.no-foreign-system-prompt-requests
  test("a new system prompt reaches the live engine in place, and every request carries Flywheel's prompt", async () => {
    const changed = { stable: "A changed stable prompt.", session: "", conversation: "" };
    // The history holds no reminder, so the reload replays the opening row and runs set_model at once. A replayed
    // reminder would send the rotation cold, which runs no set_model.
    await onHost(() => ({ blocks: [{ text: "ok" }] }), async ({ host, open }) => {
      const chat = await open();
      const first = await chat.stream(request([U1]));
      const second = await chat.stream({ ...request([U1, assistantMessage(first), U2]), systemPrompt: changed });
      expect(second.error).toBeUndefined();
      expect(payloads("provider.claude_sdk.query.reloaded")).toEqual([expect.objectContaining({ trigger: "identity", systemPrompt: true })]);
      // set_model with the query's own model sends no model check: ANTHROPIC_CUSTOM_MODEL_OPTION names it.
      expect(host.requests.map((sent) => systemTexts(sent).at(-1))).toEqual([`${SYSTEM.stable}\n\n${SYSTEM.session}`, changed.stable]);
    });
  }, 60_000);

  // FACTORY.no-spawn-without-request
  test("a client starts no engine before its request, and the end of its lifetime leaves none after it", async () => {
    const { launched, createLauncher } = launchedQueries();
    await onHost(() => ({ blocks: [{ text: "ok" }] }), async ({ host, stage, projectRoot }) => {
      const client = await stage();
      expect(client.staged.attempt.contextLimit).toBe(CONTEXT_LIMIT);
      const chat = await client.connect();
      expect(launched).toEqual([]);
      expect((await chat.stream(request(reminded([U1], projectRoot)))).error).toBeUndefined();
      expect(launched).toHaveLength(1);
      await client.replace();
      expect(await launched[0]?.process.exited()).toBeDefined();
      expect(host.requests).toHaveLength(1);
    }, { seams: { createLauncher } });
  }, 60_000);

  // FACTORY.reserved-engine-end: the engine's SDK reader runs from its launch, so the bridge hears a reserved engine
  // end the moment it ends, and no request takes an engine that has ended.
  test("a reserved engine that ends ends its reservation, and the next anticipation starts a new engine that serves the request", async () => {
    const { launched, createLauncher } = launchedQueries();
    await onHost(() => ({ blocks: [{ text: "ok" }] }), async ({ host, open, projectRoot }) => {
      const chat = await open();
      const options = request(reminded([U1], projectRoot));
      expect(await chat.anticipate(options)).toBeDefined();
      await launched[0]?.process.terminate();
      await until(() => payloads("provider.claude_sdk.engine.reservation_ended").length === 1, "the reservation's end");
      expect(payloads("provider.claude_sdk.engine.reservation_ended")).toEqual([expect.objectContaining({ rule: "engine-ended" })]);

      expect(await chat.anticipate(options)).toBeDefined();
      expect(launched).toHaveLength(2);
      expect((await chat.stream(options)).error).toBeUndefined();
      expect(launched).toHaveLength(2);
      expect(host.requests).toHaveLength(1);
      expect(payloads("provider.claude_sdk.query.started")).toEqual([expect.objectContaining({ engine: "reserved" })]);
    }, { seams: { createLauncher } });
  }, 60_000);

  // TOOL.surface.nfkc-user-authored: both routes send each definition in the engine's text form, and the dispatcher
  // reads a key or value that the model wrote in that form as the declared one.
  test("a tool definition with format characters reaches the model as native sends it, and a handoff in its form runs", async () => {
    const output = {
      summary: "What was done.",
      fields: {
        "ver\u200Bdict": { type: "enum", values: ["pass\u2066ed\u2069", "failed"], description: "The verdict\uFEFF of the µs check \u202Enow\u202C\uE000." },
      },
    } as const satisfies OutputObject;
    const handoff = createHandoffTool({ schema: handoffToolSchemaFromOutput(compileOutput(output)) });
    const tools = [
      { name: "handoff", description: "Submit the step output. Ｗｒｉｔｅ ﬁelds.", input_schema: handoff.inputSchema },
      tool("read", ["path"]),
    ];
    const call: FakeReply = { blocks: [{ tool: "handoff", input: { summary: "done", verdict: "passed" } }] };
    await onHost(() => call, async ({ host, open, projectRoot }) => {
      const options = { ...request(reminded([U1], projectRoot)), tools };
      const routes = [await (await open()).stream(options), await nativeStream(host, options)];
      expect(routes.map(({ error }) => error)).toEqual([undefined, undefined]);
      expect(host.requests).toHaveLength(2);
      const [sdk, native] = host.requests.map((sent) => unprefixed(wireArray(sent.body["tools"]).map(unmarked)));
      expect(sdk).toEqual(native);
      // Every handoff shows one generic schema, so the step's own fields reach the model only through its task text.
      expect(JSON.stringify(native)).toContain('"description":"Submit the step output. Write fields."');

      for (const route of routes) {
        const captured: unknown[] = [];
        const [handoffCall] = streamedToolCalls(route);
        const prepared = prepareToolCall({ id: handoffCall?.id ?? "", name: handoffCall?.name ?? "", input: { summary: "done", verdict: "passed" } }, new Map([["handoff", handoff]]));
        const result = await executePreparedTool(prepared, makeContext({ handoff: { onContent: (content) => { captured.push(content); } } }));
        expect(handoffCall?.input).toEqual({ summary: "done", verdict: "passed" });
        expect(result.outcome).toBe("ok");
        expect(captured).toEqual([{ summary: "done", "ver\u200Bdict": "pass\u2066ed\u2069" }]);
      }
    });
  }, 60_000);

  // MODEL.per-request-selection (decision D6): on a per-turn-effort model both routes copy the request's effort to a
  // system message after the first user run; on any other model neither route copies it. Both routes also send the
  // same thinking and context management, so effort off reaches the service as native sends it: Haiku 5.5 with thinking
  // disabled and Fable 5.2 with none, and neither with the thinking cleanup that the service refuses without thinking.
  // Each request states its thinking display, because the default differs by access provider for Fable
  // (`anthropicThinkingDisplay`), and `nativeBody` prepares the API key route's request; the display has its own case.
  // Fable 5.3 is a version that neither Flywheel nor the engine knows: it inherits Fable 5.2's settings, and the engine
  // gets its per-turn capabilities from its launch (`engineModelCapabilities`).
  const efforts = [undefined, "off", "low", "medium", "high", "xhigh", "max"] as const;
  for (const model of [MODEL, "claude-opus-4-6", "claude-haiku-5-5", "claude-fable-5-2", "claude-fable-5-3"]) {
    for (const effort of efforts) {
      test(`${model} at effort ${effort ?? "unset"} states the effort where native does`, async () => {
        await onHost(scripted(BATCH), async (run) => {
          const display = { providerOptions: { anthropic: { thinking_display: "summarized" } } } as const;
          const extra = effort === undefined ? display : { ...display, reasoningEffort: effort };
          const { sent, native } = await secondRequest(run, (calls) => [...BATCH_RESULTS(calls), U2], extra, model);
          const first = nativeBody(request(reminded([U1], run.projectRoot), extra), model);
          for (const [recorded, prepared] of [[run.host.requests[0], first], [sent, native]] as const) {
            expect(effortStatements(recorded?.body)).toEqual(effortStatements(prepared.params));
            expect({ thinking: recorded?.body["thinking"], context_management: recorded?.body["context_management"] })
              .toEqual({ thinking: prepared.params.thinking, context_management: prepared.params["context_management"] });
            expect(recorded?.betas.filter((beta) => !CREDENTIAL_BETAS.has(beta))).toEqual(nativeBetasOnFakeHost(prepared.betaHeader, model));
          }
          expect(conversation(sent?.body)).toEqual(conversation(native.params));
        }, { model });
      }, 60_000);
    }
  }

  test("an effort change starts a new engine, and each request states its effort where native does", async () => {
    await onHost(() => ({ blocks: [{ text: "ok" }] }), async ({ host, open, projectRoot }) => {
      const chat = await open();
      let history = reminded([U1], projectRoot);
      for (const [index, effort] of (["low", "high", "high", "medium"] as const).entries()) {
        const options = request(history, { reasoningEffort: effort });
        const answer = await chat.stream(options);
        expect(answer.error).toBeUndefined();
        expect(effortStatements(host.requests[index]?.body)).toEqual(effortStatements(nativeBody(options).params));
        expect(conversation(host.requests[index]?.body)).toEqual(conversation(nativeBody(options).params));
        history = reminded([...history, assistantMessage(answer), human(`Turn ${index + 2}.`)], projectRoot);
      }
      expect(host.requests).toHaveLength(4);
      expect(payloads("provider.claude_sdk.query.started")).toMatchObject([{ trigger: "first-request" }, { trigger: "identity", field: "effort" }, { trigger: "identity", field: "effort" }]);
    });
  }, 90_000);

  // CALLER.chat-learning-review and WF.learning-review-restrictions
  test("a review fork replays the parent's request bytes, and a denied call's result reaches the model as native sends it", async () => {
    const instruction = human("Review this session for durable lessons.");
    const reply = (_: RecordedRequest, index: number): FakeReply => index === 2 ? { blocks: [{ tool: "bash", input: { command: "ls" } }] } : { blocks: [{ text: `Answer ${index + 1}.` }] };
    await onHost(reply, async ({ host, open, projectRoot }) => {
      const chat = await open();
      const opening = reminded([U1], projectRoot);
      const a1 = await chat.stream(request(opening));
      const parentMessages = reminded([...opening, assistantMessage(a1), U2], projectRoot);
      const a2 = await chat.stream(request(parentMessages));
      const review = await open();
      const replay = reminded([...parentMessages, assistantMessage(a2), instruction], projectRoot);
      const r1 = await review.stream(request(replay));
      expect([a1.error, a2.error, r1.error]).toEqual([undefined, undefined, undefined]);

      const [, parent, fork] = host.requests;
      expect(systemTexts(fork)).toEqual(systemTexts(parent));
      expect(fork?.body["tools"]).toEqual(parent?.body["tools"]);
      expect(cachedBytes(fork?.body).slice(0, cachedBytes(parent?.body).length)).toEqual([...cachedBytes(parent?.body)]);

      // The execution whitelist stays in Flywheel's dispatcher, which answers the call with its denial.
      const denied = [...replay, assistantMessage(r1), ...results(streamedToolCalls(r1), [["Background review denied non-whitelisted tool: bash.", "error"]])];
      expect((await review.stream(request(denied))).error).toBeUndefined();
      expect(host.requests).toHaveLength(4);
      expect(conversation(host.requests[3]?.body)).toEqual(conversation(nativeBody(request(denied)).params));
    });
  }, 90_000);
});
