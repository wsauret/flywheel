import { expect, spyOn, test } from "bun:test";
import { compactInput } from "../../../../../src/infra/agent-loop-events.js";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { estimateConversationTokens, tokenCountingPolicy } from "../../../../../src/orchestration/agent-runtime/compaction/token-counter.js";
import { FUNCTION_TOOL_PRESENTATION, presentToolHistory, type ConversationMessage, type ProviderStreamEvent, type ServingAttempt, type StreamOptions, type StreamEvent, type ToolPresentation } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { lowerToolHistoryById } from "../../../../../src/orchestration/agent-runtime/llm/tool-history-projection.js";
import { assemblyPinned, RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { asModelClient } from "../_model-client.js";
import { makeCaptureClient, withSessionNotes } from "./_loop-fixtures.js";
import { createStaleToolResultMasker } from "../../../../../src/orchestration/agent-runtime/compaction/stale-tool-result-masker.js";
import { createActiveRequestContext } from "../../../../../src/orchestration/agent-runtime/active-request-context.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { prepareLocalTokenizer } from "../../../../../src/infra/local-tokenizer.js";
import { renderSystemPrompt, stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

/** A provider that names Flywheel's tools under an MCP namespace, as the Agent SDK bridge does. */
const NAMESPACED: ToolPresentation = Object.freeze({ ...FUNCTION_TOOL_PRESENTATION, format: "mcp-function-schema", wireName: (name: string) => `mcp__runtime__${name}` });
const prefix = (request: StreamOptions, presentation: ToolPresentation = FUNCTION_TOOL_PRESENTATION) =>
  Math.ceil((renderSystemPrompt(request.systemPrompt).length
    + JSON.stringify(request.tools.map((tool) => ({ ...tool, name: presentation.wireName?.(tool.name) ?? tool.name }))).length) / 4);
const tokens = (messages: readonly ConversationMessage[]) => estimateConversationTokens(messages, "anthropic");

test("the first restored request cycle retains its recorded mask through provider preparation", async () => {
  const { client } = makeCaptureClient([]);
  const attempt = { ...await client.plannedAttempt(), contextLimit: 100 };
  const history: ConversationMessage[] = [{ kind: "user", content: "start" }];
  for (let index = 0; index < 10; index += 1) {
    history.push(
      { kind: "assistant", content: [{ type: "tool_use", name: "bash", id: `mask-${index}`, input: { command: "test" } }] },
      { kind: "toolResult", toolUseId: `mask-${index}`, content: [{ type: "text", text: "x".repeat(500) }] },
    );
  }
  const context = createActiveRequestContext({
    messages: () => history, attempt: () => attempt, onEvent: () => {},
    initialStaleMasking: { cutoffIndex: 8, zone: 0 },
  });
  const surface = await new RequestToolMap().resolve();
  await surface.prepareStablePrompt(() => stableSystemPrompt("test"), DEFAULT_MODEL_INTERACTION_PROFILE);
  context.prepareCycle(surface, attempt, undefined);
  context.prepare(attempt);
  context.advance();
  expect(context.active().mask.staleMasking?.cutoffIndex).toBe(8);
  context.prepareCycle(surface, attempt, undefined);
  expect(context.active().mask.staleMasking!.cutoffIndex).toBeGreaterThan(8);
});

test("appending unmasked history preserves sent snapshots without duplicating messages", async () => {
  const { client } = makeCaptureClient([]);
  const attempt = await client.plannedAttempt();
  const history: ConversationMessage[] = [{ kind: "user", content: "first" }];
  const context = createActiveRequestContext({
    messages: () => history, attempt: () => attempt, onEvent: () => {},
  });
  const surface = await new RequestToolMap().resolve();
  await surface.prepareStablePrompt(() => stableSystemPrompt("test"), DEFAULT_MODEL_INTERACTION_PROFILE);
  context.select(surface, attempt, undefined);
  const sent = context.active().messages;
  history.push({ kind: "assistant", content: "second" });
  const next = context.active();
  expect(sent).toEqual([{ kind: "user", content: "first" }]);
  expect(next.messages).toEqual(history);
  expect(next.snapshot.messageTokens).toBe(tokens(history));
  context.advance();
  expect(context.active()).toBe(next);
});

test("projects history from a different tool contract before token accounting", async () => {
  const { client } = makeCaptureClient([]);
  const attempt = await client.plannedAttempt();
  const history: ConversationMessage[] = [
    {
      kind: "assistant",
      content: [{ type: "tool_use", id: "patch-1", name: "apply_patch", input: { input: "*** Begin Patch\n*** End Patch" } }],
      accessProvider: "openai_api",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5",
    },
    { kind: "toolResult", toolUseId: "patch-1", content: [{ type: "text", text: "Updated src/example.ts" }] },
  ];
  const context = createActiveRequestContext({
    messages: () => history, attempt: () => attempt, onEvent: () => {},
  });
  const surface = await new RequestToolMap([["edit", {
    name: "edit",
    description: "Edit a file",
    action: "file_edit",
    inputSchema: { type: "object", properties: {} },
    isConcurrencySafe: false,
    execute: async () => ({ content: "unused", outcome: "ok" }),
  }]]).resolve();
  await surface.prepareStablePrompt(() => stableSystemPrompt("test"), DEFAULT_MODEL_INTERACTION_PROFILE);

  context.select(surface, attempt, undefined);
  const outbound = context.active();

  expect(JSON.stringify(outbound.messages)).not.toContain("apply_patch");
  expect(JSON.stringify(outbound.messages)).not.toContain("*** Begin Patch");
  expect(JSON.stringify(outbound.messages)).toContain("Updated src/example.ts");
  expect(outbound.snapshot.messageTokens).toBe(tokens(outbound.messages));
  expect(history[0]).toMatchObject({
    kind: "assistant",
    content: [expect.objectContaining({ type: "tool_use", name: "apply_patch" })],
  });
});

test("a withhold decision replaces the refused image in the outgoing view of every provider, after masking", async () => {
  const note = "The provider refused the image of read shot, so it is withheld.";
  await prepareLocalTokenizer();
  const { client } = makeCaptureClient([]);
  const anthropic = await client.plannedAttempt();
  const openai: ServingAttempt = { ...anthropic, accessProvider: "openai_api", modelFamily: "openai", model: "gpt-5" };
  const image = { type: "image" as const, mediaType: "image/png", data: "aGVsbG8=" };
  const history: ConversationMessage[] = [
    { kind: "user", content: "start" },
    { kind: "assistant", content: [{ type: "tool_use", id: "old-shot", name: "read", registrationId: "read", input: { path: "old.png" } }] },
    { kind: "toolResult", toolUseId: "old-shot", content: [{ type: "text", text: "old" }, image] },
    { kind: "assistant", content: [{ type: "tool_use", id: "shot", name: "read", registrationId: "read", input: { path: "a.png" } }] },
    { kind: "toolResult", toolUseId: "shot", content: [{ type: "text", text: "now" }, image] },
    { kind: "system", content: note, contentRepair: { kind: "withhold", toolUseId: "old-shot", partIndex: 1, partKind: "image" } },
    { kind: "system", content: note, contentRepair: { kind: "withhold", toolUseId: "shot", partIndex: 1, partKind: "image" } },
  ];
  const surface = await new RequestToolMap([["read", {
    name: "read", description: "Read", action: "file_read", isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {} }, execute: async () => ({ content: "unused", outcome: "ok" }),
  }]]).resolve();
  await surface.prepareStablePrompt(() => stableSystemPrompt("test"), DEFAULT_MODEL_INTERACTION_PROFILE);
  const context = createActiveRequestContext({
    messages: () => history, attempt: () => anthropic, onEvent: () => {}, initialStaleMasking: { cutoffIndex: 3, zone: 0 },
  });
  context.select(surface, anthropic, undefined);

  for (const attempt of [anthropic, openai]) {
    context.prepare(attempt);
    const outbound = context.active();
    expect(outbound.mask.staleMasking?.maskedToolUseIds).toEqual(["old-shot"]);
    expect(outbound.messages[2]).toEqual({ kind: "toolResult", toolUseId: "old-shot", content: [{ type: "text", text: expect.stringContaining("[stale-masked read]") }] });
    expect(outbound.messages[4]).toEqual({ kind: "toolResult", toolUseId: "shot", content: [{ type: "text", text: "now" }, { type: "text", text: note }] });
    expect(JSON.stringify(outbound.messages)).not.toContain(image.data);
  }
  expect(history[4]).toMatchObject({ content: [{ type: "text", text: "now" }, image] });
});

test("provider variants and appends do not recount unchanged presented history", async () => {
  await prepareLocalTokenizer();
  const { client } = makeCaptureClient([]);
  const base = await client.plannedAttempt();
  const attempt = { ...base, tokenizerIdentity: "ClaudeV3" as const, toolPresentation: NAMESPACED };
  const history: ConversationMessage[] = [
    { kind: "assistant", content: [{ type: "text", text: "unchanged answer" }] },
    { kind: "assistant", content: [{ type: "tool_use", id: "read-1", name: "read", registrationId: "read", input: { path: "old" } }] },
    { kind: "toolResult", toolUseId: "read-1", content: [{ type: "text", text: "result" }] },
  ];
  const surface = await new RequestToolMap([["read", {
    name: "read", description: "Read", action: "file_read", isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {} }, execute: async () => ({ content: "unused", outcome: "ok" }),
  }]]).resolve();
  await surface.prepareStablePrompt(() => stableSystemPrompt("test"), DEFAULT_MODEL_INTERACTION_PROFILE);
  const context = createActiveRequestContext({ messages: () => history, attempt: () => attempt, onEvent: () => {} });
  context.select(surface, attempt, undefined);
  const count = spyOn(context.tokenPolicy(), "countText");
  try {
    expect(presentToolHistory(history, NAMESPACED)[0]).toBe(history[0]);
    expect(presentToolHistory(history, { ...FUNCTION_TOOL_PRESENTATION, wireName: (name) => name })[1]).toBe(history[1]);
    context.active();
    expect(count).toHaveBeenCalledTimes(3);
    count.mockClear();
    const prepared = context.prepare(attempt);
    for (let i = 0; i < 20; i++) context.variant(prepared);
    expect(count).toHaveBeenCalledTimes(0);
    context.prepare({ ...attempt, toolPresentation: FUNCTION_TOOL_PRESENTATION });
    context.active();
    expect(count).toHaveBeenCalledTimes(1);
    count.mockClear();
    context.prepare(attempt);
    context.active();
    expect(count).toHaveBeenCalledTimes(0);
    history.push({ kind: "assistant", content: [{ type: "text", text: "new answer" }] });
    context.active();
    expect(count).toHaveBeenCalledTimes(1);
    expect(history[1]).toMatchObject({ content: [{ name: "read" }] });
  } finally {
    count.mockRestore();
  }
});

