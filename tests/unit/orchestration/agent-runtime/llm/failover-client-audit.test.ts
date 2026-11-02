import { describe, expect, test } from "bun:test";
import type { AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import { streamAssistantTurn } from "../../../../../src/orchestration/agent-runtime/assistant-turn-stream.js";
import type { ModelClient, ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { ProviderRequestAuditWriter } from "../../../../../src/orchestration/agent-runtime/llm/provider-request-audit.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { chain, fakeAvailability, fakeClient, textDelta } from "./_provider-chain-harness.js";

function recordingAudit() {
  let nextRequest = 0;
  const requests: Array<{ requestId: string; accessProvider: AccessProviderId }> = [];
  const responses: Array<{ requestId: string; outcome: string; tag: string | undefined }> = [];
  const streamStarts: string[] = [];
  const streamCompletions: Array<{ requestId: string; outcome: string }> = [];
  const usages: Array<{ requestId: string; inputTokens: number }> = [];
  const requestAudit: ProviderRequestAuditWriter = {
    recordRequest(input) {
      nextRequest += 1;
      const requestId = input.requestId;
      requests.push({ requestId, accessProvider: input.attribution.accessProvider });
      return { requestId, turn: input.turn };
    },
    recordResponse(handle, input) {
      responses.push({ requestId: handle.requestId, outcome: input.outcome, tag: input.error?.tag });
    },
    recordAbandonedResponse(handle, input) {
      responses.push({ requestId: handle.requestId, outcome: input.outcome, tag: input.error?.tag });
      return Promise.resolve();
    },
    recordUsage(handle, input) { usages.push({ requestId: handle.requestId, inputTokens: input.inputTokens }); },
    recordStreamStarted(handle) { streamStarts.push(handle.requestId); },
    recordStreamEvent() {},
    recordStreamCompleted(handle, input) {
      streamCompletions.push({ requestId: handle.requestId, outcome: input.outcome });
    },
  };
  return { requestAudit, requests, responses, usages, streamStarts, streamCompletions };
}

function runTurn(client: ModelClient, requestAudit: ProviderRequestAuditWriter): ReturnType<typeof streamAssistantTurn> {
  return streamAssistantTurn({
    client,
    executionCwd: "/scratch",
    interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
    messages: [],
    tools: [],
    systemPrompt: stableSystemPrompt("s"),
    reasoningEffort: undefined,
    signal: undefined,
    cacheRetention: "1h",
    providerSessionKey: undefined, promptCacheKey: undefined,
    providerOptions: undefined,
    requestContext: "main",
    requestAudit,
    staleMasking: undefined,
    turn: 1,
    messageCount: 0,
    estimatedContextTokens: 0,
    onEvent: () => {},
  });
}

function doneStream(text: string): () => AsyncGenerator<ProviderStreamEvent> {
  return async function* () {
    yield textDelta(text);
    yield { kind: "done", stopReason: "end_turn" };
  };
}

describe("per-attempt audit attribution", () => {
  test("a candidate the account cannot pay for costs the request no record: only the provider that sends it gets one", async () => {
    const audit = recordingAudit();
    const script = {};
    const client = chain({
      build: async (provider) => fakeClient(provider, doneStream(provider)),
      availability: fakeAvailability(script).availability,
    });

    Object.assign(script, { chatGpt: { exhaustedAtMs: Date.now(), resetsAtMs: Date.now() + 60_000 } });
    const result = await runTurn(client, audit.requestAudit);
    if ("turn" in result) throw new Error("expected a completed assistant turn");

    expect(result.outcome).toEqual({ kind: "ok", stopReason: "end_turn" });
    expect(audit.requests).toEqual([{ requestId: audit.requests[0]!.requestId, accessProvider: "openai_api" }]);
    expect(audit.responses).toEqual([{ requestId: audit.requests[0]!.requestId, outcome: "ok", tag: undefined }]);
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
