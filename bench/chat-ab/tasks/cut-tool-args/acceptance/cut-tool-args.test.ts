import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { Redacted } from "effect";
import OpenAI from "openai";
import { tmpdir } from "node:os";
import type { ModelInfo, ModelsClient } from "../src/infra/llm/models.js";
import { runAgentLoop } from "../src/orchestration/agent-runtime/agent-loop.js";
import { createAnthropicAdapter, operationsFromAnthropicClient } from "../src/orchestration/agent-runtime/llm/anthropic.js";
import { createOpenAIChatCompletionsAdapter } from "../src/orchestration/agent-runtime/llm/openai-completions.js";
import { ProviderAttemptFailure } from "../src/orchestration/agent-runtime/llm/provider-failure.js";
import {
  FUNCTION_TOOL_PRESENTATION,
  type LLMClient,
  type ModelClient,
  type ProviderStreamEvent,
  type StreamOptions,
} from "../src/orchestration/agent-runtime/llm/types.js";
import { createRequestToolSurface, type RequestToolSurfaceOwner } from "../src/orchestration/agent-runtime/request-tool-surface.js";
import { captureRuntimeConfigRequest } from "../src/orchestration/agent-runtime/request-config.js";
import type { RuntimeTool } from "../src/orchestration/agent-runtime/tools/types.js";
import { CONFIG_DEFAULTS } from "../src/orchestration/config/schema.js";
import { composeFirstPartyModules } from "../src/orchestration/modules.js";

interface WireFrame { [key: string]: unknown }
interface JsonObject { [key: string]: unknown }

function sse(frames: readonly WireFrame[]): Response {
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames[index++];
      if (frame) controller.enqueue(new TextEncoder().encode(`${typeof frame.type === "string" ? `event: ${frame.type}\n` : ""}data: ${JSON.stringify(frame)}\n\n`));
      else controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function wireClient(frames: readonly WireFrame[]): OpenAI {
  return new OpenAI({ apiKey: "test-key", maxRetries: 0, fetch: async () => sse(frames) });
}

const OPENROUTER_INFO: ModelInfo = {
  provider: "openrouter",
  family: "anthropic",
  id: "claude-opus-4-8",
  name: "Claude Opus 4.8",
  reasoning: true,
  toolCall: true,
  attachment: false,
  temperature: true,
  openWeights: false,
  cost: { input: 0, output: 0 },
  pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] },
  contextLimit: 200_000,
  outputLimit: 64_000,
};

const OPENROUTER = {
  accessProvider: "openrouter",
  providerHint: "openrouter",
  wireModelId: "anthropic/claude-opus-4.8",
  resolvedModelMetadata: OPENROUTER_INFO,
} as const;

const ANTHROPIC_INFO: ModelInfo = {
  provider: "anthropic",
  family: "anthropic",
  id: "claude-fable-5-1",
  name: "Fable",
  reasoning: true,
  toolCall: true,
  attachment: false,
  temperature: false,
  openWeights: false,
  cost: { input: 0, output: 0 },
  pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] },
  contextLimit: 200_000,
  outputLimit: 16_384,
};

function stubModelsClient(): ModelsClient {
  return {
    async refresh() {},
    async getProviderCatalog(providerIds) {
      return providerIds.includes(OPENROUTER_INFO.provider) ? [{
        providerId: OPENROUTER_INFO.provider, providerName: OPENROUTER_INFO.provider, wireModelId: OPENROUTER_INFO.id, metadata: OPENROUTER_INFO,
        provenance: "bundled", canonical: { providerId: OPENROUTER_INFO.provider, modelId: OPENROUTER_INFO.id }, transport: null,
      }] : [];
    },
    async getTokenizerIdentity() { return undefined; },
  };
}

