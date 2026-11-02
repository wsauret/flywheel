import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectModelFamily } from "../../../../../src/infra/llm/model-family.js";
import { stripProviderReasoningBlocks } from "../../../../../src/infra/llm/provider-reasoning-blocks.js";
import { createClient } from "../../../../../src/orchestration/agent-runtime/llm/client-factory.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { testProviderRegistry, testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import { fakeModelsClient } from "../../../../helpers/model-tier-fixtures.js";

/** Startup-selected project root every client in this file is built with. */
const CLIENT_OPTIONS = { notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(), projectRoot: "/scratch", providers: testProviderRegistry(), authDir: mkdtempSync(join(tmpdir(), "flywheel-routing-auth-")), profileId: "default", allowTrainingRoutes: false, requestAdmission: async () => Object.freeze({ spendSources: () => undefined, subscriptionSpendAuthorizationFor: () => undefined }) };
afterAll(() => rmSync(CLIENT_OPTIONS.authDir, { recursive: true, force: true }));

describe("detectModelFamily", () => {
  test("maps Copilot's OpenAI-compatible oswe/mai/kimi ids to openai", () => {
    expect(detectModelFamily("oswe-mini")).toBe("openai");
    expect(detectModelFamily("mai-code-1-flash-picker")).toBe("openai");
    expect(detectModelFamily("kimi-k2.7-code")).toBe("openai");
  });

  test("maps every OpenRouter slash id to its OpenAI-compatible transport", () => {
    expect(detectModelFamily("anthropic/claude-sonnet-4.5")).toBe("openai");
    expect(detectModelFamily("openai/gpt-6-luna")).toBe("openai");
    expect(detectModelFamily("meta-llama/llama-3.1-70b-instruct:free")).toBe("openai");
    expect(detectModelFamily("qwen/qwen3.7-max")).toBe("openai");
  });

});


describe("stripProviderReasoningBlocks", () => {
  test("removes provider metadata, signatures, thinking, and reasoning while preserving text and tool history", () => {
    const messages: ConversationMessage[] = [
      {
        kind: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-test",
        responseId: "resp-1",
        stopReason: "tool_use",
        timestamp: 123,
        content: [
          { type: "text", text: "before", signature: "text-sig" },
          { type: "thinking", thinking: "secret", signature: "sig" },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo hi" } },
          { type: "reasoning", id: "r1", encrypted_content: "encrypted" },
        ],
      },
      {
        kind: "toolResult",
        toolUseId: "tool-1",
        content: [{ type: "text", text: "hi" }],
      },
      { kind: "user", content: "plain text" },
    ];

    expect(stripProviderReasoningBlocks(messages)).toEqual([
      {
        kind: "assistant",
        content: [
          { type: "text", text: "before" },
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "echo hi" } },
        ],
      },
      {
        kind: "toolResult",
        toolUseId: "tool-1",
        content: [{ type: "text", text: "hi" }],
      },
      { kind: "user", content: "plain text" },
    ]);
  });
});

describe("createClient", () => {
  test("does not dispatch any model without catalog eligibility", async () => {
    await expect(createClient("claude-opus-4-6", fakeModelsClient, {
      providers: new Map(),
      credentialLineages: {},
      droppedCredentials: [],
    }, CLIENT_OPTIONS)).rejects.toThrow("Provider catalog eligibility is not ready");
  });
});
