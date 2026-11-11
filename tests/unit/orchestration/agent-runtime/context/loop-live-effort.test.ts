import { describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type ProviderStreamEvent, type StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { ReasoningEffort } from "../../../../../src/infra/llm/models.js";
import { asModelClient, ownHistoryTarget } from "../_model-client.js";
import { RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

describe("agent loop live reasoning effort", () => {
  test("re-reads the effort accessor at every turn boundary", async () => {
    const effortsSeen: Array<ReasoningEffort | undefined> = [];
    const client: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test-model",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: true,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
        effortsSeen.push(options.reasoningEffort);
        if (effortsSeen.length === 1) {
          yield { kind: "tool_use", toolCall: { id: "tc_1", name: "missing_tool", input: {} } };
          yield { kind: "done", stopReason: "tool_use" };
          return;
        }
        yield { kind: "text_delta", text: "Done.", blockKey: "text" };
        yield { kind: "done", stopReason: "end_turn" };
      },
      priceFor() {
        return { status: "unavailable", reason: "missing-rate-card" };
      },
    };

    let currentEffort: ReasoningEffort = "high";
    const result = await runAgentLoop({
      client: asModelClient(client),
      tools: new RequestToolMap(),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "live-effort", promptCacheKey: "live-effort", artifactScopeId: "live-effort", retrievalSessionId: "live-effort",
      onEvent: () => {},
      reasoningEffort: async () => {
        const effort = currentEffort;
        currentEffort = "low"; // simulate a mid-session assignment change
        return effort;
      },
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
    });

    expect(result.kind).toBe("completed");
    expect(effortsSeen).toEqual(["high", "low"]);
  });
});
