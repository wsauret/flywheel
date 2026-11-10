/**
 * Qualification of the bundled Claude engine on a fake host, the no-cost tier that every engine bump passes on
 * macOS, Linux, and Windows during release readiness. Each case runs the production Agent SDK
 * client and the engine that ships with Flywheel, the copy that `bun install` placed from the lockfile, against a
 * local host on 127.0.0.1 with a placeholder subscription login. A trap proxy refuses every other connection, so
 * nothing leaves the machine and no real login is read.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { providerModelInfo } from "../../../../../src/infra/llm/provider-model-info.js";
import { prepareAnthropicRequest } from "../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import { createClaudeReminders } from "../../../../../src/orchestration/agent-runtime/llm/claude-reminders.js";
import type { ConversationMessage, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { createLauncherScope, createProcessSupervisor } from "../../../../../src/infra/process-supervisor.js";
import { cliLaunch, type ClaudeAgentSdkSeams } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-launch.js";
import { describeCliLogin, readCliUsage } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/query-launcher.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { assistantMessage, captureDiagnostics, onFakeHost, ownInPlaceGate, removeEngineProbes, streamedText, streamedToolCalls, until } from "./_claude-sdk-client.js";
import { CREDENTIAL_BETAS, declaredTools, nativeBetasOnFakeHost, type RecordedRequest } from "./_fake-host.js";
import { SHELL_CAPABILITIES } from "../../../../helpers/prompt-capabilities.js";

const temporary = temporaryDirectories();
const { records, payloads } = captureDiagnostics();
removeEngineProbes();

const READ_TOOL = { name: "read", description: "Reads a file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const SYSTEM = { stable: "Stable prompt.", session: "Session tail.", conversation: "" };
const U1: ConversationMessage = { kind: "user", origin: "human", content: "Read note.txt." };
const U2: ConversationMessage = { kind: "user", origin: "human", content: "Now say done." };

/** The text of every non-system message of a request, so the engine's own reminders and controls do not decide. */
function conversationTexts(request: RecordedRequest): readonly string[] {
  const messages = request.body["messages"];
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: { role?: string; content?: unknown }) => {
    if (message.role === "system" || !Array.isArray(message.content)) return [];
    return message.content.flatMap((block: { type?: string; text?: string; thinking?: string; name?: string }) => {
      if (block.type === "text" && typeof block.text === "string" && !block.text.startsWith("<system-reminder>")) return [`${message.role}: ${block.text}`];
      if (block.type === "thinking") return [`${message.role} thinking: ${block.thinking ?? ""}`];
      if (block.type === "tool_use") return [`${message.role} tool_use: ${block.name ?? ""}`];
      if (block.type === "tool_result") return [`${message.role} tool_result`];
      return [];
    });
  });
}

type WireValue = { readonly [field: string]: unknown };
function wireArray(value: unknown): readonly WireValue[] {
  return Array.isArray(value) ? value.filter((item): item is WireValue => typeof item === "object" && item !== null && !Array.isArray(item)) : [];
}

/** The messages of a request with every cache mark removed, the bytes that a prompt cache compares, with the project
 *  directory named the same in every case. */
function cachedBytes(request: RecordedRequest, projectRoot: string): string {
  // The directory is matched as JSON writes it, because a Windows path holds backslashes, which JSON escapes.
  return JSON.stringify(request.body["messages"], (key, value: unknown) => key === "cache_control" ? undefined : value).replaceAll(JSON.stringify(projectRoot).slice(1, -1), "<project>");
}

