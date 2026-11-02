import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { z } from "zod";
import { wireClient } from "./_wire-fixtures.js";
import type { ModelInfo, ModelsClient } from "../../../../../src/infra/llm/models.js";
import { createOpenAIChatCompletionsAdapter } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions.js";


function stubModelsClient(): ModelsClient {
  return {
    async refresh() {},
    getProviderCatalog() { return [] },
    getTokenizerIdentity() { return undefined },
  };
}

const finishChunk = {
  id: "chatcmpl_1",
  choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

/** Captures the model param of every SDK call the adapter makes. */
function capturingClient(models: string[]): OpenAI {
  return wireClient([finishChunk], (params) => { models.push(z.string().parse(params.model)); });
}

describe("OpenRouter outbound wire model", () => {
  test.each([
    ["claude-opus-4-8", "anthropic/claude-opus-4.8"],
    ["o3-mini", "openai/o3-mini"],
    ["gemini-3.5-flash", "google/gemini-3.5-flash"],
    ["kimi-k3", "moonshotai/kimi-k3"],
  ])("streams %s as wire id %s", async (internal, wire) => {
    const models: string[] = [];
    const adapter = await createOpenAIChatCompletionsAdapter(capturingClient(models), internal, stubModelsClient(), {
      accessProvider: "openrouter",
      providerHint: "openrouter",
      wireModelId: wire,
    });
    for await (const _event of adapter.streamWithTools({ messages: [{ kind: "user", content: "hi" }], tools: [], systemPrompt: stableSystemPrompt("") })) { /* drain */ }
    expect(models).toEqual([wire]);
    expect(adapter.model).toBe(internal);
  });

  test.each([
    ["o3-mini", true, "developer"],
    ["o3-mini", false, "system"],
    ["claude-opus-4-8", true, "system"],
  ])("uses %s reasoning=%s with the %s prompt role", async (model, reasoning, role) => {
    const messages: Array<Array<{ role: string }>> = [];
    const client = wireClient([finishChunk], (params) => {
      messages.push(z.array(z.object({ role: z.string() })).parse(params.messages));
    });
    const info = { provider: "openrouter", family: "openai", id: model, name: model, reasoning, toolCall: true, attachment: false, temperature: true, contextLimit: 1000, outputLimit: 100, openWeights: false, cost: { input: 0, output: 0 }, pricing: { status: "unavailable", reason: "missing-rate-card" }, modalities: { input: ["text"], output: ["text"] } } satisfies ModelInfo;
    const modelsClient: ModelsClient = {
      async refresh() {},
      getProviderCatalog(providerIds) {
        return providerIds.includes(info.provider) ? [{
          providerId: info.provider, providerName: info.provider, wireModelId: info.id, metadata: info,
          provenance: "bundled", canonical: { providerId: info.provider, modelId: info.id }, transport: null,
        }] : [];
      },
      getTokenizerIdentity() { return undefined },
    };
    const wireModelId = model === "o3-mini" ? "openai/o3-mini" : "anthropic/claude-opus-4.8";
    const adapter = await createOpenAIChatCompletionsAdapter(client, model, modelsClient, {
      accessProvider: "openrouter", providerHint: "openrouter", wireModelId, resolvedModelMetadata: info,
    });

    for await (const _event of adapter.streamWithTools({ messages: [], tools: [], systemPrompt: stableSystemPrompt("instructions") })) { /* drain */ }

    expect(messages[0]?.[0]?.role).toBe(role);
  });

  test("non-OpenRouter access providers send the model unchanged", async () => {
    const models: string[] = [];
    const adapter = await createOpenAIChatCompletionsAdapter(capturingClient(models), "gpt-5.5", stubModelsClient(), {
      accessProvider: "github_copilot",
    });
    for await (const _event of adapter.streamWithTools({ messages: [{ kind: "user", content: "hi" }], tools: [], systemPrompt: stableSystemPrompt("") })) { /* drain */ }
    expect(models).toEqual(["gpt-5.5"]);
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
