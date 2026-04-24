import { describe, it, expect, beforeEach, mock } from "bun:test";
import type { OpenAIAuth } from "../src/infra/auth/openai-auth-types.js";
import type { ModelsClient, ModelInfo } from "../src/orchestration/engines/providers/harness/llm/models.js";
import type { LLMClient, StreamEvent } from "../src/orchestration/engines/providers/harness/llm/types.js";

function stubModelsClient(info: ModelInfo | null = null): ModelsClient {
  return {
    async getModelInfo() {
      return info;
    },
  };
}

const COST_INFO: ModelInfo = {
  provider: "openai",
  family: "openai",
  id: "gpt-5.4",
  name: "GPT 5.4",
  reasoning: false,
  toolCall: true,
  attachment: false,
  temperature: true,
  contextLimit: 1_050_000,
  outputLimit: 128_000,
  cost: {
    input: 2.5,
    output: 15,
    cacheRead: 0.25,
    contextOver200k: { input: 5, output: 22.5, cacheRead: 0.5 },
  },
};

let streamEvents: Array<Record<string, unknown>> = [];

async function* emitMockResponseEvents(): AsyncGenerator<Record<string, unknown>> {
  for (const event of streamEvents) yield event;
}

const responsesCreate = mock(() => emitMockResponseEvents());

class FakeOpenAI {
  static BadRequestError = class BadRequestError extends Error {};
  responses = { create: responsesCreate };
}

const fakeChatGPTClient = { responses: { create: responsesCreate } };

mock.module("openai", () => ({
  default: FakeOpenAI,
}));

mock.module("../src/orchestration/engines/providers/harness/llm/openai-chatgpt.js", () => ({
  createChatGPTClient: () => fakeChatGPTClient,
}));

function setMockResponseUsage(overrides?: {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
}): void {
  const inputTokens = overrides?.inputTokens ?? 1000;
  const outputTokens = overrides?.outputTokens ?? 200;
  const reasoningTokens = overrides?.reasoningTokens ?? 50;
  const cachedTokens = overrides?.cachedTokens ?? 0;
  streamEvents = [
    { type: "response.created", response: { id: "resp_test" } },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        usage: {
          input_tokens: inputTokens,
          input_tokens_details: { cached_tokens: cachedTokens },
          output_tokens: outputTokens,
          output_tokens_details: { reasoning_tokens: reasoningTokens },
        },
        output: [],
      },
    },
  ];
}

async function collectStreamEvents(client: LLMClient): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.streamWithTools({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    systemPrompt: "",
  })) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// createOpenAIAdapter: auth routing
// ---------------------------------------------------------------------------

describe("createOpenAIAdapter — ChatGPT mode", () => {
  let createOpenAIAdapter: typeof import("../src/orchestration/engines/providers/harness/llm/openai.js").createOpenAIAdapter;

  beforeEach(async () => {
    streamEvents = [];
    const mod = await import("../src/orchestration/engines/providers/harness/llm/openai.js");
    createOpenAIAdapter = mod.createOpenAIAdapter;
  });

  it("produces a client with provider 'openai' in chatgpt mode", () => {
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresAtMs: Date.now() + 3_600_000,
    };
    const client = createOpenAIAdapter(auth, "gpt-5.4", stubModelsClient());
    expect(client.accessProvider).toBe("chatgpt");
    expect(client.modelFamily).toBe("openai");
    expect(client.model).toBe("gpt-5.4");
  });

  it("costFor returns 0 before model info is cached", () => {
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresAtMs: Date.now() + 3_600_000,
    };
    const client = createOpenAIAdapter(auth, "gpt-5.4", stubModelsClient(COST_INFO));
    const cost = client.costFor({
      input: 1000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    expect(cost).toBe(0);
  });

  it("costFor ignores reasoning_tokens because output_tokens already include them", async () => {
    setMockResponseUsage();
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: "sk-test" };
    const client = createOpenAIAdapter(auth, "gpt-5.4", stubModelsClient(COST_INFO));

    const events = await collectStreamEvents(client);
    const usageEvent = events.find((event) => event.kind === "usage");
    const cost = client.costFor({
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 50,
    });

    expect(usageEvent).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 50,
    });
    expect(cost).toBeCloseTo((1000 * 2.5 + 200 * 15) / 1_000_000, 10);
  });

  it("uses pricing in chatgpt mode once model info is cached", async () => {
    setMockResponseUsage({ inputTokens: 1200, outputTokens: 300, reasoningTokens: 80 });
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresAtMs: Date.now() + 3_600_000,
    };
    const client = createOpenAIAdapter(auth, "gpt-5.4", stubModelsClient(COST_INFO));

    await collectStreamEvents(client);

    expect(client.costFor({
      input: 1200,
      output: 300,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 80,
    })).toBeCloseTo((1200 * 2.5 + 300 * 15) / 1_000_000, 10);
  });

  it("uses the higher GPT-5.4 rate when prompt usage crosses 200k tokens", async () => {
    setMockResponseUsage({
      inputTokens: 220_000,
      outputTokens: 200,
      cachedTokens: 60_000,
      reasoningTokens: 50,
    });
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: "sk-test" };
    const client = createOpenAIAdapter(auth, "gpt-5.4", stubModelsClient(COST_INFO));

    const events = await collectStreamEvents(client);
    const usageEvent = events.find((event) => event.kind === "usage");
    const cost = client.costFor({
      input: 160_000,
      output: 200,
      cacheRead: 60_000,
      cacheWrite: 0,
      reasoning: 50,
    });

    expect(usageEvent).toMatchObject({
      inputTokens: 160_000,
      outputTokens: 200,
      cacheReadTokens: 60_000,
      reasoningTokens: 50,
    });
    expect(cost).toBeCloseTo((160_000 * 5 + 200 * 22.5 + 60_000 * 0.5) / 1_000_000, 10);
  });

  it("uses heuristic context limits when OpenAI model metadata is unavailable", () => {
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: "sk-test" };
    expect(createOpenAIAdapter(auth, "gpt-5.4", stubModelsClient()).contextLimit).toBe(128_000);
    expect(createOpenAIAdapter(auth, "o3-mini", stubModelsClient()).contextLimit).toBe(200_000);
  });

  it("returns a numeric cost value in apiKey mode before pricing is cached", () => {
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: "sk-test" };
    const client = createOpenAIAdapter(auth, "gpt-5.4", stubModelsClient(COST_INFO));
    const cost = client.costFor({
      input: 1000,
      output: 500,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    expect(typeof cost).toBe("number");
  });

  it("produces a client with provider 'openai' in apiKey mode (regression)", () => {
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: "sk-test" };
    const client = createOpenAIAdapter(auth, "gpt-5.4", stubModelsClient());
    expect(client.accessProvider).toBe("openai_api");
    expect(client.modelFamily).toBe("openai");
    expect(client.model).toBe("gpt-5.4");
  });
});