describe("the bundled Claude engine on a fake host", () => {
  test("the engine names the login's plan and a Claude model lineup, and sends no model request for them", async () => {
    await onFakeHost(temporary, () => ({ blocks: [] }), async ({ host, configDir, seams }) => {
      const supervisor = createProcessSupervisor();
      const launcher = createLauncherScope(supervisor);
      try {
        const launch = cliLaunch({ type: "external", configDir }, launcher, seams);
        if (launch.kind !== "ready") throw new Error(`no engine launch: ${launch.kind}`);
        const described = await describeCliLogin(launch.config, AbortSignal.timeout(30_000));
        expect(described).toMatchObject({ loggedIn: true, plan: "Claude Max" });
        expect(described.models.map((model) => model.resolvedModel)).toEqual(expect.arrayContaining([expect.stringMatching(/^claude-/u)]));
      } finally {
        await launcher.close();
        await supervisor.dispose();
      }
      expect(host.requests).toEqual([]);
    });
  }, 60_000);

  test("a usage read leaves the login's settings as they were, and a turn after it sends what a turn before it sent", async () => {
    // What a request carries apart from the values that differ for each engine and request: its session and the
    // billing line of the engine's first system block.
    const comparable = (request: RecordedRequest | undefined) => ({
      path: request?.path, headerNames: request?.headerNames, betas: request?.betas,
      body: Object.fromEntries(Object.entries(request?.body ?? {}).filter(([field]) => field !== "metadata").map(([field, value]) => [field, field === "system" && Array.isArray(value) ? value.filter((block: { text?: string }) => !block.text?.startsWith("x-anthropic-billing-header")) : value])),
    });
    await onFakeHost(temporary, () => ({ blocks: [{ text: "ok" }] }), async ({ host, open, configDir, seams }) => {
      const settings = () => readFileSync(join(configDir, ".claude.json"), "utf8");
      const ask = async () => expect((await (await open()).stream({ messages: [U1], tools: [READ_TOOL], systemPrompt: SYSTEM })).error).toBeUndefined();
      const supervisor = createProcessSupervisor();
      const launcher = createLauncherScope(supervisor);
      try {
        const launch = cliLaunch({ type: "external", configDir }, launcher, seams);
        if (launch.kind !== "ready") throw new Error(`no engine launch: ${launch.kind}`);
        const readUsage = async () => expect(await readCliUsage(launch.config, AbortSignal.timeout(30_000))).toMatchObject({ loggedIn: true, plan: "Claude Max" });
        // No engine of the login runs yet, so the usage engine alone could change the file. An engine on the login
        // itself writes its start-up state there even when the fake host serves it no account data.
        const before = settings();
        await readUsage();
        expect(settings()).toBe(before);
        await ask();
        await readUsage();
        await ask();
      } finally {
        await launcher.close();
        await supervisor.dispose();
      }
      expect(host.requests).toHaveLength(2);
      expect(comparable(host.requests[1])).toEqual(comparable(host.requests[0]));
    });
  }, 60_000);

  // With the engine's tool search on, the engine defers MCP tools behind a search stub unless each tool is always
  // loaded, so the third case holds only while every request still declares each tool in full, as native does.
  for (const [model, contextLimit, toolSearch] of [["claude-haiku-5-5", 200_000, false], ["claude-sonnet-5-5", 1_000_000, false], ["claude-haiku-5-5", 200_000, true]] as const) {
    test(`a ${model} request with a ${contextLimit / 1_000}K window${toolSearch ? " and the engine's tool search on" : ""} asks the API for what the native Anthropic route asks`, async () => {
      const options: StreamOptions = { messages: [U1], tools: [READ_TOOL], systemPrompt: SYSTEM, reasoningEffort: "medium" };
      await onFakeHost(temporary, () => ({ blocks: [{ text: "ok" }] }), async ({ host, open }) => {
        const result = await (await open()).stream(options);
        expect(result.error).toBeUndefined();
        const info = providerModelInfo({ provider: "anthropic", id: model, contextLimit, outputLimit: 64_000, reasoning: true });
        const native = prepareAnthropicRequest({ accessProvider: "anthropic_api", model, wireModel: model, info, contextLimit, options });
        const [sdk] = host.requests;
        // The opt-in table of d1e82bf84: the same betas in the same order, apart from the credential betas and the known
        // differences on a fake host (`nativeBetasOnFakeHost`).
        expect(sdk?.betas.filter((beta) => !CREDENTIAL_BETAS.has(beta))).toEqual(nativeBetasOnFakeHost(native.betaHeader, model));
        for (const field of ["model", "max_tokens", "stream", "thinking", "output_config", "context_management"] as const) {
          expect({ field, value: sdk?.body[field] }).toEqual({ field, value: native.params[field] });
        }
        // The native route's tools under the runtime server's prefix, with the same descriptions, schemas, and fields.
        // The engine places its own prompt-cache breakpoints, so only the native route's breakpoint is left out.
        expect(sdk?.body["tools"]).toEqual((native.params.tools ?? []).map(({ cache_control: _breakpoint, ...tool }) => ({ ...tool, name: `mcp__runtime__${tool.name}` })));
        // Flywheel's prompt tiers reach the API as the engine's last system block.
        expect(sdk?.body["system"]).toEqual(expect.arrayContaining([expect.objectContaining({ text: `${SYSTEM.stable}\n\n${SYSTEM.session}` })]));
        // No name that the engine or the bridge chooses carries the product's name.
        expect(JSON.stringify([sdk?.headerNames, declaredTools(sdk?.body ?? {}), sdk?.body["metadata"]]).toLowerCase()).not.toContain("flywheel");
      }, { model, contextLimit, ...(toolSearch ? { environment: { ENABLE_TOOL_SEARCH: "true" } } : {}) });
    }, 60_000);
  }

  test("a tool call reaches Flywheel by its own name and its result goes back to the engine that asked, as one tool round", async () => {
    await onFakeHost(temporary, (_, index) => index === 0 ? { blocks: [{ tool: "read", input: { path: "note.txt" } }] } : { blocks: [{ text: "marigold" }] }, async ({ host, open }) => {
      const chat = await open();
      const first = await chat.stream({ messages: [U1], tools: [READ_TOOL], systemPrompt: SYSTEM });
      expect(streamedToolCalls(first)).toEqual([{ id: expect.any(String), name: "read", input: { path: "note.txt" } }]);
      const call = streamedToolCalls(first)[0];
      const second = await chat.stream({ messages: [U1, assistantMessage(first), { kind: "toolResult", toolUseId: call?.id ?? "", content: [{ type: "text", text: "The scratch word is marigold." }] }], tools: [READ_TOOL], systemPrompt: SYSTEM });

      expect(second.error).toBeUndefined();
      expect(streamedText(second)).toBe("marigold");
      expect(conversationTexts(host.requests[1]!)).toEqual(["user: Read note.txt.", "assistant tool_use: mcp__runtime__read", "user tool_result"]);
      // One engine served the round: the result went through the parked tool handler, not a restart.
      expect(payloads("provider.claude_sdk.query.started")).toHaveLength(1);
    });
  }, 60_000);

  test("the engine's version passes the in-place self-test, and an in-place rotation sends what a cold rotation sends", async () => {
    const edited = (first: ReturnType<typeof assistantMessage>): ConversationMessage => ({ ...first, content: [{ type: "text", text: "An edited answer." }] });
    const rotate = async (seams: ClaudeAgentSdkSeams, waitForSelfTest: boolean) => {
      let second: RecordedRequest | undefined;
      await onFakeHost(temporary, (_, index) => ({ blocks: [{ text: index === 0 ? "A first answer." : "done" }] }), async ({ host, open }) => {
        const chat = await open();
        const first = await chat.stream({ messages: [U1], tools: [READ_TOOL], systemPrompt: SYSTEM });
        if (waitForSelfTest) {
          // The first request starts the self-test of the engine's version, which must be listed and pass.
          await until(() => payloads("provider.claude_sdk.in_place.checked").length > 0, "the in-place self-test");
          expect(payloads("provider.claude_sdk.in_place.checked")).toEqual([expect.objectContaining({ outcome: "passed" })]);
        }
        const rotated = await chat.stream({ messages: [U1, edited(assistantMessage(first)), U2], tools: [READ_TOOL], systemPrompt: SYSTEM });
        expect(rotated.error).toBeUndefined();
        second = host.requests[1];
      }, { seams });
      return second;
    };

    const inPlace = await rotate({ inPlaceGate: ownInPlaceGate() }, true);
    expect(payloads("provider.claude_sdk.query.reloaded")).toEqual([expect.objectContaining({ trigger: "history", cut: true })]);
    expect(payloads("provider.claude_sdk.query.started")).toHaveLength(1);
    records.length = 0;
    const cold = await rotate({ inPlaceGate: () => ({ status: () => Effect.succeed("unlisted") }) }, false);
    expect(payloads("provider.claude_sdk.query.reloaded")).toEqual([]);
    expect(payloads("provider.claude_sdk.query.started")).toEqual([expect.objectContaining({ trigger: "first-request" }), expect.objectContaining({ trigger: "history" })]);

    expect(conversationTexts(inPlace!)).toEqual(["user: Read note.txt.", "assistant: An edited answer.", "user: Now say done."]);
    expect(conversationTexts(cold!)).toEqual(conversationTexts(inPlace!));
  }, 60_000);

  test("a step's rotations cut at its opening row, which holds the reminders, reload in place and send what cold rotations send", async () => {
    const reminders = createClaudeReminders("claude-sonnet-5-5", 200_000);
    const rotate = async (seams: ClaudeAgentSdkSeams) => {
      let bodies: readonly string[] = [];
      await onFakeHost(temporary, (request) => wireArray(request.body["messages"]).filter((message) => message["role"] !== "system").length >= 7
        ? { blocks: [{ text: "done" }] } : { blocks: [{ tool: "read", input: { path: "note.txt" } }] }, async ({ host, open, projectRoot }) => {
        const chat = await open();
        const base = { tools: [READ_TOOL], systemPrompt: SYSTEM, reasoningEffort: "medium" } as const;
        let history: ConversationMessage[] = [U1, ...reminders([U1], projectRoot, SHELL_CAPABILITIES)];
        const first = await chat.stream({ ...base, messages: history });
        // An error result cannot pass through the parked handler, and a result with text beside it cannot either.
        history = [...history, assistantMessage(first), { kind: "toolResult", toolUseId: streamedToolCalls(first)[0]?.id ?? "", content: [{ type: "text", text: "no such file" }], isError: true }];
        const second = await chat.stream({ ...base, messages: history });
        expect(second.error).toBeUndefined();
        history = [...history, assistantMessage(second), { kind: "toolResult", toolUseId: streamedToolCalls(second)[0]?.id ?? "", content: [{ type: "text", text: "contents" }] }, U2];
        expect((await chat.stream({ ...base, messages: history })).error).toBeUndefined();
        bodies = host.requests.map((request) => cachedBytes(request, projectRoot));
      }, { seams, model: "claude-sonnet-5-5" });
      return bodies;
    };

    const inPlace = await rotate({ inPlaceGate: () => ({ status: () => Effect.succeed("ready") }) });
    expect(payloads("provider.claude_sdk.query.reloaded")).toEqual([
      expect.objectContaining({ trigger: "undeliverable-result", opening: true }), expect.objectContaining({ trigger: "results-with-input", opening: true }),
    ]);
    expect(payloads("provider.claude_sdk.query.started")).toHaveLength(1);
    records.length = 0;
    const cold = await rotate({ inPlaceGate: () => ({ status: () => Effect.succeed("unlisted") }) });
    expect(payloads("provider.claude_sdk.query.started")).toHaveLength(3);

    expect(inPlace).toHaveLength(3);
    expect(inPlace).toEqual(cold);
  }, 60_000);

  test("a conversation whose last answer holds only thinking resumes on a new engine and answers", async () => {
    await onFakeHost(temporary, (_, index) => index === 0 ? { blocks: [{ thinking: "Only a thought." }] } : { blocks: [{ text: "ok" }] }, async ({ host, open }) => {
      const first = await (await open()).stream({ messages: [U1], tools: [READ_TOOL], systemPrompt: SYSTEM, reasoningEffort: "medium" });
      expect(first.error).toBeUndefined();
      // A new conversation of the same history starts its engine from a transcript and resumes at that answer.
      const resumed = await (await open()).stream({ messages: [U1, assistantMessage(first), U2], tools: [READ_TOOL], systemPrompt: SYSTEM, reasoningEffort: "medium" });

      expect(resumed.error).toBeUndefined();
      expect(streamedText(resumed)).toBe("ok");
      expect(conversationTexts(host.requests[1]!)).toEqual(["user: Read note.txt.", "assistant thinking: Only a thought.", "user: Now say done."]);
    });
  }, 60_000);

  test("with paid use off, a response that extra usage served stops the account, and no later request reaches the API", async () => {
    const overage = { "anthropic-ratelimit-unified-overage-in-use": "true", "anthropic-ratelimit-unified-overage-status": "allowed" };
    const notices: unknown[] = [];
    await onFakeHost(temporary, (_, index) => index === 0 ? { blocks: [{ text: "included" }] } : { blocks: [{ text: "extra" }], headers: overage }, async ({ host, open }) => {
      const chat = await open();
      const ask = (messages: ConversationMessage[]) => chat.stream({ messages, tools: [READ_TOOL], systemPrompt: SYSTEM });
      const first = await ask([U1]);
      const second = await ask([U1, assistantMessage(first), U2]);
      const third = await ask([U1, assistantMessage(first), U2, assistantMessage(second), { kind: "user", origin: "human", content: "Again." }]);

      expect([first.error, second.error]).toEqual([undefined, undefined]);
      expect(third.error).toMatchObject({ failure: { _tag: "QuotaExhaustedFailure", message: expect.stringContaining("served a request from extra usage") } });
      expect(host.requests).toHaveLength(2);
      expect(payloads("provider.claude_sdk.rate_limit").map((payload) => payload["billing"])).toEqual(["included", "extra-usage"]);
      expect(notices).toEqual([expect.objectContaining({ type: "raise", occurrence: expect.objectContaining({ title: "Claude extra usage stopped" }) })]);
    }, { build: { notify: (notice) => { notices.push(notice); } } });
  }, 60_000);
});