async function drain(
  client: Awaited<ReturnType<typeof createOpenAIChatCompletionsAdapter>>,
  overrides: Partial<StreamOptions> = {},
): Promise<{ events: ProviderStreamEvent[]; error: Error | undefined }> {
  const events: ProviderStreamEvent[] = [];
  try {
    for await (const event of client.streamWithTools({
      messages: [{ kind: "user", content: "hi" }],
      tools: [],
      systemPrompt: "sys",
      ...overrides,
    })) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error) {
    return { events, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

// --- agent-loop harness: one adapter serves every request, and a recording
// "write" tool stands in for the real one. ---

function asModelClient(client: Omit<LLMClient, "toolPresentation">): ModelClient {
  const attempt: LLMClient = { ...client, toolPresentation: FUNCTION_TOOL_PRESENTATION };
  const modelClient: ModelClient = {
    model: client.model,
    modelFamily: client.modelFamily,
    plannedAttempt: async () => attempt,
    async admitRequest() {
      return {
        candidateAttributions: [],
        run: async ({ execute, prepare, providerOptions }) => {
          const planned = await modelClient.plannedAttempt(providerOptions);
          const prepared = prepare?.(planned) ?? {
            attempt: planned,
            messages: [],
            tools: [],
            systemPrompt: "",
            providerOptions,
            cacheRetention: undefined,
            tokenClasses: { estimatedPromptTokens: undefined, cacheRetention: undefined },
          };
          const result = await execute({
            attempt: prepared.attempt,
            client: { ...prepared.attempt, streamWithTools: (options: StreamOptions) => client.streamWithTools(options) },
            prepared,
          });
          if (result.kind === "provider_failure") throw result.failure;
          return result.value;
        },
        plannedAttempt: (providerOptions) => modelClient.plannedAttempt(providerOptions),
      };
    },
  };
  return modelClient;
}

async function toolSurface(tools: ReadonlyMap<string, RuntimeTool>): Promise<RequestToolSurfaceOwner> {
  const surface = await createRequestToolSurface(() => ({
    eligibleTools: tools,
    tools,
    omitted: [],
    registrationIds: new Map([...tools].map(([name, tool]) => [tool.name, name])),
    registrationIdentities: new Map([...tools].map(([name, tool]) => [tool.name, name])),
  }), () => null, () => composeFirstPartyModules(), () => captureRuntimeConfigRequest({
    revision: 0, config: CONFIG_DEFAULTS, warnings: [], diagnostics: [], sourceIdentity: "test", status: { kind: "valid" },
  }, "default"));
  const admit = <T extends { executionAdmission: (toolName: string) => unknown }>(value: T): T => ({
    ...value,
    executionAdmission: (toolName: string) => tools.has(toolName) ? { ok: true } : value.executionAdmission(toolName),
  });
  return {
    async resolve() { return admit(await surface.resolve()); },
    current() { return admit(surface.current()); },
  } as RequestToolSurfaceOwner;
}

async function runWithRecordedWrites(client: ModelClient): Promise<JsonObject[]> {
  const executed: JsonObject[] = [];
  const write: RuntimeTool = {
    name: "write",
    action: "ui_meta",
    description: "Write a file.",
    inputSchema: { type: "object" },
    isConcurrencySafe: true,
    async execute(input) {
      executed.push(input as JsonObject);
      return { content: "ok", outcome: "ok" };
    },
  };
  const loop = runAgentLoop({
    client,
    tools: await toolSurface(new Map([["write", write]])),
    systemPrompt: () => "test",
    instruction: "write the file",
    reasoningEffort: async () => "medium",
    executionCwd: tmpdir(),
    projectRoot: tmpdir(),
    providerSessionKey: "p",
    artifactScopeId: "p",
    retrievalSessionId: "p",
    persistence: { history: { append: () => {}, rewrite: () => {} } },
    seed: { kind: "fresh" },
    onEvent: () => {},
    inputSource: { drainPending: () => null, prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }) },
  });
  // The loop may end with an error once the scripted responses run out; only
  // the executions it made matter here.
  await Promise.resolve(loop).catch(() => undefined);
  return executed;
}

/** True when `input` is what a tolerant reader makes of a cut-off copy of
 *  `full`: its keys are a leading run of `full`'s keys, every value but the
 *  last equals `full`'s, the last is equal or a string prefix, and the whole
 *  is not `full` itself. */
function isCutDownCopyOf(input: JsonObject, full: JsonObject): boolean {
  const keys = Object.keys(input);
  const fullKeys = Object.keys(full);
  if (keys.length > fullKeys.length) return false;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (key !== fullKeys[index]) return false;
    const value = input[key];
    const expected = full[key];
    const last = index === keys.length - 1;
    if (Bun.deepEquals(value, expected)) continue;
    if (last && typeof value === "string" && typeof expected === "string" && expected.startsWith(value)) continue;
    return false;
  }
  return !Bun.deepEquals(input, full);
}

const FULL_WRITE = { path: "a.ts", content: "export const a = 1;\nexport const b = 2;\n" };
const FULL_WRITE_JSON = JSON.stringify(FULL_WRITE);
const CUT_MID_VALUE = FULL_WRITE_JSON.slice(0, FULL_WRITE_JSON.indexOf("2;"));
const CUT_BETWEEN_MEMBERS = FULL_WRITE_JSON.slice(0, FULL_WRITE_JSON.indexOf("\"content\""));

function anthropicLoopClient(firstArguments: string, firstStop: string): { client: () => Promise<ModelClient>; requests: () => number } {
  let requests = 0;
  const operations = operationsFromAnthropicClient(new Anthropic({
    apiKey: "k",
    maxRetries: 0,
    fetch: async () => {
      requests++;
      const first = requests === 1;
      return sse([
        { type: "message_start", message: { id: `m${requests}`, usage: { input_tokens: 10, output_tokens: 0 } } },
        ...(first ? [
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call_w", name: "write", input: {} } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: firstArguments } },
          { type: "content_block_stop", index: 0 },
        ] : [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          { type: "content_block_stop", index: 0 },
        ]),
        { type: "message_delta", delta: { stop_reason: first ? firstStop : "end_turn" }, usage: { output_tokens: 20 } },
        { type: "message_stop" },
      ]);
    },
  }));
  return {
    client: async () => asModelClient(await createAnthropicAdapter(Redacted.make("k"), ANTHROPIC_INFO.id, stubModelsClient(), {
      resolvedModelMetadata: ANTHROPIC_INFO,
      operations,
    })),
    requests: () => requests,
  };
}

