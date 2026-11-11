import { describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { FUNCTION_TOOL_PRESENTATION, type ContentBlock, type ConversationMessage, type LLMClient, type ModelClient, type ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { asModelClient, ownHistoryTarget } from "../_model-client.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

function makeClient(turns: Array<() => AsyncGenerator<ProviderStreamEvent>>): ModelClient & { calls: () => number } {
  let call = 0;
  const adapter: LLMClient = { historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
      const turn = turns[Math.min(call, turns.length - 1)];
      call++;
      if (!turn) throw new Error("no turn defined");
      return turn();
    },
    priceFor() {
      return { status: "unavailable", reason: "missing-rate-card" };
    },
  };
  return { ...asModelClient(adapter), calls: () => call };
}

async function* contentFilterTurn(): AsyncGenerator<ProviderStreamEvent> {
  yield { kind: "done", stopReason: "content_filter" };
}

async function* toolCallTurn(): AsyncGenerator<ProviderStreamEvent> {
  yield { kind: "tool_use", toolCall: { id: "tc_1", name: "missing_tool", input: {} } };
  yield { kind: "done", stopReason: "tool_use" };
}

async function* endTurn(): AsyncGenerator<ProviderStreamEvent> {
  yield { kind: "text_delta", text: "Recovered answer.", blockKey: "text" };
  yield { kind: "done", stopReason: "end_turn" };
}

describe("agent loop content_filter recovery", () => {
  test("auto-continues with a nudge after a content_filter stop", async () => {
    const client = makeClient([contentFilterTurn, endTurn]);
    const userMessages: Array<string | ContentBlock[]> = [];
    const canonical: ConversationMessage[] = [];
    const endings: Array<true | undefined> = [];

    const result = await runAgentLoop({
      lifecycle: { onTurnEnded: (ctx) => { endings.push(ctx.contentRefused); } },
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "content-filter", promptCacheKey: "content-filter", artifactScopeId: "content-filter", retrievalSessionId: "content-filter",
      onEvent: () => {},
      onUserMessage: (content) => { userMessages.push(content); },
      persistence: { history: { append: (message) => { canonical.push(message); } } },
      seed: { kind: "fresh" },
    });

    expect(result.kind).toBe("completed");
    expect(client.calls()).toBe(2);
    expect(userMessages).toHaveLength(2);
    expect(userMessages[1]).toContain("content filter");
    expect(endings).toEqual([undefined]);
  });

  test("gives up after consecutive content_filter stops and surfaces a visible notice", async () => {
    const client = makeClient([contentFilterTurn]);
    const userMessages: Array<string | ContentBlock[]> = [];
    const systemMessages: Array<{ message: string; level?: "info" | "error" }> = [];
    const endings: Array<true | undefined> = [];

    const result = await runAgentLoop({
      lifecycle: { onTurnEnded: (ctx) => { endings.push(ctx.contentRefused); } },
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "content-filter", promptCacheKey: "content-filter", artifactScopeId: "content-filter", retrievalSessionId: "content-filter",
      onEvent: () => {},
      onUserMessage: (content) => { userMessages.push(content); },
      onSystemMessage: (message, level) => { systemMessages.push({ message, level }); },
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
    });

    // 1 initial call + 2 capped retries, then the loop ends the turn normally.
    expect(result.kind).toBe("completed");
    expect(client.calls()).toBe(3);
    expect(userMessages).toHaveLength(3);
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]?.message).toContain("Rephrase the request or try a different model");
    expect(systemMessages[0]?.message).not.toContain("session");
    expect(systemMessages[0]?.level).toBe("error");
    // The turn ends as the provider's refusal of the content, which a headless caller reports.
    expect(endings).toEqual([true]);
  });

  test("resets the consecutive counter on intervening non-filtered turns", async () => {
    // Three isolated filter stops separated by successful tool-call turns must
    // each retry (consecutive semantics), never reaching the give-up cap.
    const client = makeClient([contentFilterTurn, toolCallTurn, contentFilterTurn, toolCallTurn, contentFilterTurn, endTurn]);
    const systemMessages: string[] = [];

    const result = await runAgentLoop({
      client,
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "content-filter", promptCacheKey: "content-filter", artifactScopeId: "content-filter", retrievalSessionId: "content-filter",
      onEvent: () => {},
      onSystemMessage: (message) => { systemMessages.push(message); },
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
    });

    expect(result.kind).toBe("completed");
    expect(client.calls()).toBe(6);
    expect(systemMessages).toHaveLength(0);
  });
});
