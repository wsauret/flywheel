import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../../../../../src/infra/llm/models/models.js";
import { prepareAnthropicRequest } from "../../../../../src/orchestration/agent-runtime/llm/adapters/anthropic/anthropic.js";
import { prepareOpenAIResponsesRequest } from "../../../../../src/orchestration/agent-runtime/llm/adapters/openai/openai-responses.js";
import type { StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { ConversationMessage } from "../../../../../src/infra/llm/conversation/conversation-message.js";
import { chatCompletionsRequestBody } from "./_wire-fixtures.js";

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
      ] },
    });

    expect(prepared.params.messages.map((message) => message.role)).toEqual(["user", "system", "assistant", "user"]);
    expect(prepared.origins).toEqual([["person", "runtime-reminder"], [], ["assistant"], ["tool-result"]]);
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

  // A short-form tool's open object root (ARCH-CONTEXT-038) reaches every endpoint unchanged.
  test("Anthropic, Completions, and Responses send a short-form tool's open object schema unchanged", async () => {
    const schema = { type: "object", properties: {}, additionalProperties: true };
    const withShortForm: StreamOptions = { ...directOptions, tools: [{ name: "web", description: "Research the web.", input_schema: schema }] };
    const anthropic = prepareAnthropicRequest({ accessProvider: "anthropic_api", model: "claude-test", wireModel: "claude-test", info, options: withShortForm });
    const completions = await chatCompletionsRequestBody({ accessProvider: "openai_api", model: "gpt-test", info, options: withShortForm });
    const responses = prepareOpenAIResponsesRequest({ accessProvider: "openai_api", model: "gpt-test", info, isChatGPT: false, options: withShortForm });

    expect(anthropic.params.tools).toEqual([expect.objectContaining({ name: "web", input_schema: schema })]);
    expect(completions.tools).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: "web", parameters: schema }) })]);
    expect(responses.params.tools).toEqual([expect.objectContaining({ type: "function", name: "web", parameters: schema })]);
  });

  test("Completions preserves endpoint-specific output-cap omission", async () => {
    const copilot = await chatCompletionsRequestBody({ accessProvider: "github_copilot", model: "gpt-test", info, options });
    const openai = await chatCompletionsRequestBody({ accessProvider: "openai_api", model: "gpt-test", info, options });
    const openrouter = await chatCompletionsRequestBody({ accessProvider: "openrouter", model: "gpt-test", wireModelId: "openai/gpt-test", info, options });
    const ordinaryCopilot = await chatCompletionsRequestBody({ accessProvider: "github_copilot", model: "gpt-test", info, options: directOptions });

    expect(copilot.max_completion_tokens).toBe(1_500);
    expect(openai.max_completion_tokens).toBe(1_500);
    expect(openrouter.max_completion_tokens).toBe(1_500);
    expect(ordinaryCopilot.max_completion_tokens).toBeUndefined();
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

  // ARCH-PROVIDERS-084: the system prompt opens the input, so a later change of the history never moves it.
  test.each(["openai_api", "chatgpt", "github_copilot"] as const)("Responses on %s sends the system prompt as the first developer item and no instructions", (accessProvider) => {
    const prepared = prepareOpenAIResponsesRequest({ accessProvider, model: "gpt-test", info, isChatGPT: accessProvider === "chatgpt", options });

    expect(prepared.params).not.toHaveProperty("instructions");
    expect(prepared.params.input).toEqual([
      { role: "developer", content: [{ type: "input_text", text: "system" }] },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
    expect(prepared.systemPrompt).toBe("system");
    expect(prepared.messages).toEqual([{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
  });
});

describe("a change of effort inside a Responses conversation (ARCH-CONTEXT-041)", () => {
  const sol: ModelInfo = { ...info, id: "gpt-6.2-sol", reasoning: true, reasoningEfforts: ["none", "low", "medium", "high", "xhigh"] };
  const answer = (text: string, reasoningEffort: StreamOptions["reasoningEffort"], model = sol.id): Extract<ConversationMessage, { kind: "assistant" }> => ({
    kind: "assistant", content: [{ type: "text", text }], accessProvider: "chatgpt", provider: "openai", api: "openai-responses", model, timestamp: 1, stopReason: "end_turn", ...(reasoningEffort ? { reasoningEffort } : {}),
  });
  const ask = (text: string): ConversationMessage => ({ kind: "user", content: text });
  const prepare = (messages: ConversationMessage[], reasoningEffort: StreamOptions["reasoningEffort"], accessProvider: "chatgpt" | "openai_api" | "github_copilot" = "chatgpt", model = sol.id) =>
    prepareOpenAIResponsesRequest({ accessProvider, model, info: { ...sol, id: model }, isChatGPT: accessProvider === "chatgpt", options: { ...directOptions, messages, reasoningEffort } });
  const update = (effort: "low" | "high") => ({ type: "configuration_update" as const, reasoning: { effort } });
  const inputOf = (prepared: ReturnType<typeof prepare>) => Array.isArray(prepared.params.input) ? prepared.params.input : [];
  const updates = (prepared: ReturnType<typeof prepare>) => inputOf(prepared).filter((item) => item.type === "configuration_update");

  test("keeps the opening effort on the request and appends the change after the history, at the same place on later requests", () => {
    const changed = prepare([ask("q1"), answer("a1", "high"), ask("q2")], "low");
    const later = prepare([ask("q1"), answer("a1", "high"), ask("q2"), answer("a2", "low"), ask("q3")], "low");

    expect(changed.params.reasoning).toMatchObject({ effort: "high" });
    expect(inputOf(changed).at(-1)).toEqual(update("low"));
    expect(later.params.reasoning).toMatchObject({ effort: "high" });
    expect(inputOf(later).slice(0, inputOf(changed).length)).toEqual(inputOf(changed));
    expect(updates(later)).toEqual([update("low")]);
  });

  test("keeps a change in place when its response was interrupted and the turn resumes", () => {
    const changed = prepare([ask("q1"), answer("a1", "high"), ask("q2")], "low");
    const partial: ConversationMessage = { ...answer("part", "low"), incomplete: true, stopReason: "aborted" };
    const resumed = prepare([ask("q1"), answer("a1", "high"), ask("q2"), partial], "low");
    const joined = prepare([ask("q1"), answer("a1", "high"), ask("q2"), partial, answer("rest", "low"), ask("q3")], "low");

    for (const prepared of [resumed, joined]) {
      expect(prepared.params.reasoning).toMatchObject({ effort: "high" });
      expect(inputOf(prepared).slice(0, inputOf(changed).length)).toEqual(inputOf(changed));
      expect(updates(prepared)).toEqual([update("low")]);
    }
  });

  test("opens the baseline at the first effort that the model takes on the wire", () => {
    const noOff: ModelInfo = { ...sol, reasoningEfforts: ["low", "medium", "high"] };
    const prepared = prepareOpenAIResponsesRequest({
      accessProvider: "chatgpt", model: sol.id, info: noOff, isChatGPT: true,
      options: { ...directOptions, reasoningEffort: "low", messages: [ask("q1"), answer("a1", "off"), ask("q2"), answer("a2", "high"), ask("q3")] },
    });

    expect(prepared.params.reasoning).toMatchObject({ effort: "high" });
    expect(inputOf(prepared).at(-1)).toEqual(update("low"));
  });

  test("asks for replayable reasoning when an update raises the effort of a conversation that opened without reasoning", () => {
    const raised = prepare([ask("q1"), answer("a1", "off"), ask("q2")], "high", "openai_api");

    expect(raised.params.reasoning).toEqual({ effort: "none", summary: "auto" });
    expect(raised.params.include).toEqual(["reasoning.encrypted_content"]);
    expect(inputOf(raised).at(-1)).toEqual(update("high"));
  });

  test("sends no update while the effort stays the opening one", () => {
    const steady = prepare([ask("q1"), answer("a1", "high"), ask("q2")], "high", "openai_api");

    expect(steady.params.reasoning).toMatchObject({ effort: "high" });
    expect(updates(steady)).toEqual([]);
  });

  test("opens a new baseline after a compaction and after a model switch", () => {
    const compacted = prepare([ask("q1"), answer("a1", "high"), { kind: "compactionSummary", content: "summary" }, ask("q2"), answer("a2", "low"), ask("q3")], "low");
    const switched = prepare([ask("q1"), answer("a1", "high", "gpt-6.1-sol"), ask("q2")], "low");

    for (const prepared of [compacted, switched]) {
      expect(prepared.params.reasoning).toMatchObject({ effort: "low" });
      expect(updates(prepared)).toEqual([]);
    }
  });

  test("changes the request effort on a model or a route that takes no appended update", () => {
    const history = [ask("q1"), answer("a1", "high", "gpt-6-luna"), ask("q2")];
    const luna = prepare(history, "low", "chatgpt", "gpt-6-luna");
    const copilot = prepare([ask("q1"), answer("a1", "high"), ask("q2")], "low", "github_copilot");

    for (const prepared of [luna, copilot]) {
      expect(prepared.params.reasoning).toMatchObject({ effort: "low" });
      expect(updates(prepared)).toEqual([]);
    }
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
