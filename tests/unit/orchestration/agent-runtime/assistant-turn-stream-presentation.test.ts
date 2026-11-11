import { expect, test } from "bun:test";
import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream";
import { FUNCTION_TOOL_PRESENTATION, type ServingAttempt, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types";
import { resolveModelInteractionProfile } from "../../../../src/orchestration/agent-runtime/model-interaction-profile";
import type { AssistantTurnResult } from "../../../../src/orchestration/agent-runtime/assistant-turn-result.js";
import { withRequestAdmission } from "./_model-client.js";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

function assertCompleted(result: Awaited<ReturnType<typeof streamAssistantTurn>>): asserts result is AssistantTurnResult {
  if ("kind" in result && result.kind === "deferred_hard_cap") throw new Error("expected a completed assistant turn");
}

test("passes a planned shell tool to the provider unchanged", async () => {
  const captured: StreamOptions[] = [];
  const schema = {
    type: "object",
    properties: {
      command: { type: "string" },
      cwd: { type: "string" },
      timeout: { type: "number" },
      background: { type: "boolean" },
      raw_output: { type: "boolean" },
      persist_after_exit: { type: "boolean" },
    },
    required: ["command"],
  };
  const attempt: ServingAttempt = {
    accessProvider: "openai_api",
    modelFamily: "openai",
    model: "gpt-6-luna",
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
  };
  const client = withRequestAdmission({
    model: "gpt-6-luna",
    modelFamily: "openai",
    plannedAttempt: async () => attempt,
    async *streamWithTools(options) {
      captured.push(options);
      yield { kind: "tool_use", toolCall: { id: "call-shell", name: "bash", input: { command: "pwd" } } };
      yield { kind: "done", stopReason: "tool_use" };
    },
  });

  const result = await streamAssistantTurn({
    client,
    executionCwd: "/scratch",
    interactionProfile: resolveModelInteractionProfile("gpt-6-luna", "openai"),
    messages: [],
    tools: [{ name: "bash", description: "Execute a shell command", input_schema: schema }],
    systemPrompt: stableSystemPrompt("system"),
    reasoningEffort: undefined,
    signal: undefined,
    cacheRetention: "1h",
    providerSessionKey: undefined, promptCacheKey: undefined,
    providerOptions: undefined,
    requestContext: "main",
    requestAudit: undefined,
    staleMasking: undefined,
    turn: 1,
    messageCount: 0,
    estimatedContextTokens: 0,
    onEvent: () => {},
  });

  expect(captured[0]?.tools[0]).toMatchObject({
    name: "bash",
    description: "Execute a shell command",
    input_schema: schema,
  });
  assertCompleted(result);
  expect(result.toolCalls[0]).toMatchObject({ id: "call-shell", name: "bash", input: { command: "pwd" } });
});