function completionsLoopClient(firstArguments: string, firstFinish: string | null): { client: () => Promise<ModelClient>; requests: () => number } {
  let requests = 0;
  const openai = new OpenAI({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async () => {
      requests++;
      if (requests === 1) {
        return sse([
          { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_w", type: "function", function: { name: "write", arguments: firstArguments } }] }, finish_reason: null }] },
          ...(firstFinish === null ? [] : [{ id: "c1", choices: [{ index: 0, delta: {}, finish_reason: firstFinish }], usage: { prompt_tokens: 10, completion_tokens: 20 } }]),
        ]);
      }
      return sse([
        { id: `c${requests}`, choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
        { id: `c${requests}`, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } },
      ]);
    },
  });
  return {
    client: async () => asModelClient(await createOpenAIChatCompletionsAdapter(openai, "claude-opus-4-8", stubModelsClient(), OPENROUTER)),
    requests: () => requests,
  };
}

function cutDownExecutions(executed: readonly JsonObject[]): JsonObject[] {
  return executed.filter((input) => isCutDownCopyOf(input, FULL_WRITE));
}

describe("a tool call cut off by the output limit, through the agent loop", () => {
  test("Anthropic API: a write cut inside its content string never runs with the shortened content", async () => {
    const wire = anthropicLoopClient(CUT_MID_VALUE, "max_tokens");
    const executed = await runWithRecordedWrites(await wire.client());
    expect(wire.requests()).toBeGreaterThan(0);
    expect(cutDownExecutions(executed)).toEqual([]);
  });

  test("Anthropic API: a write cut between two arguments never runs with the arguments it has so far", async () => {
    const wire = anthropicLoopClient(CUT_BETWEEN_MEMBERS, "max_tokens");
    const executed = await runWithRecordedWrites(await wire.client());
    expect(wire.requests()).toBeGreaterThan(0);
    expect(cutDownExecutions(executed)).toEqual([]);
  });

  test("OpenRouter chat completions: a write cut by finish_reason length never runs with the shortened content", async () => {
    const wire = completionsLoopClient(CUT_MID_VALUE, "length");
    const executed = await runWithRecordedWrites(await wire.client());
    expect(wire.requests()).toBeGreaterThan(0);
    expect(cutDownExecutions(executed)).toEqual([]);
  });

  test("OpenRouter chat completions: a write whose stream closed with no finish_reason never runs with the shortened content", async () => {
    const wire = completionsLoopClient(CUT_MID_VALUE, null);
    const executed = await runWithRecordedWrites(await wire.client());
    expect(wire.requests()).toBeGreaterThan(0);
    expect(cutDownExecutions(executed)).toEqual([]);
  });

  test("regression guard: a complete write call on the Anthropic API still runs once with its full arguments", async () => {
    const wire = anthropicLoopClient(FULL_WRITE_JSON, "tool_use");
    const executed = await runWithRecordedWrites(await wire.client());
    expect(executed).toEqual([FULL_WRITE]);
  });

  test("regression guard: a complete OpenRouter write whose content carries an unescaped newline still runs once with that content", async () => {
    const raw = `{"path":"a.ts","content":"line1\nline2"}`;
    const wire = completionsLoopClient(raw, "tool_calls");
    const executed = await runWithRecordedWrites(await wire.client());
    expect(executed).toEqual([{ path: "a.ts", content: "line1\nline2" }]);
  });
});

describe("chat-completions output-length cut", () => {
  test("finish_reason length is an output overflow, not a completed turn", async () => {
    const adapter = await createOpenAIChatCompletionsAdapter(
      wireClient([
        { id: "c", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_cut", function: { name: "write", arguments: "{\"path\":\"a.ts\",\"content\":\"cut" } }] }, finish_reason: null }] },
        { id: "c", choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]),
      "claude-opus-4-8",
      stubModelsClient(),
      OPENROUTER,
    );

    const { events, error } = await drain(adapter);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    if (!(error instanceof ProviderAttemptFailure)) throw new Error("expected ProviderAttemptFailure");
    expect(error.failure._tag).toBe("OutputOverflowFailure");
    const toolUse = events.find((event) => event.kind === "tool_use");
    if (toolUse) {
      if (!("toolCall" in toolUse)) throw new Error("tool_use without toolCall");
      expect(toolUse.toolCall.input).toEqual({});
      expect(typeof toolUse.toolCall.inputParseError).toBe("string");
    }
    expect(events.some((event) => event.kind === "done")).toBe(false);
  });
});