test("candidate model switches select their own prepared token policy", async () => {
  await prepareLocalTokenizer();
  const { client } = makeCaptureClient([]);
  const base = await client.plannedAttempt();
  let attempt: ServingAttempt = { ...base, model: "claude-opus-3", tokenizerIdentity: "ClaudeV3" };
  const history: ConversationMessage[] = [{ kind: "user", content: "token candidate ".repeat(100) }];
  const context = createActiveRequestContext({
    messages: () => history,
    attempt: () => attempt,
    onEvent: () => {},
  });
  const surface = await new RequestToolMap().resolve();
  await surface.prepareStablePrompt(() => stableSystemPrompt("test"), DEFAULT_MODEL_INTERACTION_PROFILE);

  context.select(surface, attempt, undefined);
  expect(context.tokenPolicy().identity).toBe("local:ClaudeV3");
  expect(context.active().snapshot.messageTokens).toBe(estimateConversationTokens(history, tokenCountingPolicy(attempt.model, attempt.modelFamily, attempt.tokenizerIdentity)));

  attempt = { ...base, model: "claude-opus-5", tokenizerIdentity: "ClaudeV5" };
  context.select(surface, attempt, undefined);
  expect(context.tokenPolicy().identity).toBe("local:ClaudeV5");
  expect(context.active().snapshot.messageTokens).toBe(estimateConversationTokens(history, tokenCountingPolicy(attempt.model, attempt.modelFamily, attempt.tokenizerIdentity)));

  attempt = { ...base, model: "unmapped-model" };
  context.select(surface, attempt, undefined);
  expect(context.tokenPolicy().identity).toBe("heuristic:anthropic");
  expect(context.active().snapshot.messageTokens).toBe(estimateConversationTokens(history, "anthropic"));
});

