import { describe, expect, it, beforeEach } from "bun:test";
import { Redacted } from "effect";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { wireResponse } from "./_wire-fixtures.js";
import type { ModelsClient, ModelInfo, ReasoningEffort } from "../../../../../src/infra/llm/models.js";
import { createAnthropicAdapter, operationsFromAnthropicClient, prepareAnthropicRequest } from "../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import type { ConversationMessage, LLMClient } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";

interface UnknownRecord {
  [key: string]: unknown;
}

const MODEL_INFO: ModelInfo = {
  provider: "anthropic",
  family: "anthropic",
  id: "claude-haiku-4-5",
  name: "Claude Haiku 4.5",
  reasoning: false,
  toolCall: true,
  attachment: false,
  temperature: true,
  openWeights: false,
  cost: { input: 0, output: 0 },
  pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] },
  contextLimit: 200_000,
  outputLimit: 16_384,
};
const fixtureModelInfos = new WeakMap<ModelsClient, ModelInfo>();

function stubModelsClient(info: ModelInfo = MODEL_INFO): ModelsClient {
  const client: ModelsClient = {
    async refresh() {},
    getProviderCatalog(providerIds) {
      return providerIds.includes(info.provider) ? [{
        providerId: info.provider, providerName: info.provider, wireModelId: info.id, metadata: info,
        provenance: "bundled", canonical: { providerId: info.provider, modelId: info.id }, transport: null,
      }] : [];
    },
    getTokenizerIdentity() { return undefined; },
  };
  fixtureModelInfos.set(client, info);
  return client;
}

let lastCreateParams: UnknownRecord | undefined;
let lastCreateOptions: { headers: Headers } | undefined;
let invocationOrder: string[] = [];

