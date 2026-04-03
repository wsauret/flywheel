import { describe, it, expect } from "bun:test";
import { harnessEngine, metadata } from "../../src/engines/providers/harness";
import { getEngine } from "../../src/engines/core/registry";

describe("Engine: harness — metadata", () => {
  it("has correct id", () => {
    expect(metadata.id).toBe("harness");
  });

  it("has correct name", () => {
    expect(metadata.name).toBe("Harness");
  });

  it("has synthetic cliBinary", () => {
    expect(metadata.cliBinary).toBe("harness");
  });

  it("defaults to claude-sonnet-4-6", () => {
    expect(metadata.defaultModel).toBe("claude-sonnet-4-6");
  });

  it("does not support tool scoping", () => {
    expect(metadata.supportsToolScoping).toBe(false);
  });

  it("does not support streaming input", () => {
    expect(metadata.supportsStreamingInput).toBe(false);
  });

  it("has order 4", () => {
    expect(metadata.order).toBe(4);
  });

  it("has a description", () => {
    expect(metadata.description).toBeTruthy();
  });

  it("has install command", () => {
    expect(metadata.installCommand).toBeTruthy();
  });
});

describe("Engine: harness — buildCommand", () => {
  it("returns synthetic command with stdinPrompt true", () => {
    const cmd = harnessEngine.buildCommand({ prompt: "do stuff" });
    expect(cmd.command).toBe("harness");
    expect(cmd.stdinPrompt).toBe(true);
  });

  it("passes model via --model flag when provided", () => {
    const cmd = harnessEngine.buildCommand({
      prompt: "do stuff",
      model: "claude-opus-4-6",
    });
    expect(cmd.args).toContain("--model");
    expect(cmd.args).toContain("claude-opus-4-6");
  });

  it("omits --model when model is undefined", () => {
    const cmd = harnessEngine.buildCommand({ prompt: "do stuff" });
    expect(cmd.args).not.toContain("--model");
  });

  it("ignores toolScoping (harness manages tools internally)", () => {
    const cmd = harnessEngine.buildCommand({
      prompt: "do stuff",
      toolScoping: { read: true, bash: false, write: false, edit: false },
    });
    expect(cmd.args).not.toContain("--tools");
    expect(cmd.args).not.toContain("--disabled-tools");
  });
});

describe("Engine: harness — buildDispatcherCommand", () => {
  it("defaults to sonnet model", () => {
    const cmd = harnessEngine.buildDispatcherCommand({
      prompt: "dispatch",
      systemPrompt: "You are a dispatcher.",
    });
    expect(cmd.args).toContain("--model");
    const idx = cmd.args.indexOf("--model");
    expect(cmd.args[idx + 1]).toBe("claude-sonnet-4-6");
  });

  it("uses custom model when provided", () => {
    const cmd = harnessEngine.buildDispatcherCommand({
      prompt: "dispatch",
      systemPrompt: "You are a dispatcher.",
      model: "claude-haiku-4-5",
    });
    const idx = cmd.args.indexOf("--model");
    expect(cmd.args[idx + 1]).toBe("claude-haiku-4-5");
  });

  it("returns stdinPrompt true", () => {
    const cmd = harnessEngine.buildDispatcherCommand({
      prompt: "dispatch",
      systemPrompt: "You are a dispatcher.",
    });
    expect(cmd.stdinPrompt).toBe(true);
  });
});

describe("Engine: harness — buildEvaluatorCommand", () => {
  it("defaults to sonnet model", () => {
    const cmd = harnessEngine.buildEvaluatorCommand({
      prompt: "evaluate",
      systemPrompt: "You are an evaluator.",
    });
    expect(cmd.args).toContain("--model");
    const idx = cmd.args.indexOf("--model");
    expect(cmd.args[idx + 1]).toBe("claude-sonnet-4-6");
  });

  it("uses custom model when provided", () => {
    const cmd = harnessEngine.buildEvaluatorCommand({
      prompt: "evaluate",
      systemPrompt: "You are an evaluator.",
      model: "claude-opus-4-6",
    });
    const idx = cmd.args.indexOf("--model");
    expect(cmd.args[idx + 1]).toBe("claude-opus-4-6");
  });
});

describe("Engine: harness — listModels", () => {
  it("returns 3 Claude models", async () => {
    const models = await harnessEngine.listModels();
    expect(models).toHaveLength(3);
  });

  it("includes opus, sonnet, and haiku families", async () => {
    const models = await harnessEngine.listModels();
    const families = models.map((m) => m.family);
    expect(families).toContain("opus");
    expect(families).toContain("sonnet");
    expect(families).toContain("haiku");
  });

  it("all models are aliases", async () => {
    const models = await harnessEngine.listModels();
    for (const model of models) {
      expect(model.isAlias).toBe(true);
    }
  });
});

describe("Engine registry — harness", () => {
  it("getEngine('harness') returns harness engine", () => {
    const engine = getEngine("harness");
    expect(engine.metadata.id).toBe("harness");
    expect(engine.metadata.name).toBe("Harness");
  });
});
