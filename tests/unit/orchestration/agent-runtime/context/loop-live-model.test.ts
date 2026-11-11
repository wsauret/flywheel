import { describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { asModelClient, ownHistoryTarget } from "../_model-client.js";
import { createRequestToolSurface } from "../../../../../src/orchestration/agent-runtime/request-tool-surface.js";
import { testCapabilityModules, testDefinitionAvailability, testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

describe("agent loop live model reassignment", () => {
  test("uses the next request's model and effort without ending the loop", async () => {
    const requests: Array<{ model: string; effort: unknown }> = [];
    let selection = { model: "old-model", effort: "low" };
    const client: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "old-model",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: true,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      async *streamWithTools(options): AsyncGenerator<ProviderStreamEvent> {
        requests.push({ model: this.model, effort: options.reasoningEffort });
        if (requests.length === 1) {
          selection = { model: "new-model", effort: "high" };
          yield { kind: "tool_use", toolCall: { id: "tc_1", name: "missing_tool", input: {} } };
          yield { kind: "done", stopReason: "tool_use" };
        } else {
          yield { kind: "done", stopReason: "end_turn" };
        }
      },
      priceFor() {
        return { status: "unavailable", reason: "missing-rate-card" };
      },
    };

    const tools = await createRequestToolSurface(
      () => ({ eligibleTools: new Map(), tools: new Map(), omitted: [], usable: new Set(), turnedOff: [], registrationIds: new Map(), registrationIdentities: new Map(), definitionAvailability: testDefinitionAvailability() }),
      testCapabilityModules,
      testRuntimeConfigCapture,
      async () => {
        const role = selection;
        const selected = asModelClient({ ...client, model: role.model });
        return {
          mainRoute: { client: selected },
          plannedAttempt: await selected.plannedAttempt(),
          interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
          role,
        };
      },
    );
    const result = await runAgentLoop({
      client: asModelClient(client),
      tools,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "live-model", promptCacheKey: "live-model", artifactScopeId: "live-model", retrievalSessionId: "live-model",
      onEvent: () => {},
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
    });

    expect(result.kind).toBe("completed");
    expect(requests).toEqual([
      { model: "old-model", effort: "low" },
      { model: "new-model", effort: "high" },
    ]);
  });
});
