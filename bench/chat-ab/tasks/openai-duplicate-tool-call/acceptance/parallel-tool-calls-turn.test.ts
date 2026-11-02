/**
 * A turn on a GPT model whose provider reports parallel tool calls without
 * wire item ids, and lists them at different positions in the final
 * `response.completed` frame than it streamed them. Each test sends such a
 * stream through the real OpenAI Responses adapter (only the SDK client is
 * faked) and the real assistant-turn stream, then reads every place a tool
 * call leaves the turn: the forwarded events that become durable tool input
 * facts, the calls handed to canonicalization, and the committed assistant
 * content.
 */
import { afterAll, describe, expect, it, spyOn } from "bun:test";
import { Redacted } from "effect";
import * as RealOpenAIModule from "openai";
import type { OpenAIAuth } from "../src/infra/auth/openai-auth-types.js";
import type { ModelsClient } from "../src/infra/llm/models.js";
import { streamAssistantTurn } from "../src/orchestration/agent-runtime/assistant-turn-stream.js";
import { createOpenAIAdapter } from "../src/orchestration/agent-runtime/llm/openai.js";
import { createRetryBudget } from "../src/orchestration/agent-runtime/llm/retry-budget.js";
import type { ServingAttempt, TurnModelClient } from "../src/orchestration/agent-runtime/llm/types.js";
import { resolveModelInteractionProfile } from "../src/orchestration/agent-runtime/model-interaction-profile.js";

type Frame = Record<string, unknown>;

let frames: Frame[] = [];

async function* emit(list: Frame[]): AsyncGenerator<Frame> {
  for (const frame of list) yield frame;
}

// The adapter's error classifiers narrow with `instanceof` against the real
// SDK error classes, so the fake carries them and replaces only the client.
const RealOpenAI = RealOpenAIModule.default;
class FakeOpenAI {
  static APIError = RealOpenAI.APIError;
  static APIConnectionError = RealOpenAI.APIConnectionError;
  static BadRequestError = RealOpenAI.BadRequestError;
  static NotFoundError = RealOpenAI.NotFoundError;
  responses = { create: () => emit(frames) };
}
const openAiSpy = spyOn(RealOpenAIModule, "default").mockImplementation((() => new FakeOpenAI()) as never);
afterAll(() => openAiSpy.mockRestore());

const API_KEY_AUTH: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("[redacted secret]") };
const MODELS: ModelsClient = { getModelInfo: async () => null };

const USAGE = {
  input_tokens: 100,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 10,
  output_tokens_details: { reasoning_tokens: 0 },
};

const MESSAGE_ITEM = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "Checking both.", annotations: [] }],
};

// Two parallel calls to the same tool with the same arguments and no wire
// item id.
const CALL_1 = { type: "function_call", call_id: "call_1", name: "echo", arguments: '{"text":"hi"}', status: "completed" };
const CALL_2 = { ...CALL_1, call_id: "call_2" };

const ATTEMPT: ServingAttempt = {
  accessProvider: "openai_api",
  modelFamily: "openai",
  model: "gpt-5.4",
  contextLimit: 400_000,
  outputLimit: 128_000,
  supportsReasoning: false,
  promptNotes: { progress: "", modelNotes: "" },
  costFor: () => 0,
};

interface TurnObservation {
  forwarded: string[];
  canonicalized: string[];
  toolCalls: string[];
  committed: string[];
  outcome: string;
}

async function runTurn(stream: Frame[]): Promise<TurnObservation> {
  frames = stream;
  const adapter = await createOpenAIAdapter(API_KEY_AUTH, "gpt-5.4", MODELS, { authDir: "/scratch/flywheel-acceptance-auth" });
  // A one-candidate serving chain: the turn prepares its request for the
  // attempt, and the real adapter streams it.
  const client: TurnModelClient = {
    model: adapter.model,
    modelFamily: adapter.modelFamily,
    plannedAttempt: async () => ATTEMPT,
    async *streamServed(request) {
      yield* adapter.streamWithTools({ ...await request.prepare(ATTEMPT), retryBudget: createRetryBudget(4) });
    },
    streamWithTools: (options) => adapter.streamWithTools({ ...options, retryBudget: createRetryBudget(4) }),
  };
  const forwarded: string[] = [];
  const canonicalized: string[] = [];
  const result = await streamAssistantTurn({
    client,
    interactionProfile: resolveModelInteractionProfile("gpt-5.4"),
    messages: [{ kind: "user", content: "Echo hi twice in parallel." }],
    tools: [{ name: "echo", description: "Echo text", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
    systemPrompt: "system",
    reasoningEffort: undefined,
    signal: undefined,
    cacheRetention: "1h",
    cacheKey: undefined,
    providerOptions: undefined,
    requestContext: "main",
    requestAudit: undefined,
    staleMasking: undefined,
    turn: 1,
    messageCount: 1,
    estimatedContextTokens: 0,
    canonicalizeToolCall: (call) => {
      canonicalized.push(call.id);
      return call;
    },
    onEvent: (event) => {
      if (event.kind === "tool_use") forwarded.push(event.toolCall.id);
    },
  });
  return {
    forwarded,
    canonicalized,
    toolCalls: result.toolCalls.map((call) => call.id),
    committed: result.assistantContent.flatMap((block) => (block.type === "tool_use" ? [block.id] : [])),
    outcome: result.outcome.kind,
  };
}

const BOTH = ["call_1", "call_2"];

describe("parallel tool calls on an OpenAI Responses turn", () => {
  it("records each parallel call once when the final frame lists the calls at new positions without item ids", async () => {
    const observed = await runTurn([
      { type: "response.created", response: { id: "resp_1" } },
      { type: "response.output_item.done", item: MESSAGE_ITEM, output_index: 0 },
      { type: "response.output_item.done", item: CALL_1, output_index: 1 },
      { type: "response.output_item.done", item: CALL_2, output_index: 2 },
      {
        type: "response.completed",
        response: { id: "resp_1", status: "completed", usage: USAGE, output: [CALL_1, CALL_2, MESSAGE_ITEM] },
      },
    ]);

    expect(observed).toEqual({ forwarded: BOTH, canonicalized: BOTH, toolCalls: BOTH, committed: BOTH, outcome: "ok" });
  });

  it("regression guard: keeps a call that only the final frame reports", async () => {
    // Catches a fix that stops reading calls from response.completed: a call
    // with no streamed done event would then be lost from the turn.
    const observed = await runTurn([
      { type: "response.created", response: { id: "resp_2" } },
      { type: "response.output_item.done", item: CALL_1, output_index: 0 },
      {
        type: "response.completed",
        response: { id: "resp_2", status: "completed", usage: USAGE, output: [CALL_1, CALL_2] },
      },
    ]);

    expect(observed).toEqual({ forwarded: BOTH, canonicalized: BOTH, toolCalls: BOTH, committed: BOTH, outcome: "ok" });
  });

  it("regression guard: keeps two distinct calls without item ids when the final frame swaps them", async () => {
    // Catches a fix that merges two different calls into one, for example
    // because they share a tool name, arguments, or a missing item id.
    const observed = await runTurn([
      { type: "response.created", response: { id: "resp_3" } },
      { type: "response.output_item.done", item: CALL_1, output_index: 0 },
      { type: "response.output_item.done", item: CALL_2, output_index: 1 },
      {
        type: "response.completed",
        response: { id: "resp_3", status: "completed", usage: USAGE, output: [CALL_2, CALL_1] },
      },
    ]);

    expect(observed).toEqual({ forwarded: BOTH, canonicalized: BOTH, toolCalls: BOTH, committed: BOTH, outcome: "ok" });
  });
});
