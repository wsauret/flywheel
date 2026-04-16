/**
 * Integration tests for the agent loop with real API calls.
 * Runs the full agentic cycle on both Anthropic and OpenAI.
 */
import { describe, it, expect } from "bun:test";
import { createModelsClient } from "../../src/orchestration/engines/providers/harness/llm/models";
import { createClient } from "../../src/orchestration/engines/providers/harness/llm/client-factory";
import { getToolDefinitions } from "../../src/orchestration/engines/providers/harness/tools/tool-dispatch";
import { runAgentLoop } from "../../src/orchestration/engines/providers/harness/agent-loop";
import { buildHarnessSystemPrompt } from "../../src/orchestration/engines/providers/harness/prompt";
import type { StreamEvent } from "../../src/orchestration/engines/providers/harness/llm/types";
import * as fs from "node:fs";

const toolDefs = getToolDefinitions().map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.input_schema,
}));

describe("Agent loop with Anthropic (real API)", () => {
  it("completes a simple file creation task", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/harness-test-");
    const modelsClient = createModelsClient();
    const client = createClient("claude-haiku-4-5-20251001", modelsClient);

    const events: StreamEvent[] = [];
    const result = await runAgentLoop({
      client,
      tools: toolDefs,
      systemPrompt: buildHarnessSystemPrompt("You are a helpful assistant.", "anthropic"),
      instruction: "Create a file called test.txt containing 'hello from anthropic'. Use the bash tool. Do NOT call write_handoff.",
      cwd: tmpDir,
      signal: AbortSignal.timeout(60_000),
      onEvent: (e) => events.push(e),
    });

    expect(result.completedNormally).toBe(true);

    const filePath = `${tmpDir}/test.txt`;
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
    expect(content).toContain("hello from anthropic");

    expect(events.some((e) => e.kind === "text_delta")).toBe(true);
    expect(events.some((e) => e.kind === "tool_use")).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 120_000);
});

describe("Agent loop with OpenAI (real API)", () => {
  it("completes a simple file creation task", async () => {
    const tmpDir = fs.mkdtempSync("/tmp/harness-test-");
    const modelsClient = createModelsClient();
    const client = createClient("gpt-4o-mini", modelsClient);

    const events: StreamEvent[] = [];
    const result = await runAgentLoop({
      client,
      tools: toolDefs,
      systemPrompt: buildHarnessSystemPrompt("You are a helpful assistant.", "openai"),
      instruction: "Create a file called test.txt containing 'hello from openai'. Use the bash tool. Do NOT call write_handoff.",
      cwd: tmpDir,
      signal: AbortSignal.timeout(60_000),
      onEvent: (e) => events.push(e),
    });

    expect(result.completedNormally).toBe(true);

    const filePath = `${tmpDir}/test.txt`;
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : "";
    expect(content).toContain("hello from openai");

    expect(events.some((e) => e.kind === "text_delta")).toBe(true);
    expect(events.some((e) => e.kind === "tool_use")).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 120_000);
});
