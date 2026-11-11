/**
 * OpenRouter encrypted-reasoning round-trip on the chat-completions adapter.
 *
 * Reasoning models served through OpenRouter bind encrypted reasoning to tool
 * calls via `delta.reasoning_details`. The adapter must capture each detail as
 * the tool call's `thoughtSignature`, and the converter must replay it as
 * `reasoning_details` on the assistant message, or the tool-result
 * continuation is rejected with a 400.
 * Port source: pi `openai-completions.ts:547-560,:1161-1173`.
 */

import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { wireClient } from "./_wire-fixtures.js";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { createOpenAIChatCompletionsAdapter } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions.js";
import { toChatCompletionsMessages } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions-messages.js";

interface UnknownRecord { [key: string]: unknown }


const ENCRYPTED_DETAIL = { type: "reasoning.encrypted", id: "call_abc", data: "opaque-ciphertext" };
const MODEL_INFO: ModelInfo = {
  provider: "openrouter", family: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8",
  openWeights: false, reasoning: true, toolCall: true, attachment: false, temperature: true,
  contextLimit: 200_000, outputLimit: 64_000, cost: { input: 0, output: 0 },
  pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] },
};

function toolCallChunks(detailPosition: "before" | "after"): Array<UnknownRecord> {
  const detailChunk = {
    id: "chatcmpl_1",
    choices: [{ index: 0, delta: { reasoning_details: [ENCRYPTED_DETAIL] }, finish_reason: null }],
  };
  const toolChunk = {
    id: "chatcmpl_1",
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: "call_abc", function: { name: "read", arguments: "{\"path\":\"a\"}" } }] },
      finish_reason: null,
    }],
  };
  const finish = {
    id: "chatcmpl_1",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
  return detailPosition === "before" ? [detailChunk, toolChunk, finish] : [toolChunk, detailChunk, finish];
}

function clientWithChunks(chunks: Array<UnknownRecord>): OpenAI {
  return wireClient(chunks);
}

describe("OpenRouter reasoning_details capture", () => {
  test.each(["before", "after"] as const)(
    "binds an encrypted detail arriving %s the tool-call delta as thoughtSignature",
    async (position) => {
      const adapter = await createOpenAIChatCompletionsAdapter(
        clientWithChunks(toolCallChunks(position)),
        "claude-opus-4-8",
        MODEL_INFO,
        { accessProvider: "openrouter", providerHint: "openrouter" },
      );
      const events = [];
      for await (const event of adapter.streamWithTools({ messages: [{ kind: "user", content: "hi" }], tools: [], systemPrompt: stableSystemPrompt("") })) {
        events.push(event);
      }
      const toolUse = events.find((event) => event.kind === "tool_use");
      expect(toolUse).toMatchObject({
        toolCall: {
          id: "call_abc",
          name: "read",
          thoughtSignature: JSON.stringify(ENCRYPTED_DETAIL),
        },
      });
    },
  );

  test("malformed reasoning_details entries are ignored", async () => {
    const chunks = toolCallChunks("after");
    chunks.splice(1, 1, {
      id: "chatcmpl_1",
      choices: [{ index: 0, delta: { reasoning_details: [{ type: "reasoning.text", text: "visible" }, "junk", null] }, finish_reason: null }],
    });
    const adapter = await createOpenAIChatCompletionsAdapter(
      clientWithChunks(chunks),
      "claude-opus-4-8",
      MODEL_INFO,
      { accessProvider: "openrouter", providerHint: "openrouter" },
    );
    const events = [];
    for await (const event of adapter.streamWithTools({ messages: [{ kind: "user", content: "hi" }], tools: [], systemPrompt: stableSystemPrompt("") })) {
      events.push(event);
    }
    const toolUse = events.find((event) => event.kind === "tool_use");
    expect(toolUse?.kind === "tool_use" && toolUse.toolCall.thoughtSignature).toBeFalsy();
  });
});

describe("OpenRouter reasoning_details replay", () => {
  test("assistant tool calls with encrypted signatures replay reasoning_details", () => {
    const messages = toChatCompletionsMessages(
      [
        { kind: "user", content: "do it" },
        {
          kind: "assistant",
          // A turn that builds before 2026-10-27 stored with no access provider (`replayOf` in provider-history.ts).
          api: "openai-responses", provider: "openai", model: "test-model",
          content: [
            { type: "text", text: "working" },
            { type: "tool_use", id: "call_abc", name: "read", input: { path: "a" }, thoughtSignature: JSON.stringify(ENCRYPTED_DETAIL) },
          ],
        },
        { kind: "toolResult", toolUseId: "call_abc", content: [{ type: "text", text: "ok" }] },
      ],
      false,
      openAIResponsesTarget("openrouter", "test-model"),
    );
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toMatchObject({
      tool_calls: [{ id: "call_abc" }],
      reasoning_details: [ENCRYPTED_DETAIL],
    });
  });

  test("foreign signatures (Google opaque base64) do not become reasoning_details", () => {
    const messages = toChatCompletionsMessages(
      [
        { kind: "user", content: "do it" },
        {
          kind: "assistant",
          content: [{ type: "tool_use", id: "call_abc", name: "read", input: { path: "a" }, thoughtSignature: "b64opaqueSignature==" }],
        },
        { kind: "toolResult", toolUseId: "call_abc", content: [{ type: "text", text: "ok" }] },
      ],
      false,
      openAIResponsesTarget("openrouter", "test-model"),
    );
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect(Object.hasOwn(assistant ?? {}, "reasoning_details")).toBe(false);
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { openAIResponsesTarget } from "../../../../../src/orchestration/agent-runtime/llm/openai-adapter-helpers.js";
