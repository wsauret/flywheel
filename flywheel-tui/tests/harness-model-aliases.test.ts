import { describe, expect, test } from "bun:test";
import { createHarnessEngine } from "../src/orchestration/engines/providers/harness/engine";
import type { ModelsClient } from "../src/orchestration/engines/providers/harness/llm/models";
import type { LLMClient } from "../src/orchestration/engines/providers/harness/llm/types";

const testAuth = {
  openaiAuth: "api_key" as const,
  anthropicApiKey: "test-anthropic",
  openaiApiKey: "test-openai",
};

describe("harness engine model passthrough", () => {
  function makeSpyEngine() {
    const receivedModels: string[] = [];

    const fakeModelsClient: ModelsClient = {
      budget: () => ({ contextLimit: 200_000, outputLimit: 16_000 }),
      costFor: () => 0,
    } as unknown as ModelsClient;

    const fakeLLMClient: LLMClient = {
      accessProvider: "anthropic_api" as const,
      modelFamily: "anthropic" as const,
      model: "test",
      contextLimit: 200_000,
      outputLimit: 16_000,
      supportsReasoning: false,
      costFor: () => 0,
      async *streamWithTools() {},
      async complete() { return ""; },
    };

    const engine = createHarnessEngine({
      modelsClient: fakeModelsClient,
      createLLMClient: (model: string) => {
        receivedModels.push(model);
        return fakeLLMClient;
      },
    });

    return { engine, receivedModels };
  }

  test("concrete Anthropic model IDs pass through unchanged", () => {
    for (const model of ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5-20251001"]) {
      const { engine, receivedModels } = makeSpyEngine();
      const runner = engine.createRunner({
        model,
        auth: testAuth,
        cwd: "/tmp",
        onEvent: () => {},
      });
      runner.send("test");
      expect(receivedModels[0]).toBe(model);
    }
  });

  test("OpenAI model IDs pass through unchanged", () => {
    const { engine, receivedModels } = makeSpyEngine();
    const runner = engine.createRunner({
      model: "gpt-4o",
      auth: testAuth,
      cwd: "/tmp",
      onEvent: () => {},
    });
    runner.send("test");
    expect(receivedModels).toContain("gpt-4o");
  });

  test("arbitrary model strings pass through unchanged", () => {
    const { engine, receivedModels } = makeSpyEngine();
    const runner = engine.createRunner({
      model: "some-custom-model-v2",
      auth: testAuth,
      cwd: "/tmp",
      onEvent: () => {},
    });
    runner.send("test");
    expect(receivedModels).toContain("some-custom-model-v2");
  });
});