for (const priorMasked of [false, true]) for (const measurement of ["before", "after"] as const) {
  test(`compaction ${measurement} counts checkpoint growth and ${priorMasked ? "excludes prior" : "includes newly applied"} masks`, async () => {
    const requests: StreamOptions[] = [];
    const events: StreamEvent[] = [];
    const canonical: ConversationMessage[] = [
      { kind: "user", content: "old task" },
      { kind: "assistant", content: [{ type: "tool_use", id: "old", name: "read", input: { path: "old.txt" } }] },
      { kind: "toolResult", toolUseId: "old", content: [{ type: "text", text: "old output ".repeat(5000) }] },
      ...Array.from({ length: 8 }, (_, i): ConversationMessage => ({ kind: "user", content: `follow up ${i}` })),
    ];
    const checkpoint = "substantial checkpoint ".repeat(1000);
    let compactQueued = false;
    const client = asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model",
      contextLimit: 40_000, outputLimit: 8000, supportsReasoning: false,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      async *streamWithTools(request) {
        requests.push({ ...request, messages: [...request.messages] });
        yield { kind: "text_delta", text: compactQueued ? checkpoint : "ready", blockKey: "answer" } as const;
        if (requests.length === (priorMasked ? 2 : 1)) {
          yield { kind: "tool_use", toolCall: { id: "checkpoint", name: "checkpoint_replace", input: { section: "currentState", value: "saved" } } } as const;
          yield { kind: "done", stopReason: "tool_use" } as const;
          return;
        }
        yield { kind: "done", stopReason: "end_turn" } as const;
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    });
    let beforeHistory: ConversationMessage[] = [];
    const { tools, checkpoint: checkpointOwner } = withSessionNotes();
    await runAgentLoop({
      client, tools: await assemblyPinned(tools), checkpoint: checkpointOwner, systemPrompt: () => stableSystemPrompt("system prefix"), instruction: null,
      initialRequestContext: "request-only context ".repeat(100), executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "accounting", promptCacheKey: "accounting", artifactScopeId: "accounting", retrievalSessionId: "accounting",
      seed: { kind: "resume", priorMessages: [...canonical] },
      persistence: { history: { append: (message) => { canonical.push(message); } } },
      onEvent: (event) => {
        events.push(event);
        if (event.kind === "compaction_start") beforeHistory = [...canonical];
      },
      inputSource: { drainPending: () => {
        if (!compactQueued && (!priorMasked || requests.length === 1)) { compactQueued = true; return compactInput(); }
        return null;
      } },
    });
    const report = events.find((event) => event.kind === "compaction_done");
    expect(report?.kind).toBe("compaction_done");
    if (report?.kind !== "compaction_done") throw new Error("missing compaction report");
    const checkpointRequest = requests[priorMasked ? 1 : 0]!;
    const requestOnly = checkpointRequest.messages.at(-1)!;
    const projectedBeforeHistory = lowerToolHistoryById(beforeHistory, ["old"]);
    const expectedHistory = priorMasked
      ? [...requests[0]!.messages.slice(0, -1), ...projectedBeforeHistory.slice(requests[0]!.messages.length - 1)]
      : projectedBeforeHistory;
    if (measurement === "before") expect(report.tokensBefore).toBe(prefix(checkpointRequest) + tokens([...expectedHistory, requestOnly]));
    const afterRequest = requests.at(-1)!;
    expect(report.tokensAfter).toBe(prefix(afterRequest) + tokens(afterRequest.messages));
    const reportIndex = events.indexOf(report);
    const reset = events.slice(reportIndex + 1).find((event) => event.kind === "context_update");
    expect(reset?.kind === "context_update" ? reset.promptTokens : undefined).toBe(report.tokensAfter);
  });
}

