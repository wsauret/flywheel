import { describe, expect, test } from "bun:test";
import { createHarnessEngine } from "../src/orchestration/engines/providers/harness/engine";
import type { ModelsClient } from "../src/orchestration/engines/providers/harness/llm/models";
import type { LLMClient } from "../src/orchestration/engines/providers/harness/llm/types";

describe("harness engine model alias resolution", () => {
  function makeSpyEngine() {
    const receivedModels: string[] = [];

    const fakeModelsClient: ModelsClient = {
      budget: () => ({ contextLimit: 200_000, outputLimit: 16_000 }),
      costFor: () => 0,
    } as unknown as ModelsClient;

    const fakeLLMClient: LLMClient = {
      provider: "anthropic" as const,
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

  test("bare 'opus' resolves to full model ID", () => {
    const { engine, receivedModels } = makeSpyEngine();
    const runner = engine.createRunner({
      model: "opus",
      cwd: "/tmp",
      onEvent: () => {},
    });
    runner.send("test");
    expect(receivedModels).toContain("claude-opus-4-6");
  });

  test("bare 'sonnet' resolves to full model ID", () => {
    const { engine, receivedModels } = makeSpyEngine();
    const runner = engine.createRunner({
      model: "sonnet",
      cwd: "/tmp",
      onEvent: () => {},
    });
    runner.send("test");
    expect(receivedModels).toContain("claude-sonnet-4-6");
  });

  test("bare 'haiku' resolves to full model ID", () => {
    const { engine, receivedModels } = makeSpyEngine();
    const runner = engine.createRunner({
      model: "haiku",
      cwd: "/tmp",
      onEvent: () => {},
    });
    runner.send("test");
    expect(receivedModels).toContain("claude-haiku-4-5-20251001");
  });

  test("case-insensitive resolution: 'Opus', 'SONNET', ' haiku '", () => {
    for (const [input, expected] of [
      ["Opus", "claude-opus-4-6"],
      ["SONNET", "claude-sonnet-4-6"],
      [" haiku ", "claude-haiku-4-5-20251001"],
    ] as const) {
      const { engine, receivedModels } = makeSpyEngine();
      const runner = engine.createRunner({
        model: input,
        cwd: "/tmp",
        onEvent: () => {},
      });
      runner.send("test");
      expect(receivedModels[0]).toBe(expected);
    }
  });

  test("full model IDs pass through unchanged", () => {
    const { engine, receivedModels } = makeSpyEngine();
    const runner = engine.createRunner({
      model: "claude-opus-4-6",
      cwd: "/tmp",
      onEvent: () => {},
    });
    runner.send("test");
    expect(receivedModels).toContain("claude-opus-4-6");
  });

  test("unknown model names pass through unchanged", () => {
    const { engine, receivedModels } = makeSpyEngine();
    const runner = engine.createRunner({
      model: "gpt-4o",
      cwd: "/tmp",
      onEvent: () => {},
    });
    runner.send("test");
    expect(receivedModels).toContain("gpt-4o");
  });
});
