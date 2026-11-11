import { describe, expect, test } from "bun:test";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { buildOpenAIParams } from "../../../../../src/orchestration/agent-runtime/llm/openai-helpers.js";
import type { ConversationMessage, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { toOpenAIResponsesInput } from "../../../../../src/orchestration/agent-runtime/llm/conversions/openai-responses.js";

const openai = { sharedHost: false, accessProvider: "github_copilot" as const, provider: "openai" as const, api: "openai-responses" as const, model: "gpt-5.5" };

function streamOptions(overrides?: Partial<StreamOptions>): StreamOptions {
  return {
    messages: [],
    tools: [],
    systemPrompt: stableSystemPrompt(""),
    ...overrides,
  };
}

const GPT_INFO: ModelInfo = {
  provider: "github-copilot",
  family: "openai",
  id: "gpt-5.5",
  name: "GPT 5.5",
  openWeights: false,
  reasoning: true,
  toolCall: true,
  attachment: false,
  temperature: true,
  contextLimit: 200_000,
  outputLimit: 16_384,
  cost: { input: 1, output: 1 },
  pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] },
};

describe("OpenAI Responses Copilot compatibility", () => {
  test("replays encrypted reasoning while preserving tool output", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: [{ type: "text", text: "inspect files" }] },
      {
        kind: "assistant",
        content: [
          {
            type: "reasoning",
            id: "opaque-copilot-reasoning-id",
            encrypted_content: "opaque-encrypted-content",
            summary: [{ type: "summary_text", text: "visible summary" }],
          },
          { type: "tool_use", id: "call_1", name: "list", input: { path: "." }, providerCallId: "call_1" },
        ],
        ...openai,
        timestamp: 1,
      },
      { kind: "toolResult", toolUseId: "call_1", content: [{ type: "text", text: "package.json" }] },
    ];

    const converted = toOpenAIResponsesInput(openai, history);
    const wire = JSON.stringify(converted);

    expect(wire).toContain("opaque-encrypted-content");
    expect(converted).toContainEqual({
      type: "reasoning",
      id: "opaque-copilot-reasoning-id",
      summary: [{ type: "summary_text", text: "visible summary" }],
      encrypted_content: "opaque-encrypted-content",
    });
    expect(converted.some((item) => item.type === "function_call_output" && item.call_id === "call_1")).toBe(true);
  });

  test("replays Copilot reasoning identically to the direct OpenAI path", () => {
    const turn: Extract<ConversationMessage, { kind: "assistant" }> = {
      kind: "assistant",
      content: [{ type: "reasoning", id: "rs_copilot", encrypted_content: "copilot-encrypted", summary: [{ type: "summary_text", text: "visible summary" }] }, { type: "text", text: "answer" }],
      ...openai,
      timestamp: 1,
    };
    const copilotItems = toOpenAIResponsesInput(openai, [turn]);
    const directItems = toOpenAIResponsesInput({ ...openai, accessProvider: "openai_api" }, [{ ...turn, accessProvider: "openai_api" }]);
    expect(copilotItems).toEqual(directItems);
    expect(JSON.stringify(copilotItems)).toContain("copilot-encrypted");
  });

  test("gates Copilot reasoning-off on model metadata alone", () => {
    const declaresNone = { ...GPT_INFO, reasoningEfforts: ["none", "low", "medium"] as const };
    const offCapable = buildOpenAIParams("gpt-5.5", [], undefined, [], false, "off", declaresNone, streamOptions(), "github_copilot");
    const offIncapable = buildOpenAIParams("gpt-5.5", [], undefined, [], false, "off", GPT_INFO, streamOptions(), "github_copilot");
    expect(offCapable.reasoning).toMatchObject({ effort: "none" });
    expect(offIncapable).not.toHaveProperty("reasoning");
  });

  test("drops Copilot wire identity when direct OpenAI replays canonical content", () => {
    const foreignId = `msg_${"x".repeat(408)}`;
    const history: ConversationMessage[] = [
      {
        kind: "assistant",
        content: [
          { type: "reasoning", id: "rs_copilot", encrypted_content: "copilot-encrypted", summary: [{ type: "summary_text", text: "visible reason" }] },
          { type: "text", text: "use the tool", signature: JSON.stringify({ v: 1, id: foreignId }) },
          { type: "tool_use", id: "canonical-call", providerCallId: "copilot-call", providerItemId: "fc_copilot", name: "list", input: { path: "." } },
        ],
        ...openai,
        timestamp: 1,
      },
      { kind: "toolResult", toolUseId: "canonical-call", content: [{ type: "text", text: "package.json" }] },
    ];

    const converted = toOpenAIResponsesInput({ ...openai, accessProvider: "openai_api" }, history);
    const wire = JSON.stringify(converted);

    expect(wire).not.toContain(foreignId);
    expect(wire).not.toContain("copilot-encrypted");
    expect(wire).not.toContain("fc_copilot");
    expect(wire).not.toContain("copilot-call");
    expect(wire).toContain("use the tool");
    expect(converted).toContainEqual({ type: "function_call", id: "fc_canonical-call_93bbf9905d7c6b29", call_id: "call_canonical-call_93bbf9905d7c6b29", name: "list", arguments: JSON.stringify({ path: "." }) });
    expect(converted).toContainEqual({ type: "function_call_output", call_id: "call_canonical-call_93bbf9905d7c6b29", output: "package.json" });
  });

  test("retains native wire identity for the same access provider", () => {
    const history: ConversationMessage[] = [
      {
        kind: "assistant",
        content: [
          { type: "text", text: "use the tool", signature: JSON.stringify({ v: 1, id: "msg_copilot" }) },
          { type: "tool_use", id: "canonical-call", providerCallId: "copilot-call", providerItemId: "item_copilot", name: "list", input: {} },
        ],
        ...openai,
        timestamp: 1,
      },
      { kind: "toolResult", toolUseId: "canonical-call", content: [{ type: "text", text: "package.json" }] },
    ];

    const converted = toOpenAIResponsesInput({ ...openai, accessProvider: "github_copilot" }, history);

    expect(converted).toContainEqual({ type: "function_call", id: "item_copilot", call_id: "copilot-call", name: "list", arguments: "{}" });
    expect(converted).toContainEqual({ type: "function_call_output", call_id: "copilot-call", output: "package.json" });
    expect(converted.some((item) => item.type === "message" && item.role === "assistant" && item.id === "msg_copilot")).toBe(true);
  });

  test("omits Copilot-only unsupported Responses parameters", () => {
    const params = buildOpenAIParams(
      "gpt-5.5",
      [],
      undefined,
      [],
      false,
      "low",
      GPT_INFO,
      streamOptions({ cacheRetention: "24h", promptCacheKey: "copilot-cache" }),
      "github_copilot",
    );

    expect(params).toMatchObject({
      reasoning: { effort: "low" },
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "copilot-cache",
      stream: true,
      store: false,
    });
    expect(params).not.toHaveProperty("prompt_cache_retention");
    expect(params).not.toHaveProperty("max_output_tokens");
  });

  test("keeps encrypted reasoning replay enabled on the OpenAI API path", () => {
    const params = buildOpenAIParams(
      "gpt-5.5",
      [],
      undefined,
      [],
      false,
      "low",
      GPT_INFO,
      streamOptions({ cacheRetention: "24h", promptCacheKey: "openai-cache" }),
      "openai_api",
    );

    expect(params).toMatchObject({
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: "openai-cache",
      prompt_cache_retention: "24h",
      max_output_tokens: 16_384,
    });
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
