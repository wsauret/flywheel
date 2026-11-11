import { describe, expect, test } from "bun:test";
import { createAssistantAttempt, type AssistantAttemptInput } from "../../../../src/orchestration/agent-runtime/assistant-turn-attempt";
import { preparedRequest } from "./llm/_provider-chain-harness.js";
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type ProviderStreamEvent, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types";
import { LlmStreamError } from "../../../../src/orchestration/agent-runtime/llm/errors";
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import type { ProviderRequestAuditWriter } from "../../../../src/orchestration/agent-runtime/llm/provider-request-audit";
import type { ProviderRequestAuditFact } from "../../../../src/orchestration/session/provider-request-audit-facts";
import { recordProviderResponse } from "../../../../src/orchestration/session/provider-request-audit-recorder";
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { ownHistoryTarget } from "./_model-client.js";

function fakeClient(stream: (opts: StreamOptions) => AsyncGenerator<ProviderStreamEvent>): LLMClient {
  const adapter: LLMClient = { historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
    streamWithTools(opts: StreamOptions) { return stream(opts); },
  };
  return adapter;
}

describe("streamAssistantTurn provider failure diagnostics", () => {
  test("records redacted provider diagnostics for stream failures", async () => {
    const responses: ProviderRequestAuditFact[] = [];
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest(input) { return { requestId: "request-failed", turn: input.turn }; },
      // The real recorder runs the strict store gate, so every diagnostic key the producer emits must decode.
      recordResponse(handle, input) {
        return recordProviderResponse({ observe: (fact) => responses.push(fact) }, {
          ...input, requestId: handle.requestId, identity: { providerSessionKey: "session-key" }, turn: handle.turn, durationMs: 0,
        });
      },
      recordUsage() {},
      recordStreamStarted() {},
      recordStreamEvent() {},
      recordStreamCompleted() {},
    };
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-");
    // OpenRouter mirrors the upstream provider's body in error.metadata.raw.
    const cause = Object.assign(new Error(`socket closed ${secret}`), {
      code: "UND_ERR_SOCKET",
      error: { message: "Provider returned error", code: 502, metadata: { raw: `upstream overloaded ${secret}`, provider_name: "DeepInfra" } },
    });
    const error = Object.assign(
      new LlmStreamError(`provider failed ${secret}`, "transient", undefined, { cause }),
      { status: 503, headers: new Headers({ "x-request-id": "req_123", authorization: `Bearer ${secret}` }) },
    );
    const client = fakeClient(async function* (): AsyncGenerator<ProviderStreamEvent> {
      yield { kind: "tool_input_start", toolUseId: "unfinished", name: "workflow" };
      throw normalizeProviderAttemptFailure(error);
    });

    const input = {
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      messages: [],
      tools: [],
      systemPrompt: stableSystemPrompt(""),
      reasoningEffort: undefined,
      signal: undefined,
      cacheRetention: "1h",
      providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined,
      requestAudit,
      staleMasking: undefined,
      requestContext: undefined,
      turn: 1,
      messageCount: 0,
      estimatedContextTokens: 0,
      onEvent: () => {},
    } satisfies AssistantAttemptInput;
    const attempt = createAssistantAttempt({
      attempt: client, client, prepared: preparedRequest(client, input),
    }, input, undefined);
    const result = await attempt.stream();
    await attempt.close();

    expect(result.outcome.kind).toBe("stream_error");
    expect(responses).toHaveLength(1);
    expect(responses[0]?.payload).toMatchObject({
      outcome: "stream_error",
      error: {
        tag: "TransientDisconnect",
        message: "provider failed [redacted secret]",
        diagnostic: {
          name: "ProviderAttemptFailure",
          message: "provider failed [redacted secret]",
          cause: {
            name: "LlmStreamError",
            message: "provider failed [redacted secret]",
            status: 503,
            kind: "transient",
            headers: { "x-request-id": "req_123" },
            cause: {
              name: "Error",
              message: "socket closed [redacted secret]",
              code: "UND_ERR_SOCKET",
              upstream: "upstream overloaded [redacted secret]",
            },
          },
        },
      },
    });
  });
});
