import { describe, expect, test } from "bun:test";
import { buildHarnessSystemPrompt } from "../src/orchestration/engines/providers/harness/prompt.js";

describe("buildHarnessSystemPrompt — identity and constraints", () => {
  test("produces non-empty prompt with empty orchestration content", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      provider: "anthropic",
      availableTools: new Set(),
    });
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("AI assistant");
  });

  test("contains identity text regardless of provider", () => {
    for (const provider of ["anthropic", "openai"] as const) {
      const prompt = buildHarnessSystemPrompt({
        orchestrationSystemPrompt: "",
        provider,
        availableTools: new Set(),
      });
      expect(prompt).toContain("AI assistant");
    }
  });

  test("contains constraints regardless of provider", () => {
    for (const provider of ["anthropic", "openai"] as const) {
      const prompt = buildHarnessSystemPrompt({
        orchestrationSystemPrompt: "",
        provider,
        availableTools: new Set(),
      });
      expect(prompt).toContain("Do NOT give up");
    }
  });

  test("identity and constraints appear even with empty tool set", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      provider: "anthropic",
      availableTools: new Set(),
    });
    expect(prompt).toContain("AI assistant");
    expect(prompt).toContain("Do NOT give up");
  });

  test("orchestration prompt appears after identity/constraints but before tool sections", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "ORCHESTRATION_MARKER",
      provider: "anthropic",
      availableTools: new Set(["bash"]),
    });
    const identityIdx = prompt.indexOf("AI assistant");
    const constraintsIdx = prompt.indexOf("Do NOT give up");
    const orchIdx = prompt.indexOf("ORCHESTRATION_MARKER");
    const shellIdx = prompt.indexOf("EXECUTION ENVIRONMENT");
    expect(identityIdx).toBeLessThan(orchIdx);
    expect(constraintsIdx).toBeLessThan(orchIdx);
    expect(orchIdx).toBeLessThan(shellIdx);
  });
});

describe("buildHarnessSystemPrompt — resource limits, style, and tool precedence", () => {
  test("includes resource limits when bash is available", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      provider: "anthropic",
      availableTools: new Set(["bash"]),
    });
    expect(prompt).toContain("RESOURCE LIMITS");
    expect(prompt).toContain("30KB");
  });

  test("omits resource limits when bash is not available", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      provider: "anthropic",
      availableTools: new Set(["read"]),
    });
    expect(prompt).not.toContain("RESOURCE LIMITS");
  });

  test("includes style section regardless of provider or tools", () => {
    for (const provider of ["anthropic", "openai"] as const) {
      const prompt = buildHarnessSystemPrompt({
        orchestrationSystemPrompt: "",
        provider,
        availableTools: new Set(),
      });
      expect(prompt).toContain("STYLE");
      expect(prompt).toContain("No emojis");
    }
  });

  test("includes tool precedence rules when both bash and read are available", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      provider: "anthropic",
      availableTools: new Set(["bash", "read"]),
    });
    expect(prompt).toContain("TOOL USAGE");
    expect(prompt).toContain("todo_list");
  });
});

describe("buildHarnessSystemPrompt — provider behavioral tuning", () => {
  test("includes OpenAI behavioral guidance for openai provider", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      provider: "openai",
      availableTools: new Set(["bash"]),
    });
    expect(prompt).toContain("OPENAI MODEL NOTES");
    expect(prompt).toContain("apply_patch");
  });

  test("includes Anthropic behavioral guidance for anthropic provider", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      provider: "anthropic",
      availableTools: new Set(["bash"]),
    });
    expect(prompt).toContain("ANTHROPIC MODEL NOTES");
    expect(prompt).toContain("extended thinking");
  });

  test("OpenAI prompt does not contain anthropic behavioral text", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      provider: "openai",
      availableTools: new Set(["bash"]),
    });
    expect(prompt).not.toContain("ANTHROPIC MODEL NOTES");
  });

  test("Anthropic prompt does not contain OpenAI behavioral text", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      provider: "anthropic",
      availableTools: new Set(["bash"]),
    });
    expect(prompt).not.toContain("OPENAI MODEL NOTES");
  });
});
