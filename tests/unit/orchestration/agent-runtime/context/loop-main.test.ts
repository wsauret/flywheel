import { describe, expect, test } from "bun:test";

import { wakeInput, type AgentLoopInput } from "../../../../../src/infra/agent-loop-events.js";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { ApiOverloaded } from "../../../../../src/orchestration/agent-runtime/errors.js";
import { FUNCTION_TOOL_PRESENTATION, type ContentBlock, type ConversationMessage, type LLMClient, type ModelClient, type ProviderStreamEvent, type StreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { asModelClient, ownHistoryTarget } from "../_model-client.js";
import { makeCaptureClient, makeFakeLLMClient } from "./_loop-fixtures.js";
import { RequestToolMap, testBaseTools } from "../../../../helpers/request-tool-surface.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

const loopIdentity = { userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", providerSessionKey: "loop-main", promptCacheKey: "loop-main", artifactScopeId: "loop-main", retrievalSessionId: "loop-main" };

function cloneMessage(message: ConversationMessage): ConversationMessage {
  return structuredClone(message);
}

/** A deterministic foreground tool: no subprocess, no filesystem. */
const echoTool: RuntimeTool = {
  name: "echo",
  action: "shell_exec",
  description: "echo tool",
  inputSchema: { type: "object" },
  isConcurrencySafe: true,
  execute: async () => ({ content: "echoed", outcome: "ok" }),
};

/** Streams `events`, then dies the way a provider dies: the generator throws
 *  after the model already reported its tool calls. */
function dyingClient(events: ProviderStreamEvent[], error: Error): ModelClient {
  return asModelClient({ historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
      for (const event of events) yield event;
      throw error;
    },
    priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
  } satisfies LLMClient);
}

function toolUseBlocks(messages: readonly ConversationMessage[]): Array<Extract<ContentBlock, { type: "tool_use" }>> {
  return messages.flatMap((message) =>
    message.kind === "assistant" && Array.isArray(message.content)
      ? message.content.filter((block): block is Extract<ContentBlock, { type: "tool_use" }> => block.type === "tool_use")
      : [],
  );
}

describe("agent loop", () => {


  test("reports canonical assistant tool_use and per-call toolResult messages", async () => {
    const client = makeFakeLLMClient([
      {
        events: [
          { kind: "text_delta", text: "Checking.", blockKey: "text" },
          {
            kind: "tool_use",
            toolCall: { id: "tc_1", name: "bash", input: { command: "echo one" } },
          },
          {
            kind: "tool_use",
            toolCall: { id: "tc_2", name: "bash", input: { command: "echo two" } },
          },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "Done.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const canonical: ConversationMessage[] = [];
    const result = await runAgentLoop({
      ...loopIdentity,
      tools: testBaseTools(),
      client,
      systemPrompt: stableSystemPrompt("You are a helpful assistant."),
      instruction: "Run two commands",
      executionCwd: "/scratch",
      persistence: { history: { append: (message) => { canonical.push(cloneMessage(message)); } } },
      seed: { kind: "fresh" },
      onEvent: () => {},
    });

    expect(result.kind).toBe("completed");
    const assistantIndex = canonical.findIndex((message) =>
      message.kind === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some((block) => block.type === "tool_use"),
    );
    expect(assistantIndex).toBeGreaterThan(-1);
    const assistant = canonical[assistantIndex];
    if (assistant?.kind !== "assistant" || !Array.isArray(assistant.content)) throw new Error("expected assistant tool_use blocks");
    const toolUses = assistant.content.filter((block) => block.type === "tool_use");
    expect(toolUses.map((block) => block.id)).toEqual(["tc_1", "tc_2"]);
    expect(toolUses.map((block) => block.input)).toEqual([
      { command: "echo one" },
      { command: "echo two" },
    ]);

    // One top-level toolResult message per tool call, pushed directly after
    // the assistant message that issued the calls.
    const resultMessages = canonical.filter(
      (message): message is Extract<ConversationMessage, { kind: "toolResult" }> => message.kind === "toolResult",
    );
    expect(resultMessages).toHaveLength(2);
    expect(resultMessages.map((message) => message.toolUseId)).toEqual(["tc_1", "tc_2"]);
    expect(canonical[assistantIndex + 1]?.kind).toBe("toolResult");
    expect(canonical[assistantIndex + 2]?.kind).toBe("toolResult");
  });

  test("prepareWaitForInput blocks on no-tool-calls and continues when input returned", async () => {
    const client = makeFakeLLMClient([
      {
        events: [
          { kind: "text_delta", text: "I need more info.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "Got it, thanks.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    let waitCalled = 0;
    const result = await runAgentLoop({
      ...loopIdentity,
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "ask me",
      executionCwd: "/scratch",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => {
            waitCalled++;
            // First call returns user input, second call returns null to stop the live loop.
            return waitCalled === 1 ? { kind: "message", text: "hello" } : null;
          },
          cancel: async () => {},
        }),
      },
    });

    expect(result.kind).toBe("input_closed");
    expect(waitCalled).toBe(2);
  });

  test("completeOnIdle bounds a runner that retains a wait-capable input source", async () => {
    const client = makeFakeLLMClient([{
      events: [
        { kind: "text_delta", text: "Bounded reply.", blockKey: "text" },
        { kind: "done", stopReason: "end_turn" },
      ],
    }]);
    let waitCalled = false;

    const result = await runAgentLoop({
      ...loopIdentity,
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "reply once",
      executionCwd: "/scratch",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => { waitCalled = true; return null; },
          cancel: async () => {},
        }),
      },
      completeOnIdle: {},
    });

    expect(result.kind).toBe("completed");
    expect(waitCalled).toBe(false);
  });


  test("prepareWaitForInput returns null on no-tool-calls stops the live loop", async () => {
    const client = makeFakeLLMClient([
      {
        events: [
          { kind: "text_delta", text: "All done.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    let waitCalled = false;
    const result = await runAgentLoop({
      ...loopIdentity,
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "do it",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "manual-compact", promptCacheKey: "manual-compact",
      artifactScopeId: "manual-compact",
      retrievalSessionId: "manual-compact",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => {
            waitCalled = true;
            return null;
          },
          cancel: async () => {},
        }),
      },
    });

    expect(result.kind).toBe("input_closed");
    expect(waitCalled).toBe(true);
  });

  test("wake runs the loop without adding model-visible or persisted user input", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "text_delta", text: "First.", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
      { events: [{ kind: "text_delta", text: "Second.", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
    ]);
    const persisted: ConversationMessage[] = [];
    const waits: AgentLoopInput[] = [wakeInput()];

    const result = await runAgentLoop({
      ...loopIdentity,
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "do it",
      executionCwd: "/scratch",
      persistence: { history: { append: (message) => { persisted.push(cloneMessage(message)); } } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({ commit: async () => waits.shift() ?? null, cancel: async () => {} }),
      },
    });

    expect(result.kind).toBe("input_closed");
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[1]?.filter((message) => message.kind === "user")).toEqual([
      { kind: "user", content: "do it", origin: "system" },
    ]);
    expect(persisted.filter((message) => message.kind === "user")).toEqual([
      { kind: "user", content: "do it", origin: "system" },
    ]);
  });


  test("without prepareWaitForInput, no-tool-calls exits immediately (one-shot utility path)", async () => {
    const client = makeFakeLLMClient([
      {
        events: [
          { kind: "text_delta", text: "Done.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    const result = await runAgentLoop({
      ...loopIdentity,
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "finish",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "oneshot-loop", promptCacheKey: "oneshot-loop",
      artifactScopeId: "oneshot-loop",
      retrievalSessionId: "oneshot-loop",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      // No prepareWaitForInput: one-shot utility behavior.
    });

    expect(result.kind).toBe("completed");
  });

  test("prepareWaitForInput is not called when model yields tool calls", async () => {
    const client = makeFakeLLMClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "bash", input: { command: "echo hi" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "Done.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    let waitCalled = 0;
    const result = await runAgentLoop({
      ...loopIdentity,
      tools: testBaseTools(),
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "run something",
      executionCwd: "/scratch",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => {
            waitCalled++;
            return null;
          },
          cancel: async () => {},
        }),
      },
    });

    expect(result.kind).toBe("input_closed");
    // prepareWaitForInput should only be called on the second turn (text-only, no tools)
    expect(waitCalled).toBe(1);
  });


  test("inputSource.prepareWaitForInput is called after onTurnEnded observers leave drain empty", async () => {
    const client = makeFakeLLMClient([
      {
        events: [
          { kind: "text_delta", text: "I think I'm done.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "OK truly done now.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "Got queued input.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ]);

    let waitCalled = 0;
    const pending: string[] = [];
    const result = await runAgentLoop({
      ...loopIdentity,
      tools: testBaseTools(),
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: "/scratch",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: {
        drainPending: () => {
          if (pending.length === 0) return null;
          return { kind: "message", text: pending.splice(0).join("\n\n") };
        },
        prepareWaitForInput: () => ({
          commit: async () => {
            waitCalled++;
            return waitCalled === 1 ? { kind: "message", text: "queued input" } : null;
          },
          cancel: async () => {},
        }),
      },
      lifecycle: {
        onTurnEnded: ({ turnCount }) => {
          // First end_turn: inject via the input source (continue path)
          // Second end_turn: no injection (drain empty → prepareWaitForInput → external stop)
          if (turnCount === 1) pending.push("keep going");
        },
      },
    });

    expect(result.kind).toBe("input_closed");
    expect(waitCalled).toBe(2);
  });
});

// A tool_use event has already started a foreground tool by the time the
// provider dies, so the turn owes that call a durable assistant reference, one
// canonical result, and one runtime projection - and only then the failure.
describe("provider failure settlement", () => {
  const toolCallTurn: ProviderStreamEvent[] = [
    { kind: "text_delta", text: "Running it.", blockKey: "text" },
    { kind: "tool_use", toolCall: { id: "tc_1", name: "echo", input: {} } },
  ];

  function runTurn(client: ModelClient) {
    const canonical: ConversationMessage[] = [];
    const events: StreamEvent[] = [];
    const failure = runAgentLoop({
      ...loopIdentity,
      client,
      tools: new RequestToolMap([[echoTool.name, echoTool]]),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "run the tool",
      executionCwd: "/scratch",
      persistence: { history: { append: (message) => { canonical.push(cloneMessage(message)); } } },
      seed: { kind: "fresh" },
      onEvent: (event) => { events.push(event); },
    }).then(() => null, (err) => err);
    return { canonical, events, failure };
  }

  test("a recoverable provider failure settles the observed call once, then re-raises", async () => {
    const turn = runTurn(dyingClient(toolCallTurn, new ApiOverloaded({ message: "overloaded" })));
    const failure = await turn.failure;

    expect(failure instanceof ApiOverloaded ? failure._tag : undefined).toBe("ApiOverloaded");
    const assistants = turn.canonical.filter((message) => message.kind === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0]?.kind === "assistant" && assistants[0].incomplete).toBe(true);
    expect(toolUseBlocks(turn.canonical).map((block) => block.id)).toEqual(["tc_1"]);
    const results = turn.canonical.filter((message) => message.kind === "toolResult");
    expect(results.map((message) => message.kind === "toolResult" ? message.toolUseId : "")).toEqual(["tc_1"]);
    // Assistant, then its result, then the projection.
    expect(turn.canonical.indexOf(assistants[0]!)).toBeLessThan(turn.canonical.indexOf(results[0]!));
    expect(turn.events.filter((event) => event.kind === "tool_result")).toHaveLength(1);
  });

  test("an unclassified local failure settles the observed call once, then re-raises unchanged", async () => {
    const local = new Error("local stream callback exploded");
    const turn = runTurn(dyingClient(toolCallTurn, local));
    const failure = await turn.failure;

    expect(failure).toBe(local);
    const assistants = turn.canonical.filter((message) => message.kind === "assistant");
    expect(assistants).toHaveLength(1);
    expect(toolUseBlocks(turn.canonical).map((block) => block.id)).toEqual(["tc_1"]);
    const results = turn.canonical.filter((message) => message.kind === "toolResult");
    expect(results.map((message) => message.kind === "toolResult" ? message.toolUseId : "")).toEqual(["tc_1"]);
    expect(turn.canonical.indexOf(assistants[0]!)).toBeLessThan(turn.canonical.indexOf(results[0]!));
    expect(turn.events.filter((event) => event.kind === "tool_result")).toHaveLength(1);
  });

  test("a failed turn publishes no terminal projection of its own", async () => {
    const turn = runTurn(dyingClient(toolCallTurn, new ApiOverloaded({ message: "overloaded" })));
    await turn.failure;

    expect(turn.events.filter((event) => event.kind === "done")).toHaveLength(0);
  });

  test("the terminal projection follows the tool projections the turn settled", async () => {
    const client = makeFakeLLMClient([
      { events: [...toolCallTurn, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "text_delta", text: "Done.", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
    ]);
    const events: StreamEvent[] = [];

    const result = await runAgentLoop({
      ...loopIdentity,
      client,
      tools: new RequestToolMap([[echoTool.name, echoTool]]),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "run the tool",
      executionCwd: "/scratch",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: (event) => { events.push(event); },
    });

    expect(result.kind).toBe("completed");
    const kinds = events.map((event) => event.kind);
    expect(kinds.indexOf("tool_result")).toBeGreaterThan(-1);
    expect(kinds.indexOf("tool_result")).toBeLessThan(kinds.indexOf("done"));
  });
});

// The canonical assistant provisional write is acknowledged by
// `flushCanonicalMessages`. A turn must not report itself finished, by terminal
// projection or by re-raised provider cause, before that acknowledgement lands -
// including a turn that produced no tool results at all.
describe("canonical acknowledgement gating", () => {
  function heldAcknowledgement() {
    let release = () => {};
    let calls = 0;
    const held = new Promise<void>((resolve) => { release = resolve; });
    return { flushCanonicalMessages: () => ++calls === 1 ? Promise.resolve() : held, release };
  }

  /** Lets the loop run until it can only progress past the held acknowledgement. */
  const drainPendingWork = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 5)); };

  test("an assistant-only turn publishes no terminal projection until the canonical write is acknowledged", async () => {
    const ack = heldAcknowledgement();
    const events: StreamEvent[] = [];
    const loop = runAgentLoop({
      ...loopIdentity,
      client: makeFakeLLMClient([{ events: [{ kind: "text_delta", text: "Done.", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] }]),
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "reply once",
      executionCwd: "/scratch",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: (event) => { events.push(event); },
      flushCanonicalMessages: ack.flushCanonicalMessages,
    });

    await drainPendingWork();
    expect(events.filter((event) => event.kind === "text_delta")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "done")).toHaveLength(0);

    ack.release();
    expect((await loop).kind).toBe("completed");
    expect(events.filter((event) => event.kind === "done")).toHaveLength(1);
  });

  test("an assistant-only provider failure re-raises only after the canonical write is acknowledged", async () => {
    const ack = heldAcknowledgement();
    let settlement: "pending" | "raised" = "pending";
    const failure = runAgentLoop({
      ...loopIdentity,
      client: dyingClient([{ kind: "text_delta", text: "Partial.", blockKey: "text" }], new ApiOverloaded({ message: "overloaded" })),
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "reply once",
      executionCwd: "/scratch",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      flushCanonicalMessages: ack.flushCanonicalMessages,
    }).then(() => null, (error) => { settlement = "raised"; return error; });

    await drainPendingWork();
    expect(settlement).toBe("pending");

    ack.release();
    const raised = await failure;
    expect(raised instanceof ApiOverloaded ? raised._tag : undefined).toBe("ApiOverloaded");
  });
});