test("planning and sending materialize each unchanged candidate once", async () => {
  const { client } = makeCaptureClient([{ events: [
    { kind: "text_delta", text: "done", blockKey: "text" }, { kind: "done", stopReason: "end_turn" },
  ] }]);
  const tools = new RequestToolMap();
  let preparations = 0;
  await runAgentLoop({
    client, tools: {
      current: () => tools.current(),
      async resolve() {
        const surface = await tools.resolve();
        return { ...surface, prepareAttempt: (...args) => { preparations++; return surface.prepareAttempt(...args); } };
      },
    },
    systemPrompt: stableSystemPrompt("test"), instruction: "work", executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    providerSessionKey: "prepare-once", promptCacheKey: "prepare-once", artifactScopeId: "prepare-once", retrievalSessionId: "prepare-once",
    persistence: { history: { append: () => {} } }, seed: { kind: "fresh" }, onEvent: () => {},
  });
  expect(preparations).toBe(1);
});

test("unchanged history and frozen cutoff reuse the same masked view", () => {
  const masker = createStaleToolResultMasker();
  const messages: ConversationMessage[] = [
    { kind: "assistant", content: [{ type: "tool_use", id: "old", name: "read", input: { path: "old.txt" } }] },
    { kind: "toolResult", toolUseId: "old", content: [{ type: "text", text: "old output ".repeat(500) }] },
    { kind: "user", content: "work" },
    { kind: "assistant", content: "answer" },
  ];
  const first = masker.mask(messages, 0.5);
  expect(first).not.toBeNull();
  expect(masker.mask(messages, 0)).toBe(first);
  expect(masker.mask(messages, 0.5)).toBe(first);
  messages.push({ kind: "user", content: "new work" });
  const grown = masker.mask(messages, 0);
  expect(grown).not.toBe(first);
  expect(grown?.cutoffIndex).toBe(first?.cutoffIndex);
  expect(first?.messages).toHaveLength(4);
});

