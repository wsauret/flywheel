import { describe, expect, test } from "bun:test";
import { buildHarnessSystemPrompt } from "../src/orchestration/engines/providers/harness/prompt.js";
import { detectModelFamily } from "../src/orchestration/engines/providers/harness/llm/model-family.js";

describe("detectModelFamily", () => {
  test("detects anthropic family from claude model names", () => {
    expect(detectModelFamily("claude-sonnet-4-5")).toBe("anthropic");
    expect(detectModelFamily("claude-opus-4-7")).toBe("anthropic");
    expect(detectModelFamily("claude-haiku-4-5")).toBe("anthropic");
  });

  test("detects openai family from gpt/o-series model names", () => {
    expect(detectModelFamily("gpt-4o")).toBe("openai");
    expect(detectModelFamily("gpt-4o-mini")).toBe("openai");
    expect(detectModelFamily("o3")).toBe("openai");
    expect(detectModelFamily("o1-preview")).toBe("openai");
    expect(detectModelFamily("codex-mini")).toBe("openai");
    expect(detectModelFamily("chatgpt-4o-latest")).toBe("openai");
  });

  test("detects google family from gemini model names", () => {
    expect(detectModelFamily("gemini-2.5-pro")).toBe("google");
    expect(detectModelFamily("gemma-3")).toBe("google");
  });

  test("returns null for unknown models", () => {
    expect(detectModelFamily("llama-3")).toBeNull();
  });
});

describe("buildHarnessSystemPrompt — identity and constraints", () => {
  test("produces non-empty prompt with empty orchestration content", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      model: "claude-sonnet-4-5",
      availableTools: new Set(),
    });
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain("AI assistant");
  });

  test("contains identity text regardless of model family", () => {
    for (const model of ["claude-sonnet-4-5", "gpt-4o"]) {
      const prompt = buildHarnessSystemPrompt({
        orchestrationSystemPrompt: "",
        model,
        availableTools: new Set(),
      });
      expect(prompt).toContain("AI assistant");
    }
  });

  test("contains constraints regardless of model family", () => {
    for (const model of ["claude-sonnet-4-5", "gpt-4o"]) {
      const prompt = buildHarnessSystemPrompt({
        orchestrationSystemPrompt: "",
        model,
        availableTools: new Set(),
      });
      expect(prompt).toContain("Do NOT give up");
    }
  });

  test("identity and constraints appear even with empty tool set", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      model: "claude-sonnet-4-5",
      availableTools: new Set(),
    });
    expect(prompt).toContain("AI assistant");
    expect(prompt).toContain("Do NOT give up");
  });

  test("orchestration prompt appears after identity/constraints but before tool sections", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "ORCHESTRATION_MARKER",
      model: "claude-sonnet-4-5",
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
      model: "claude-sonnet-4-5",
      availableTools: new Set(["bash"]),
    });
    expect(prompt).toContain("RESOURCE LIMITS");
    expect(prompt).toContain("30KB");
  });

  test("omits resource limits when bash is not available", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      model: "claude-sonnet-4-5",
      availableTools: new Set(["read"]),
    });
    expect(prompt).not.toContain("RESOURCE LIMITS");
  });

  test("includes model-family-specific communication section", () => {
    const anthropicPrompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      model: "claude-sonnet-4-5",
      availableTools: new Set(),
    });
    const openaiPrompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      model: "gpt-4o",
      availableTools: new Set(),
    });
    for (const prompt of [anthropicPrompt, openaiPrompt]) {
      expect(prompt).toContain("COMMUNICATION");
      expect(prompt).toContain("No emojis");
    }
    expect(anthropicPrompt).toContain("25 words or fewer");
    expect(anthropicPrompt).not.toContain("critical to keep the user updated");
    expect(openaiPrompt).toContain("critical to keep the user updated");
    expect(openaiPrompt).not.toContain("25 words or fewer");
  });

  test("final answer guidance requires blank lines between all text blocks", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      model: "gpt-4o",
      availableTools: new Set(),
    });
    expect(prompt).toContain(
      "Leave a blank line between every paragraph, every bullet, and every other distinct block of text in the final response.",
    );
  });

  test("includes tool precedence rules when both bash and read are available", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      model: "claude-sonnet-4-5",
      availableTools: new Set(["bash", "read"]),
    });
    expect(prompt).toContain("TOOL USAGE");
    expect(prompt).toContain("todo_list");
  });
  test("names the harness-specific progress and handoff mechanisms", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      model: "claude-sonnet-4-5",
      availableTools: new Set(["todo_list", "write_handoff"]),
    });
    expect(prompt).toContain("`todo_list`");
    expect(prompt).toContain("`write_handoff`");
  });
});

describe("buildHarnessSystemPrompt — model-family behavioral tuning", () => {
  test("includes extended thinking note for anthropic-family models", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      model: "claude-sonnet-4-5",
      availableTools: new Set(["bash"]),
    });
    expect(prompt).toContain("MODEL NOTES");
    expect(prompt).toContain("extended thinking");
    expect(prompt).not.toContain("Use tools purposefully");
  });

  test("includes tool-purposefulness note for openai-family models", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      model: "gpt-4o",
      availableTools: new Set(["bash"]),
    });
    expect(prompt).toContain("MODEL NOTES");
    expect(prompt).toContain("Use tools purposefully");
    expect(prompt).not.toContain("extended thinking");
  });

  test("uses non-anthropic guidance for google-family models", () => {
    const prompt = buildHarnessSystemPrompt({
      orchestrationSystemPrompt: "",
      model: "gemini-2.5-pro",
      availableTools: new Set(["bash"]),
    });
    expect(prompt).toContain("MODEL NOTES");
    expect(prompt).toContain("Use tools purposefully");
    expect(prompt).not.toContain("extended thinking");
  });
});
