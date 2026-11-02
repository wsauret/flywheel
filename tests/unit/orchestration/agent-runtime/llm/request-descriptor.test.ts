import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { prepareAnthropicRequest } from "../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import { prepareOpenAICompletionsRequest } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions.js";
import { prepareOpenAIResponsesRequest } from "../../../../../src/orchestration/agent-runtime/llm/openai-responses.js";
import type { StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

const info: ModelInfo = {
  provider: "openai",
  family: "openai",
  id: "gpt-test",
  name: "GPT Test",
  reasoning: false,
  toolCall: true,
  attachment: false,
  temperature: true,
  openWeights: false,
  cost: { input: 0, output: 0 },
  pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] },
  contextLimit: 20_000,
  outputLimit: 4_000,
};

const options: StreamOptions = {
  messages: [{ kind: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [],
  systemPrompt: stableSystemPrompt("system"),
  cacheRetention: "none",
  estimatedContextTokens: 18_000,
  outputTokenLimit: 1_500,
};
const directOptions: StreamOptions = {
  messages: options.messages,
  tools: [],
  systemPrompt: stableSystemPrompt("system"),
  cacheRetention: "none",
};

describe("immutable prepared provider requests", () => {
  test("uses the actual API provider's cache policy without changing subscriptions", () => {
    const configured: StreamOptions = {
      ...directOptions,
      cacheRetention: "1h",
      providerSessionKey: "cache-policy",
      cacheRetentionPolicies: { anthropic_api: "5m", openai_api: "in_memory" },
    };
    const anthropic = prepareAnthropicRequest({
      accessProvider: "anthropic_api",
      model: "claude-test",
      wireModel: "claude-test",
      info: { ...info, provider: "anthropic", family: "anthropic" },
      options: configured,
    });
    const copilot = prepareAnthropicRequest({
      accessProvider: "github_copilot",
      model: "claude-test",
      wireModel: "claude-test",
      info: { ...info, provider: "anthropic", family: "anthropic" },
      options: configured,
    });
    const openai = prepareOpenAIResponsesRequest({
      accessProvider: "openai_api", model: "gpt-test", info, isChatGPT: false, options: configured,
    });
    const chatgpt = prepareOpenAIResponsesRequest({
      accessProvider: "chatgpt", model: "gpt-test", info, isChatGPT: true, options: configured,
    });

    expect(anthropic.cacheRetention).toBe("5m");
    expect(anthropic.params.system).toEqual([expect.objectContaining({ cache_control: { type: "ephemeral" } })]);
    expect(copilot.cacheRetention).toBe("1h");
    expect(copilot.params.system).toEqual([expect.objectContaining({ cache_control: { type: "ephemeral", ttl: "1h" } })]);
    expect(openai.params.prompt_cache_retention).toBe("in_memory");
    expect(openai.cacheRetention).toBe("in_memory");
    expect(openai.tokenClasses.cacheRetention).toBe("in_memory");
    expect(chatgpt.params.prompt_cache_retention).toBeUndefined();
    expect(chatgpt.cacheRetention).toBe("1h");
  });

  test("keeps explicit uncached requests uncached despite API policies", () => {
    const configured: StreamOptions = {
      ...directOptions,
      providerSessionKey: "cache-policy",
      cacheRetentionPolicies: { anthropic_api: "1h", openai_api: "24h" },
    };
    const anthropic = prepareAnthropicRequest({
      accessProvider: "anthropic_api", model: "claude-test", wireModel: "claude-test",
      info: { ...info, provider: "anthropic", family: "anthropic" }, options: configured,
    });
    const openai = prepareOpenAIResponsesRequest({
      accessProvider: "openai_api", model: "gpt-test", info, isChatGPT: false, options: configured,
    });

    expect(anthropic.cacheRetention).toBe("none");
    expect(anthropic.params.system).toEqual([expect.not.objectContaining({ cache_control: expect.anything() })]);
    expect(openai.cacheRetention).toBe("none");
    expect(openai.params.prompt_cache_retention).toBeUndefined();
    expect(openai.params.prompt_cache_key).toBeUndefined();
  });

  test("Anthropic states one origin for each block of the messages it sends, and none for the per-turn effort message", () => {
    const sonnet: ModelInfo = { ...info, provider: "anthropic", family: "anthropic", id: "claude-sonnet-5-5", reasoning: true, reasoningEfforts: ["low", "medium", "high", "max"] };
    const prepared = prepareAnthropicRequest({
      accessProvider: "anthropic_api", model: sonnet.id, wireModel: sonnet.id, info: sonnet,
      options: { ...directOptions, reasoningEffort: "low", messages: [
        { kind: "user", origin: "human", content: "Read it." },
        { kind: "user", origin: "system", framing: "reminder", content: "<system-reminder>\nCurrent local date: 2026-11-01.\n</system-reminder>\n" },
        { kind: "assistant", content: [{ type: "tool_use", id: "toolu_a", name: "read", input: {} }], provider: "anthropic", api: "anthropic-messages", model: sonnet.id, timestamp: 1 },
        { kind: "toolResult", toolUseId: "toolu_a", content: [{ type: "text", text: "a" }] },
        { kind: "user", content: "Continue smaller.", requestOnly: true },
      ] },
    });

    expect(prepared.params.messages.map((message) => message.role)).toEqual(["user", "system", "assistant", "user"]);
    expect(prepared.origins).toEqual([["person", "runtime-reminder"], [], ["assistant"], ["tool-result", "request-context"]]);
  });

  test("Anthropic request telemetry names the tool choice type it sent", () => {
    const prepared = (toolChoice: StreamOptions["toolChoice"]) => prepareAnthropicRequest({
      accessProvider: "anthropic_api", model: "claude-test", wireModel: "claude-test",
      info: { ...info, provider: "anthropic", family: "anthropic" }, options: { ...directOptions, ...(toolChoice === undefined ? {} : { toolChoice }) },
    }).telemetryMetadata;
    expect(prepared("any").toolChoiceType).toBe("any");
    expect(prepared({ type: "tool", name: "write_handoff" }).toolChoiceType).toBe("tool");
    expect(prepared(undefined)).not.toHaveProperty("toolChoiceType");
  });

  test("Anthropic captures its clamped output cap in the dispatched parameter authority", () => {
    const descriptor = prepareAnthropicRequest({
      accessProvider: "anthropic_api",
      model: "claude-test",
      wireModel: "claude-test",
      info: { ...info, provider: "anthropic", family: "anthropic" },
      contextLimit: 20_000,
      options,
    });

    expect(descriptor.endpoint).toBe("anthropic-messages");
    expect(descriptor.outputCap).toBe(1);
    expect(descriptor.params.max_tokens === descriptor.outputCap).toBe(true);
    expect(Object.isFrozen(descriptor)).toBe(true);
    expect(Object.isFrozen(descriptor.params)).toBe(true);

    const sharedCap = prepareAnthropicRequest({
      accessProvider: "anthropic_api",
      model: "claude-test",
      wireModel: "claude-test",
      info: { ...info, provider: "anthropic", family: "anthropic" },
      options,
    });
    expect(sharedCap.params.max_tokens).toBe(1_500);
  });

  test("Completions preserves endpoint-specific output-cap omission", () => {
    const copilot = prepareOpenAICompletionsRequest({
      accessProvider: "github_copilot",
      model: "gpt-test",
      wireModel: "gpt-test",
      info,
      options,
    });
    const openai = prepareOpenAICompletionsRequest({
      accessProvider: "openai_api",
      model: "gpt-test",
      wireModel: "gpt-test",
      info,
      options,
    });
    const openrouter = prepareOpenAICompletionsRequest({
      accessProvider: "openrouter",
      model: "gpt-test",
      wireModel: "openai/gpt-test",
      info,
      options,
    });
    const ordinaryCopilot = prepareOpenAICompletionsRequest({
      accessProvider: "github_copilot",
      model: "gpt-test",
      wireModel: "gpt-test",
      info,
      options: directOptions,
    });

    expect(copilot.outputCap).toBe(1_500);
    expect(copilot.params.max_completion_tokens).toBe(1_500);
    expect(openai.outputCap).toBe(1_500);
    expect(openai.params.max_completion_tokens).toBe(openai.outputCap);
    expect(openrouter.params.max_completion_tokens).toBe(1_500);
    expect(ordinaryCopilot.params.max_completion_tokens).toBeUndefined();
    expect(Object.isFrozen(openai.params.messages)).toBe(true);
  });

  test("Responses preserves endpoint-specific output-cap omission and normalized prompt", () => {
    const chatgpt = prepareOpenAIResponsesRequest({
      accessProvider: "chatgpt",
      model: "gpt-test",
      info,
      isChatGPT: true,
      options,
    });
    const openai = prepareOpenAIResponsesRequest({
      accessProvider: "openai_api",
      model: "gpt-test",
      info,
      isChatGPT: false,
      options,
    });
    const openrouter = prepareOpenAIResponsesRequest({
      accessProvider: "openrouter",
      model: "gpt-test",
      info,
      isChatGPT: false,
      options,
    });
    const ordinaryChatgpt = prepareOpenAIResponsesRequest({
      accessProvider: "chatgpt",
      model: "gpt-test",
      info,
      isChatGPT: true,
      options: directOptions,
    });

    expect(chatgpt.systemPrompt).toBe("system");
    expect(chatgpt.outputCap).toBe(1_500);
    expect(chatgpt.params.max_output_tokens).toBe(1_500);
    expect(openai.outputCap).toBe(1_500);
    expect(openai.params.max_output_tokens).toBe(openai.outputCap);
    expect(openrouter.params.max_output_tokens).toBe(1_500);
    expect(ordinaryChatgpt.params.max_output_tokens).toBeUndefined();
    expect(Object.isFrozen(openai.params.input)).toBe(true);
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