test("proactive reset reports the next request including its prompt", async () => {
  const requests: StreamOptions[] = [];
  const events: StreamEvent[] = [];
  const history: ConversationMessage[] = [
    { kind: "user", content: "work" },
    { kind: "assistant", content: "old answer ".repeat(4000) },
  ];
  const tools = withSessionNotes().tools;
  const client = asModelClient({
    accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model",
    contextLimit: 10_000, outputLimit: 8000, supportsReasoning: false,
    toolPresentation: NAMESPACED,
    async *streamWithTools(request) {
      requests.push({ ...request, messages: [...request.messages] });
      yield { kind: "text_delta", text: "checkpoint output ".repeat(200), blockKey: "text" } as const;
      if (requests.length === 1) {
        yield { kind: "tool_use", toolCall: { id: "save", name: "checkpoint_replace", input: { section: "currentState", value: "saved" } } } as const;
        yield { kind: "done", stopReason: "tool_use" } as const;
        return;
      }
      yield { kind: "done", stopReason: "end_turn" } as const;
    },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
  });
  await runAgentLoop({
    client, tools,
    systemPrompt: () => stableSystemPrompt("current system"), instruction: null,
    initialRequestContext: "request-only context", executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    providerSessionKey: "background-accounting", promptCacheKey: "background-accounting", artifactScopeId: "background-accounting", retrievalSessionId: "background-accounting",
    seed: { kind: "resume", priorMessages: [...history] },
    checkpoint: withSessionNotes().checkpoint,
    onEvent: (event) => events.push(event),
    persistence: { history: { append: (message) => { history.push(message); } } },
  });
  const report = events.find((event) => event.kind === "compaction_done");
  expect(report?.kind).toBe("compaction_done");
  if (report?.kind !== "compaction_done") throw new Error("missing compaction report");
  expect(requests).toHaveLength(2);
  expect(report.tokensAfter).toBe(prefix(requests[1]!, NAMESPACED) + tokens(requests[1]!.messages));
});

test("the next request's estimate, which the output clamp reads, counts the thinking a reasoning response re-sends", async () => {
  const requests: StreamOptions[] = [];
  const history: ConversationMessage[] = [];
  const metadata = { api: "anthropic-messages", provider: "anthropic", model: "test-model", timestamp: 1 } as const;
  const { tools } = withSessionNotes(new RequestToolMap([["record", {
    name: "record", description: "Record", action: "file_read", isConcurrencySafe: true,
    inputSchema: { type: "object", properties: {} }, execute: async () => ({ content: "Recorded.", outcome: "ok" }),
  }]]));
  const responses: ProviderStreamEvent[][] = [
    [
      // Redacted thinking: no text, only a signature, so the text estimate sees nothing.
      { kind: "thinking_complete", thinking: "", signature: "sig", blockKey: "think" },
      { kind: "tool_use", toolCall: { id: "call-1", name: "record", input: { answer: "42" } } },
      { kind: "usage", final: true, inputTokens: 500, outputTokens: 4_766, cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 4_716 },
      { kind: "done", stopReason: "tool_use", metadata },
    ],
    [{ kind: "text_delta", text: "done", blockKey: "text" }, { kind: "done", stopReason: "end_turn", metadata }],
  ];
  const client = asModelClient({
    accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model",
    contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: true,
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    async *streamWithTools(request) {
      requests.push({ ...request, messages: [...request.messages] });
      yield* responses[requests.length - 1] ?? [];
    },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
  });
  await runAgentLoop({
    client, tools: await assemblyPinned(tools), systemPrompt: () => stableSystemPrompt("system"), instruction: "work",
    executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
    providerSessionKey: "reasoning-estimate", promptCacheKey: "reasoning-estimate", artifactScopeId: "reasoning-estimate", retrievalSessionId: "reasoning-estimate",
    seed: { kind: "fresh" }, onEvent: () => {},
    persistence: { history: { append: (message) => { history.push(message); } } },
  });

  expect(requests).toHaveLength(2);
  const [first, second] = requests;
  if (!first || !second) throw new Error("expected two requests");
  expect(history.find((message) => message.kind === "assistant")).toMatchObject({ reasoningTokens: 4_716 });
  // The provider charged 500 for the first request; the second re-sends the
  // response, whose hidden thinking the provider reported as 4,716 tokens.
  expect(second.estimatedContextTokens).toBe(500 + tokens(second.messages) - tokens(first.messages) + 4_716);
});
