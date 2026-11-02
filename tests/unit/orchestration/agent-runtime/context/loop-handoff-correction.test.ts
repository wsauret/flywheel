import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { HandoffCorrectionExhausted } from "../../../../../src/orchestration/agent-runtime/errors.js";
import { createHandoffTool } from "../../../../../src/orchestration/agent-runtime/tools/handoff.js";
import { makeCaptureClient } from "./_loop-fixtures.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import type { ProviderStreamEvent, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { ProviderRequestValidationError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";

// Item 3 of the Postel adoption list: the handoff correction loop is bounded.
// Workflow workers run without a maxLLMCalls cap, so without this bound a
// model that keeps failing handoff validation would retry forever. After
// three consecutive failed attempts the loop throws HandoffCorrectionExhausted,
// which is deliberately outside AgentRuntimeError: the run rejects with it
// rather than mapping it to a provider failure.

const REQUIRED_SUMMARY_SCHEMA = {
  input: { type: "object", properties: { summary: { type: "string", description: "Summary of work done" } }, required: ["summary"] },
} as const;

const handoffDirectory = temporaryDirectories();

function tempHandoffPath(): string {
  return join(handoffDirectory("flywheel-handoff-"), "handoff.json");
}

const requestRefusal = () => normalizeProviderAttemptFailure(new ProviderRequestValidationError("Anthropic", "the request ends with an assistant message"));

/** Refuses a request that ends with an assistant message, as every
 *  Anthropic-family route does. A loop that keeps sending such requests is
 *  cut by the run signal after a few refusals, so the test fails instead of hanging. */
function refuseTrailingAssistant(abort: AbortController) {
  let refused = 0;
  return (options: StreamOptions) => {
    if (options.messages.at(-1)?.kind !== "assistant") return;
    if (++refused >= 5) abort.abort();
    throw requestRefusal();
  };
}

function failingHandoffTurn(id: string) {
  return {
    events: [
      // Missing the required `summary` field → handoff returns a correction error.
      { kind: "tool_use", toolCall: { id, name: "handoff", input: { wrong_field: "oops" } } },
      { kind: "done", stopReason: "tool_use" },
    ] satisfies ProviderStreamEvent[],
  };
}

