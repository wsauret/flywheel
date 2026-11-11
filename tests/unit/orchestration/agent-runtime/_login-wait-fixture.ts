import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream.js";
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { FUNCTION_TOOL_PRESENTATION } from "../../../../src/orchestration/agent-runtime/llm/types.js";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { createLoginObservations } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/login-observations.js";
import { chain, fakeAvailability, subscriptionCandidate } from "./llm/_provider-chain-harness.js";
import { ownHistoryTarget } from "./_model-client.js";

/** A real request walk and account owner with only the provider stream replaced. */
export function loginWaitingRequest(response?: string) {
  const observations = createLoginObservations();
  const account = { accountId: "account", configDir: "/scratch/login", identity: "person@example.com" };
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const client = chain({
    candidates: [subscriptionCandidate("chatgpt", account.accountId)],
    availability: fakeAvailability({}).availability,
    awaitLogin: (_candidate, signal) => {
      const waiting = observations.awaitLogin("/scratch/profile", account, signal);
      entered.resolve();
      return waiting;
    },
    build: async () => ({ historyTarget: ownHistoryTarget,
      accessProvider: "chatgpt", model: "test-model", modelFamily: "openai",
      contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools() {
        calls += 1;
        if (calls === 1) {
          observations.recordRequest(account, "login-rejected");
          throw normalizeProviderAttemptFailure(Object.assign(new Error("login refused"), { status: 401 }));
        }
        if (response !== undefined) yield { kind: "text_delta", text: response, blockKey: "reply" } as const;
        yield { kind: "done", stopReason: "end_turn" } as const;
      },
    }),
  });
  return {
    client,
    observations,
    entered: entered.promise,
    calls: () => calls,
    renew: () => { observations.clearRequest(account); },
    start: (signal: AbortSignal, onLoginWait?: (waiting: boolean) => void) => streamAssistantTurn({
      client, executionCwd: "/scratch", signal, onLoginWait,
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages: [{ kind: "user", content: "continue this request" }],
      tools: [], systemPrompt: stableSystemPrompt("test"),
      reasoningEffort: undefined, cacheRetention: undefined, providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined, requestAudit: undefined, staleMasking: undefined, requestContext: undefined,
      turn: 1, messageCount: 1, estimatedContextTokens: 1, onEvent: () => {},
    }),
  };
}
