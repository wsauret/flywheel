/**
 * Agent loop integration tests (@slow).
 *
 * These tests make real API calls and require ANTHROPIC_API_KEY.
 * Skipped in CI — run manually with:
 *   bun test tests/harness/integration/agent-loop-validation.test.ts
 */

import { describe, it, expect, afterAll } from "bun:test";
import * as fs from "node:fs";
import { runAgentLoop } from "../../../src/harness/agent-loop.js";
import { AnthropicProvider } from "../../../src/harness/anthropic.js";
import { taskCompleteTool } from "../../../src/harness/tools/task-complete.js";
import { createReadTool } from "../../../src/harness/tools/read.js";
import { createBashTool } from "../../../src/harness/tools/bash.js";
import { editTool } from "../../../src/harness/tools/edit.js";
import { buildSystemPrompt, gatherWorkspaceContext } from "../../../src/harness/prompts.js";
import { createConsoleTracer } from "../../../src/harness/tracer.js";
import type { AgentLoopResult } from "../../../src/harness/agent-loop.js";

const TEMP_FILE = "/tmp/flywheel-test-edit.txt";

afterAll(() => {
  try { fs.unlinkSync(TEMP_FILE); } catch {}
});

describe.skipIf(!process.env.RUN_INTEGRATION)("Agent loop integration (@slow)", () => {
  it("read task: agent reads package.json and returns project name via task_complete", async () => {
    const provider = new AnthropicProvider();
    const context = await gatherWorkspaceContext();
    const systemPrompt = buildSystemPrompt(context);

    const result: AgentLoopResult = await runAgentLoop({
      provider,
      tools: [createReadTool(), taskCompleteTool],
      systemPrompt,
      initialMessage:
        "Read the package.json file in the current directory and return the project name via task_complete.",
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      maxTurns: 10,
      onTrace: createConsoleTracer({ verbose: true, model: "claude-sonnet-4-6" }),
    });

    expect(result.status).toBe("completed");
    expect(result.handoff).toBeDefined();
    expect(result.totalTurns).toBeGreaterThanOrEqual(2);
    expect(result.totalUsage.inputTokens).toBeGreaterThan(0);
  }, 120_000);

  it("edit task: agent creates a temp file and confirms via task_complete", async () => {
    const provider = new AnthropicProvider();
    const context = await gatherWorkspaceContext();
    const systemPrompt = buildSystemPrompt(context);

    const result: AgentLoopResult = await runAgentLoop({
      provider,
      tools: [createBashTool(), createReadTool(), editTool, taskCompleteTool],
      systemPrompt,
      initialMessage:
        `Create a file at ${TEMP_FILE} with the content 'hello world', then confirm via task_complete.`,
      model: "claude-sonnet-4-6",
      maxTokens: 4096,
      maxTurns: 15,
      onTrace: createConsoleTracer({ verbose: true, model: "claude-sonnet-4-6" }),
    });

    expect(result.status).toBe("completed");
    expect(result.handoff).toBeDefined();
    expect(result.totalTurns).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
