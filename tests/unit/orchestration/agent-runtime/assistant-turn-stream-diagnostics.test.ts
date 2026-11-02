import { describe, expect, test } from "bun:test";
import { createAssistantAttempt, type AssistantAttemptInput } from "../../../../src/orchestration/agent-runtime/assistant-turn-attempt";
import { preparedRequest } from "./llm/_provider-chain-harness.js";
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type ProviderStreamEvent, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types";
import { LlmStreamError } from "../../../../src/orchestration/agent-runtime/llm/errors";
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import type {
  ProviderRequestAuditHandle,
  ProviderRequestAuditWriter,
} from "../../../../src/orchestration/agent-runtime/llm/provider-request-audit";
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
    promptNotes: { progress: "", modelNotes: "" },
    priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
    streamWithTools(opts: StreamOptions) { return stream(opts); },
  };
  return adapter;
}

describe("streamAssistantTurn provider failure diagnostics", () => {
  test("records redacted provider diagnostics for stream failures", async () => {
    const responses: Array<{
      handle: ProviderRequestAuditHandle;
      input: Parameters<ProviderRequestAuditWriter["recordResponse"]>[1];
    }> = [];
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest(input) { return { requestId: "request-failed", turn: input.turn }; },
      recordResponse(handle, input) {
        responses.push({ handle, input });
      },
      recordUsage() {},
      recordStreamStarted() {},
      recordStreamEvent() {},
      recordStreamCompleted() {},
    };
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-");
    const cause = Object.assign(new Error(`socket closed ${secret}`), { code: "UND_ERR_SOCKET" });
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
    expect(responses[0]?.input).toMatchObject({
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
            cause: { name: "Error", message: "socket closed [redacted secret]", code: "UND_ERR_SOCKET" },
          },
        },
      },
    });
  });
});