const fakeAnthropicOperations = operationsFromAnthropicClient(new Anthropic({
  apiKey: "test-key",
  maxRetries: 0,
  fetch: async (input, init) => {
    invocationOrder.push("sdk");
    const request = new Request(input, init);
    lastCreateParams = z.record(z.string(), z.unknown()).parse(await request.json());
    lastCreateOptions = { headers: request.headers };
    return wireResponse([
      { type: "message_start", message: { id: "msg_test", usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ]);
  },
}));

function createTestAnthropicAdapter(
  apiKey: string,
  model: string,
  modelsClient: ModelsClient,
  overrides: NonNullable<Parameters<typeof createAnthropicAdapter>[3]> = {},
): Promise<LLMClient> {
  return createAnthropicAdapter(Redacted.make(apiKey), model, modelsClient, {
    resolvedModelMetadata: fixtureModelInfos.get(modelsClient) ?? MODEL_INFO,
    ...overrides,
    operations: fakeAnthropicOperations,
  });
}

async function collect(
  client: LLMClient,
  overrides: Partial<Parameters<LLMClient["streamWithTools"]>[0]> = {},
): Promise<void> {
  for await (const _event of client.streamWithTools({
    messages: [{ kind: "user", content: "hi" }],
    systemPrompt: stableSystemPrompt("system"),
    tools: [{ name: "bash", description: "Run a command", input_schema: { type: "object" } }],
    reasoningEffort: "off",
    ...overrides,
  })) {}
}

  it("settles dispatch before SDK invocation and rejection prevents invocation", async () => {
    invocationOrder = [];
    const client = await createTestAnthropicAdapter("key", "claude-haiku-4-5", stubModelsClient());

    await collect(client, { onDispatch: async () => { invocationOrder.push("settled"); } });
    expect(invocationOrder).toEqual(["settled", "sdk"]);

    invocationOrder = [];
    await expect(collect(client, { onDispatch: async () => { throw new Error("dispatch rejected"); } })).rejects.toThrow("dispatch rejected");
    expect(invocationOrder).toEqual([]);
  });

describe("Anthropic adapter request configuration", () => {
  it("prepares provider wire names without changing canonical history", () => {
    const messages = [
      { kind: "user" as const, content: "hi" },
      { kind: "assistant" as const, content: [{ type: "tool_use" as const, id: "call", name: "bash", input: {} }] },
    ];
    const original = structuredClone(messages);
    const tools = [
      { name: "bash", description: "Ｒｕｎ a command", input_schema: { type: "object", title: "Ｔｉｔｌｅ" } },
      { name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    ];
    const originalTools = structuredClone(tools);
    const prepared = prepareAnthropicRequest({
      accessProvider: "anthropic_api", model: MODEL_INFO.id, wireModel: MODEL_INFO.id, info: MODEL_INFO,
      presentation: {
        format: "namespaced",
        present: (tool) => ({ kind: "function", description: tool.name === "read" ? "Presented read" : tool.description, inputFormat: tool.input_schema }),
        wireName: (name) => `mcp__runtime__${name === "bash" ? "z_bash" : "a_read"}`,
      },
      options: {
        messages, tools,
        systemPrompt: stableSystemPrompt("custom system"), cacheRetention: "1h",
        toolChoice: { type: "tool", name: "bash" }, reasoningEffort: "off",
      },
    });
    expect<unknown>(prepared.params.tools).toEqual([
      { name: "mcp__runtime__z_bash", description: "Run a command", input_schema: { type: "object", title: "Title" }, eager_input_streaming: true },
      { name: "mcp__runtime__a_read", description: "Presented read", input_schema: tools[1]!.input_schema, eager_input_streaming: true, cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(prepared.params.tool_choice).toEqual({ type: "tool", name: "mcp__runtime__z_bash" });
    expect(prepared.params.messages[1]?.content).toEqual([expect.objectContaining({ type: "tool_use", name: "mcp__runtime__z_bash", input: {} })]);
    expect(prepared.params.system).toEqual([
      { type: "text", text: "custom system", cache_control: { type: "ephemeral", ttl: "1h" } },
    ]);
    expect(prepared.systemPrompt).toEqual(prepared.params.system);
    expect(Object.isFrozen(prepared.params)).toBe(true);
    expect(messages).toEqual(original);
    expect(tools).toEqual(originalTools);
  });
  // The expected text is what the Claude engine (CLI 2.1.296) sent for the same definition on a local host: NFKC, then no
  // format, private-use, or unassigned character, in every string and key, at every depth.
  it("sends each tool definition in the text form of the Claude engine", () => {
    const prepared = prepareAnthropicRequest({
      accessProvider: "anthropic_api", model: MODEL_INFO.id, wireModel: MODEL_INFO.id, info: MODEL_INFO,
      options: {
        messages: [{ kind: "user", content: "hi" }], systemPrompt: stableSystemPrompt("Keep \u200B and µ."), reasoningEffort: "off",
        tools: [{
          name: "probe",
          description: "Units in µs: zero\u200Bwidth, \u202Ebidi\u202C, bom\uFEFF, pua\uE000, ﬁle.",
          input_schema: {
            type: "object",
            properties: {
              "k\u200Bey": { type: "string", enum: ["µ", "a\u2066b\u2069", "plain"], description: "Pick one.\uFEFF" },
              mode: { const: "Ａ", default: "x\u200Dy" },
            },
            required: ["k\u200Bey"],
          },
        }],
      },
    });
    expect<unknown>(prepared.params.tools).toEqual([{
      name: "probe",
      description: "Units in μs: zerowidth, bidi, bom, pua, file.",
      input_schema: {
        type: "object",
        properties: { key: { type: "string", enum: ["μ", "ab", "plain"], description: "Pick one." }, mode: { const: "A", default: "xy" } },
        required: ["key"],
      },
      eager_input_streaming: true,
      cache_control: { type: "ephemeral" },
    }]);
    expect(prepared.params.system).toEqual([{ type: "text", text: "Keep \u200B and µ.", cache_control: { type: "ephemeral" } }]);
  });
  // The expected values are the first-party request that the Claude engine (CLI 2.1.306) sends from the Agent SDK for
  // claude-sonnet-5-5 at a 1M context with tools and adaptive thinking, captured on a local host. Its credential
  // and identity opt-ins (claude-code-20250219, oauth-2025-04-20, extended-cache-ttl-2025-04-11) stay out.
  it("sends the Claude engine's first-party opt-ins on the Anthropic API route", () => {
    const sonnet: ModelInfo = { ...MODEL_INFO, id: "claude-sonnet-5-5", reasoning: true, contextLimit: 1_000_000, outputLimit: 128_000 };
    const prepare = (contextLimit: number, reasoningEffort: "medium" | "off") => prepareAnthropicRequest({
      accessProvider: "anthropic_api", model: sonnet.id, wireModel: sonnet.id, info: sonnet, contextLimit,
      options: { messages: [{ kind: "user", content: "hi" }], tools: [{ name: "bash", description: "Run", input_schema: { type: "object" } }], systemPrompt: stableSystemPrompt("system"), reasoningEffort },
    });
    const extended = prepare(1_000_000, "medium");
    expect(extended.betaHeader.split(",")).toEqual([
      "context-1m-2025-08-07",
      "interleaved-thinking-2025-05-14",
      "thinking-token-count-2026-05-13",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "per-turn-control-2026-07-01",
      "effort-2025-11-24",
    ]);
    expect(extended.params.context_management).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
    expect(extended.params.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(extended.params.output_config).toEqual({ effort: "medium" });

    const standard = prepare(200_000, "medium");
    expect(standard.betaHeader).not.toContain("context-1m-2025-08-07");
    // Sonnet 5.5 still uses adaptive thinking at off, so its thinking edit stays active.
    expect(prepare(1_000_000, "off").params.context_management).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
  });

  // The Claude engine (CLI 2.1.306) sends a per-turn-effort model's effort inside the conversation too, captured on a local
  // host: on a system message directly after the first user run when every turn ran at the request's effort.
  it("copies the effort after the first user run on per-turn-effort models of the Anthropic API route", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "hi" },
      { kind: "assistant", content: [{ type: "text", text: "Hello." }] },
      { kind: "user", content: "Next." },
    ];
    const prepare = (model: string, reasoningEffort: ReasoningEffort, accessProvider: AccessProviderId = "anthropic_api", messages = history) => {
      const info: ModelInfo = { ...MODEL_INFO, id: model, reasoning: true, reasoningEfforts: ["low", "medium", "high", "max"], outputLimit: 64_000 };
      return prepareAnthropicRequest({ accessProvider, model, wireModel: model, info, options: { messages, tools: [], systemPrompt: stableSystemPrompt("system"), reasoningEffort } });
    };
    const roles = ({ params }: ReturnType<typeof prepare>) => params.messages.map((message) => "output_config" in message ? { role: message.role, content: message.content, output_config: message.output_config } : message.role);

    for (const model of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1"]) {
      expect(roles(prepare(model, "low")), model).toEqual(["user", { role: "system", content: [], output_config: { effort: "low" } }, "assistant", "user"]);
    }
    const sonnet = prepare("claude-sonnet-5-5", "xhigh");
    expect(sonnet.params.output_config).toEqual({ effort: "max" });
    expect(roles(sonnet)).toEqual(["user", { role: "system", content: [], output_config: { effort: "max" } }, "assistant", "user"]);
    expect(roles(prepare("claude-sonnet-5-5", "medium", "anthropic_api", [{ kind: "user", content: "hi" }]))).toEqual(["user", { role: "system", content: [], output_config: { effort: "medium" } }]);
    // No copy without an effort, on a model that the engine gives no per-turn effort, or off the first-party route.
    expect(roles(prepare("claude-sonnet-5-5", "off"))).toEqual(["user", "assistant", "user"]);
    expect(roles(prepare("claude-opus-4-6", "low"))).toEqual(["user", "assistant", "user"]);
    expect(roles(prepare("claude-sonnet-5-5", "low", "github_copilot"))).toEqual(["user", "assistant", "user"]);
    // The beta that opens the copy follows the engine's model rule too. The engine sends no beta for a system message
    // inside the conversation since CLI 2.1.306.
    const betas = (model: string) => prepare(model, "low").betaHeader.split(",").filter((beta) => beta === "mid-conversation-system-2026-04-07" || beta === "per-turn-control-2026-07-01");
    expect(betas("claude-sonnet-5-5")).toEqual(["per-turn-control-2026-07-01"]);
    expect(betas("claude-mythos-5-1")).toEqual([]);
    expect(betas("claude-opus-4-6")).toEqual([]);
    expect(betas("claude-sonnet-4-5-20250929")).toEqual([]);
  });

  beforeEach(() => {
    lastCreateParams = undefined;
    lastCreateOptions = undefined;
  });

  it("requests progress updates by default for supported first-party models", async () => {
    const client = await createTestAnthropicAdapter("test-key", "claude-fable-5-1", stubModelsClient({
      ...MODEL_INFO, id: "claude-fable-5-1", reasoning: true,
    }));
    await collect(client, { reasoningEffort: "medium" });
    expect(lastCreateParams?.thinking).toEqual({ type: "adaptive", display: "updates" });
    const beta = lastCreateOptions?.headers.get("anthropic-beta");
    expect(beta).toContain("thinking-display-updates-2026-08-18");
    expect(beta).not.toContain("redact-thinking-2026-02-12");
  });

  it("honors explicit omitted and summarized display on supported models", async () => {
    const client = await createTestAnthropicAdapter("test-key", "claude-fable-5-1", stubModelsClient({
      ...MODEL_INFO, id: "claude-fable-5-1", reasoning: true,
    }));
    for (const display of ["omitted", "summarized"] as const) {
      await collect(client, { reasoningEffort: "medium", providerOptions: { anthropic: { thinking_display: display } } });
      expect(lastCreateParams?.thinking).toEqual({ type: "adaptive", display });
      expect(lastCreateOptions?.headers.get("anthropic-beta")).not.toContain("thinking-display-updates");
    }
  });

  it("keeps proxy defaults unchanged and sends no updates beta when thinking is off", async () => {
    const info = stubModelsClient({ ...MODEL_INFO, id: "claude-fable-5-1", reasoning: true });
    const proxy = await createTestAnthropicAdapter("test-key", "claude-fable-5-1", info, { accessProvider: "github_copilot" });
    await collect(proxy, { reasoningEffort: "medium" });
    expect(lastCreateParams?.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(lastCreateOptions?.headers.get("anthropic-beta")).not.toContain("thinking-display-updates");
    const direct = await createTestAnthropicAdapter("test-key", "claude-fable-5-1", info);
    await collect(direct, { reasoningEffort: "off" });
    expect(lastCreateOptions?.headers.get("anthropic-beta")).not.toContain("thinking-display-updates");
  });

  it("sends eager tool input streaming and no thinking param on a non-reasoning model (anthropic API)", async () => {
    const client = await createTestAnthropicAdapter("[redacted secret]", "claude-haiku-4-5", stubModelsClient());

    await collect(client);

    // For Anthropic: on anthropic_api, eager_input_streaming on tools is the new mode;
    // `fine-grained-tool-streaming-2025-05-14` is the opt-in for the LEGACY
    // mode and is mutually exclusive with eager_input_streaming. Never both.
    const beta = new Headers(lastCreateOptions?.headers).get("anthropic-beta") ?? "";
    expect(beta).not.toContain("fine-grained-tool-streaming-2025-05-14");
    // Non-reasoning models never take a thinking param (pi gates
    // the whole block on model.reasoning, `anthropic-messages.ts:1028`).
    expect(lastCreateParams?.thinking).toBeUndefined();
    expect(lastCreateParams?.tools).toMatchObject([{ eager_input_streaming: true }]);
  });

  it.each([
    ["claude-haiku-4-5", "disabled"],
    ["claude-haiku-5.5", "disabled"],
    ["claude-opus-5", "disabled"],
    ["claude-opus-5-5", "adaptive"],
    ["claude-opus-5.5", "adaptive"],
    ["claude-sonnet-5-5", "adaptive"],
    ["claude-sonnet-5.5", "adaptive"],
  ] as const)("sends accepted off thinking for %s with no temperature or effort", async (model, thinking) => {
    const client = await createTestAnthropicAdapter("sk-test", model, stubModelsClient({
      ...MODEL_INFO,
      id: model,
      reasoning: true,
    }));

    await collect(client, { reasoningEffort: "off" });

    expect(lastCreateParams?.thinking).toEqual(thinking === "adaptive" ? { type: "adaptive", display: "summarized" } : { type: "disabled" });
    expect(lastCreateParams?.output_config).toBeUndefined();
    // Temperature 1 is the API default and Opus 4.7+ rejects the field; the
    // off request must not send it.
    expect(lastCreateParams?.temperature).toBeUndefined();
  });

  it("omits the thinking param for always-thinking models that reject disabled", async () => {
    const client = await createTestAnthropicAdapter("sk-test", "claude-fable-5", stubModelsClient({
      ...MODEL_INFO,
      id: "claude-fable-5",
      reasoning: true,
    }));

    await collect(client, { reasoningEffort: "off" });

    // fable-class models 400 terminally on thinking:{type:"disabled"}
    // (pi marks them thinkingLevelMap.off: null); the request
    // omits the param and lets the model think.
    expect(lastCreateParams?.thinking).toBeUndefined();
  });

  it("maps adaptive thinking effort by model and applies display", async () => {
    const client = await createTestAnthropicAdapter("[redacted secret]", "claude-opus-4-6", stubModelsClient({
      ...MODEL_INFO,
      id: "claude-opus-4-6",
      reasoning: true,
      // Real models.dev declaration: Opus 4.6 has max but not xhigh, so a
      // requested xhigh rounds up to max.
      reasoningEfforts: ["low", "medium", "high", "max"],
      outputLimit: 64_000,
    }));

    await collect(client, {
      reasoningEffort: "xhigh",
      providerOptions: {
        anthropic: {
          thinking_display: "omitted",
          extra_body: { container: "test-container", thinking: { type: "disabled" } },
        },
      },
    });

    expect(lastCreateParams?.thinking).toEqual({ type: "adaptive", display: "omitted" });
    expect(lastCreateParams?.output_config).toEqual({ effort: "max" });
    expect(lastCreateParams?.container).toBe("test-container");
  });

  it("defaults supported Fable models to adaptive thinking with progress updates", async () => {
    const client = await createTestAnthropicAdapter("sk-test", "claude-fable-5", stubModelsClient({
      ...MODEL_INFO,
      id: "claude-fable-5",
      name: "Claude Fable 5",
      reasoning: true,
      releaseDate: "2026-02-01",
      outputLimit: 128_000,
    }));

    await collect(client, { reasoningEffort: "xhigh" });

    expect(lastCreateParams?.thinking).toEqual({ type: "adaptive", display: "updates" });
    expect(lastCreateParams?.output_config).toEqual({ effort: "high" });
  });

  it("keeps legacy dated Claude snapshots on budget-based thinking", async () => {
    const client = await createTestAnthropicAdapter("sk-test", "claude-sonnet-4-20250514", stubModelsClient({
      ...MODEL_INFO,
      id: "claude-sonnet-4-20250514",
      name: "Claude Sonnet 4",
      reasoning: true,
      releaseDate: "2025-05-14",
      outputLimit: 64_000,
    }));

    await collect(client, { reasoningEffort: "medium" });

    expect(lastCreateParams?.thinking).toEqual({
      type: "enabled",
      budget_tokens: 8_192,
      display: "summarized",
    });
    expect(lastCreateParams?.output_config).toBeUndefined();
  });

  it("uses bounded budget-based thinking for non-adaptive Claude models", async () => {
    const client = await createTestAnthropicAdapter("sk-test", "claude-sonnet-4-5", stubModelsClient({
      ...MODEL_INFO,
      id: "claude-sonnet-4-5",
      reasoning: true,
      outputLimit: 64_000,
    }));

    await collect(client, { reasoningEffort: "medium" });

    expect(lastCreateParams?.thinking).toEqual({
      type: "enabled",
      budget_tokens: 8_192,
      display: "summarized",
    });
  });

  it("keeps Copilot's advertised Claude wire id unchanged", async () => {
    const lookups: string[] = [];
    const modelsClient: ModelsClient = {
      async refresh() {},
      getProviderCatalog(providerIds) {
        lookups.push(...providerIds);
        const info = { ...MODEL_INFO, id: "claude-sonnet-4-6" };
        return providerIds.includes(info.provider) ? [{
          providerId: info.provider, providerName: info.provider, wireModelId: info.id, metadata: info,
          provenance: "bundled", canonical: { providerId: info.provider, modelId: info.id }, transport: null,
        }] : [];
      },
      getTokenizerIdentity() { return undefined; },
    };
    const client = await createTestAnthropicAdapter("copilot", "claude-sonnet-4-6", modelsClient, {
      accessProvider: "github_copilot",
    });

    await collect(client);

    expect(client.model).toBe("claude-sonnet-4-6");
    expect(lookups.every((id) => id === "claude-sonnet-4-6")).toBe(true);
    expect(lastCreateParams?.model).toBe("claude-sonnet-4-6");
  });

  it("sends speed and the fast-mode beta when providerOptions request fast mode", async () => {
    const client = await createTestAnthropicAdapter("[redacted secret]", "claude-opus-4-6", stubModelsClient({
      ...MODEL_INFO,
      id: "claude-opus-4-6",
      reasoning: true,
    }));

    await collect(client, { providerOptions: { anthropic: { speed: "fast" } } });

    expect(lastCreateParams?.speed).toBe("fast");
    const beta = new Headers(lastCreateOptions?.headers).get("anthropic-beta") ?? "";
    expect(beta).toContain("fast-mode-2026-02-01");
  });

  it("never sends fast mode on the Copilot path", async () => {
    const client = await createTestAnthropicAdapter("copilot", "claude-sonnet-4-6", stubModelsClient({
      ...MODEL_INFO,
      id: "claude-sonnet-4-6",
    }), { accessProvider: "github_copilot" });

    await collect(client, { providerOptions: { anthropic: { speed: "fast" } } });

    expect(lastCreateParams?.speed).toBeUndefined();
    const beta = new Headers(lastCreateOptions?.headers).get("anthropic-beta") ?? "";
    expect(beta).not.toContain("fast-mode-2026-02-01");
  });

  it("strips a reserved speed key from extra_body so it cannot bypass the typed option", async () => {
    const client = await createTestAnthropicAdapter("[redacted secret]", "claude-opus-4-6", stubModelsClient({
      ...MODEL_INFO,
      id: "claude-opus-4-6",
      reasoning: true,
    }));

    await collect(client, { providerOptions: { anthropic: { extra_body: { speed: "fast" } } } });

    expect(lastCreateParams?.speed).toBeUndefined();
    const beta = new Headers(lastCreateOptions?.headers).get("anthropic-beta") ?? "";
    expect(beta).not.toContain("fast-mode-2026-02-01");
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