describe("agent-loop bounded handoff correction", () => {
  test.each(["text-only", "blocked-tool"] as const)("exhausts admitted corrections after %s responses without a handoff", async (kind) => {
    let ran = 0, closed = 0;
    const extra: RuntimeTool = {
      name: "later", action: "ui_meta", description: "later", isConcurrencySafe: true,
      inputSchema: { type: "object", properties: {} },
      execute: async () => { ran++; return { content: "ran", outcome: "ok" }; },
    };
    const correction = (id: string) => ({
      events: kind === "text-only"
        ? [{ kind: "text_delta", text: "Not a handoff.", blockKey: id }, { kind: "done", stopReason: "end_turn" }]
        : [{ kind: "tool_use", toolCall: { id, name: "later", input: {} } }, { kind: "done", stopReason: "tool_use" }],
    } satisfies { events: ProviderStreamEvent[] });
    const abort = new AbortController();
    const { client, capturedMessages } = makeCaptureClient([
      failingHandoffTurn("invalid"), correction("second"), correction("third"),
      { events: [
        { kind: "tool_use", toolCall: { id: "fallback", name: "handoff", input: { summary: "too late" } } },
        { kind: "done", stopReason: "tool_use" },
      ] },
    ], { onRequest: refuseTrailingAssistant(abort) });
    const run = runAgentLoop({
      signal: abort.signal,
      client, systemPrompt: stableSystemPrompt("test"), instruction: "go", executionCwd: "/scratch",
      projectRoot: "/scratch", userDataRoot: "/scratch/account", providerSessionKey: "correction", promptCacheKey: "correction", artifactScopeId: "correction", retrievalSessionId: "correction",
      persistence: { history: { append() {} } }, seed: { kind: "fresh" },
      handoff: { onContent() {} }, onEvent() {}, lifecycle: { onHandoffStarted() { closed++; } },
      tools: new RequestToolMap([["handoff", createHandoffTool({ schema: REQUIRED_SUMMARY_SCHEMA })], ["later", extra]]),
      maxLLMCalls: 2,
    });
    await expect(run).rejects.toThrow(HandoffCorrectionExhausted);
    expect([ran, closed, capturedMessages.length]).toEqual([0, 1, 3]);
    expect(JSON.stringify(capturedMessages[2])).toContain("session ended");
  });

  test("a failed request after handoff admission takes the error path once instead of requesting again", async () => {
    const abort = new AbortController();
    let requests = 0;
    const { client } = makeCaptureClient([failingHandoffTurn("invalid")], {
      onRequest: () => {
        if (++requests === 1) return;
        if (requests >= 5) abort.abort();
        throw requestRefusal();
      },
    });
    const run = runAgentLoop({
      client, systemPrompt: stableSystemPrompt("test"), instruction: "go", executionCwd: "/scratch", signal: abort.signal,
      projectRoot: "/scratch", userDataRoot: "/scratch/account", providerSessionKey: "correction", promptCacheKey: "correction", artifactScopeId: "correction", retrievalSessionId: "correction",
      persistence: { history: { append() {} } }, seed: { kind: "fresh" },
      handoff: { onContent() {} }, onEvent() {}, lifecycle: { onHandoffStarted() {} },
      tools: new RequestToolMap([["handoff", createHandoffTool({ schema: REQUIRED_SUMMARY_SCHEMA })]]),
    });
    await expect(run).rejects.toThrow("request validation failed");
    expect(requests).toBe(2);
  });

  test("an invalid admitted handoff allows only a correction, not ordinary tools in this or the next response", async () => {
    let ran = 0, closed = 0;
    const extra: RuntimeTool = { name: "later", action: "ui_meta", description: "later", isConcurrencySafe: true, inputSchema: { type: "object", properties: {} },
      execute: async () => { ran++; return { content: "ran", outcome: "ok" }; } };
    const { client, capturedMessages } = makeCaptureClient([
      failingHandoffTurn("invalid"),
      { events: [
        { kind: "tool_use", toolCall: { id: "late", name: "later", input: {} } },
        { kind: "tool_use", toolCall: { id: "fixed", name: "handoff", input: { summary: "done" } } },
        { kind: "done", stopReason: "tool_use" },
      ] },
    ]);
    const result = await runAgentLoop({
      client, systemPrompt: stableSystemPrompt("test"), instruction: "go", executionCwd: "/scratch",
      projectRoot: "/scratch", userDataRoot: "/scratch/account", providerSessionKey: "correction", promptCacheKey: "correction", artifactScopeId: "correction", retrievalSessionId: "correction",
      persistence: { history: { append() {} } }, seed: { kind: "fresh" },
      handoff: { onContent() {} }, onEvent() {}, lifecycle: { onHandoffStarted() { closed++; } },
      tools: new RequestToolMap([["handoff", createHandoffTool({ schema: REQUIRED_SUMMARY_SCHEMA })], ["later", extra]]),
    });
    expect(result).toEqual({ kind: "completed" });
    expect([ran, closed, capturedMessages.length]).toEqual([0, 1, 2]);
  });

  test("three consecutive failed handoff attempts abort the loop with HandoffCorrectionExhausted", async () => {
    const handoffPath = tempHandoffPath();
    const { client, capturedMessages } = makeCaptureClient([
      failingHandoffTurn("tc_1"),
      failingHandoffTurn("tc_2"),
      failingHandoffTurn("tc_3"),
    ]);

    const run = runAgentLoop({
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "produce handoff",
      executionCwd: "/scratch",
      projectRoot: "/scratch", userDataRoot: "/scratch/account", providerSessionKey: "correction", promptCacheKey: "correction", artifactScopeId: "correction", retrievalSessionId: "correction",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      handoff: { onContent: (content) => { writeFileSync(handoffPath, JSON.stringify(content, null, 2)); } },
      onEvent: () => {},
      tools: new RequestToolMap([["handoff", createHandoffTool({ schema: REQUIRED_SUMMARY_SCHEMA })]]),
    });

    await expect(run).rejects.toThrow(HandoffCorrectionExhausted);
    // The model got exactly two correction turns after the first failure.
    expect(capturedMessages).toHaveLength(3);
  });
});
