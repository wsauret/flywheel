import { afterAll, describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { makeFakeLLMClient } from "./_loop-fixtures.js";
import { testBaseTools } from "../../../../helpers/request-tool-surface.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

// The builder takes the universal prompt as an input: production loads it from
// the startup-selected overlay roots, so these tests load the same source-tree
// copy from an empty project realm.
const promptRealmRoot = mkdtempSync(join(tmpdir(), "prompt-realm-"));
afterAll(() => rmSync(promptRealmRoot, { recursive: true, force: true }));


describe("agent loop provider metadata", () => {
  test("persists OpenAI assistant metadata from stream completion", async () => {
    const persisted: ConversationMessage[] = [];
    const client = makeFakeLLMClient([{ events: [
      { kind: "text_delta", text: "hello", blockKey: "text" },
      {
        kind: "done",
        stopReason: "end_turn",
        metadata: {
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5",
          responseId: "resp_123",
          stopReason: "end_turn",
          timestamp: 123,
        },
      },
    ] }]);

    await runAgentLoop({
      tools: testBaseTools(),
      client,
      systemPrompt: stableSystemPrompt("system"),
      instruction: "hi",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "provider-meta", promptCacheKey: "provider-meta", artifactScopeId: "provider-meta", retrievalSessionId: "provider-meta",
      persistence: { history: { append: (message) => { persisted.push(message); } } },
      seed: { kind: "fresh" },
      onEvent: () => {},
    });

    expect(persisted.at(-1)).toEqual({
      kind: "assistant",
      content: [{ type: "text", text: "hello" }],
      accessProvider: "anthropic_api",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5",
      responseId: "resp_123",
      stopReason: "end_turn",
      timestamp: 123,
    });
  });

});