// ---------------------------------------------------------------------------
// createClient: env-based auth routing
// ---------------------------------------------------------------------------

describe("createClient — ChatGPT auth routing", () => {
  let createClient: typeof import("../src/orchestration/engines/providers/harness/llm/client-factory.js").createClient;

  beforeEach(async () => {
    const mod = await import("../src/orchestration/engines/providers/harness/llm/client-factory.js");
    createClient = mod.createClient;
  });

  it("existing behavior: requires OPENAI_API_KEY without chatgpt auth", () => {
    const auth = { openaiAuth: "api_key" as const, anthropicApiKey: undefined, openaiApiKey: undefined };
    expect(() => createClient("gpt-5.4", stubModelsClient(), auth)).toThrow("OPENAI_API_KEY");
  });

  it("existing behavior: works with OPENAI_API_KEY", () => {
    const auth = { openaiAuth: "api_key" as const, anthropicApiKey: undefined, openaiApiKey: "sk-test" };
    const client = createClient("gpt-5.4", stubModelsClient(), auth);
    expect(client.accessProvider).toBe("openai_api");
    expect(client.modelFamily).toBe("openai");
  });
});

// ---------------------------------------------------------------------------
// validateResolvedModels: ChatGPT auth exemption
// ---------------------------------------------------------------------------

describe("validateResolvedModels — chatgpt auth exemption", () => {
  let validateResolvedModels: typeof import("../src/orchestration/config/model-tiers.js").validateResolvedModels;

  beforeEach(async () => {
    const mod = await import("../src/orchestration/config/model-tiers.js");
    validateResolvedModels = mod.validateResolvedModels;
  });

  it("skips OPENAI_API_KEY check when openaiAuth is 'chatgpt'", () => {
    const models = [{ component: "worker", model: "gpt-5.4", engineId: "harness" }];
    const auth = { openaiAuth: "chatgpt" as const, anthropicApiKey: undefined, openaiApiKey: undefined };
    const errors = validateResolvedModels(models, auth);
    expect(errors).toEqual([]);
  });

  it("still requires OPENAI_API_KEY without chatgpt auth", () => {
    const models = [{ component: "worker", model: "gpt-5.4", engineId: "harness" }];
    const auth = { openaiAuth: "api_key" as const, anthropicApiKey: undefined, openaiApiKey: undefined };
    const errors = validateResolvedModels(models, auth);
    expect(errors.length).toBe(1);
    expect(errors[0]!.issue).toContain("OPENAI_API_KEY");
  });

  it("still requires ANTHROPIC_API_KEY regardless of chatgpt auth", () => {
    const models = [{ component: "worker", model: "claude-sonnet-4-6", engineId: "harness" }];
    const auth = { openaiAuth: "chatgpt" as const, anthropicApiKey: undefined, openaiApiKey: undefined };
    const errors = validateResolvedModels(models, auth);
    expect(errors.length).toBe(1);
    expect(errors[0]!.issue).toContain("ANTHROPIC_API_KEY");
  });
});
