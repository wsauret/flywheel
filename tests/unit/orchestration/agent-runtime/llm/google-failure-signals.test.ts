/**
 * Google adapter failure signals and tool-result assembly.
 *
 * No live Google key is available, so every behavior here is proven against
 * synthetic stream fixtures with the pi port source cited per case:
 * duplicate functionCall id regeneration (`google-generative-ai.ts:185-191`),
 * missing finish reason (`:266-268`), error-class finish reasons (`:269-274`),
 * a prompt block (`promptFeedback.blockReason` with no candidates, per the
 * @google/genai response types),
 * and the tool-result image wire shape (`google-shared.ts:81-87,:188-231`,
 * Google multimodal functionResponse documentation: images ride inside
 * `functionResponse.parts` on Gemini 3+).
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { Redacted } from "effect";
import { GenerateContentResponse } from "@google/genai";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { toGoogleGenerativeAiRequest } from "../../../../../src/orchestration/agent-runtime/llm/conversions/google-generative-ai.js";
import { createGoogleAdapter } from "../../../../../src/orchestration/agent-runtime/llm/google.js";
import type { ConversationMessage, LLMClient, ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { isFailoverFailure, isRetryableFailure, ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { ContentRefusedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";

interface UnknownRecord {
  [key: string]: unknown;
}

const MODEL_INFO: ModelInfo = {
  provider: "google",
  family: "google",
  id: "gemini-3-pro",
  name: "Gemini 3 Pro",
  reasoning: true,
  toolCall: true,
  attachment: false,
  temperature: true,
  openWeights: false,
  cost: { input: 0, output: 0 },
  pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] },
  contextLimit: 1_000_000,
  outputLimit: 64_000,
};


let streamChunks: Array<UnknownRecord> = [];
let streamError: Error | undefined;
let invocationOrder: string[] = [];
let lastRequest: UnknownRecord | undefined;

function throwError(error: Error): never {
  throw error;
}

const fakeGoogleClient: NonNullable<NonNullable<Parameters<typeof createGoogleAdapter>[3]>["client"]> = {
  async generateContentStream(request) {
    invocationOrder.push("sdk");
    lastRequest = { ...request };
    return (async function* () {
      for (const chunk of streamChunks) yield Object.assign(new GenerateContentResponse(), chunk);
      if (streamError) throwError(streamError);
    })();
  },
  apiErrorStatus: (error: unknown) => error instanceof TestApiError ? error.status : undefined,
};

class TestApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function createTestGoogleAdapter(): Promise<LLMClient> {
  return createGoogleAdapter(Redacted.make("test-key"), "gemini-3-pro", MODEL_INFO, { client: fakeGoogleClient });
}

async function collectWithError(client: LLMClient): Promise<{ events: ProviderStreamEvent[]; error: Error | undefined }> {
  const events: ProviderStreamEvent[] = [];
  try {
    for await (const event of client.streamWithTools({
      messages: [{ kind: "user", content: "hi" }],
      tools: [],
      systemPrompt: stableSystemPrompt("sys"),
    })) {
      events.push(event);
    }
    return { events, error: undefined };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { events, error };
  }
}

const USAGE = { promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 0 };

it("Google settles dispatch before SDK invocation and rejection prevents invocation", async () => {
  invocationOrder = [];
  streamChunks = [{ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }], usageMetadata: USAGE }];
  const client = await createTestGoogleAdapter();

  for await (const _event of client.streamWithTools({ messages: [{ kind: "user", content: "hi" }], tools: [], systemPrompt: stableSystemPrompt("sys"), onDispatch: async () => { invocationOrder.push("settled"); } })) {}
  expect(invocationOrder).toEqual(["settled", "sdk"]);

  invocationOrder = [];
  const rejected = (async () => {
    for await (const _event of client.streamWithTools({ messages: [{ kind: "user", content: "hi" }], tools: [], systemPrompt: stableSystemPrompt("sys"), onDispatch: async () => { throw new Error("dispatch rejected"); } })) {}
  })();
  await expect(rejected).rejects.toThrow("dispatch rejected");
  expect(invocationOrder).toEqual([]);
});

it("declares a custom-wire tool to Google with the description it declares for the function wire", async () => {
  streamChunks = [{ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "ok" }] } }], usageMetadata: USAGE }];
  const applyPatch = {
    name: "apply_patch",
    description: "A FREEFORM tool",
    input_schema: { type: "object", properties: { input: { type: "string" } } },
    wire: { kind: "custom" as const, grammar: { syntax: "lark" as const, definition: "start: \"*** Begin Patch\"" }, functionDescription: "Put the patch in the input string" },
  };
  const client = await createTestGoogleAdapter();

  for await (const _event of client.streamWithTools({ messages: [{ kind: "user", content: "hi" }], tools: [applyPatch], systemPrompt: stableSystemPrompt("sys") })) {}

  expect(lastRequest?.config).toMatchObject({ tools: [{ functionDeclarations: [{ name: "apply_patch", description: "Put the patch in the input string" }] }] });
});

describe("Google failure signals", () => {
  beforeEach(() => {
    streamChunks = [];
    streamError = undefined;
    lastRequest = undefined;
  });

  it("regenerates a duplicated functionCall id so both parallel calls dispatch", async () => {
    streamChunks = [{
      candidates: [{
        content: { parts: [
          { functionCall: { id: "dup", name: "read", args: { path: "a" } } },
          { functionCall: { id: "dup", name: "read", args: { path: "b" } } },
        ] },
        finishReason: "STOP",
      }],
      usageMetadata: USAGE,
    }];
    const client = await createTestGoogleAdapter();

    const { events, error } = await collectWithError(client);

    expect(error).toBeUndefined();
    const ids = events.flatMap((event) => (event.kind === "tool_use" ? [event.toolCall.id] : []));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe("dup");
  });

  it("throws transient when the stream ends without any finish reason", async () => {
    streamChunks = [{
      candidates: [{ content: { parts: [{ text: "partial" }] } }],
      usageMetadata: USAGE,
    }];
    const client = await createTestGoogleAdapter();

    const { events, error } = await collectWithError(client);

    expect(error?.message).toContain("without a finish reason");
    expect(error).toMatchObject({ failure: { _tag: "TransientNetworkFailure" } });
    expect(events.some((event) => event.kind === "done")).toBe(false);
    // Billing still lands before the failure propagates, as lower bounds: no chunk ended the response.
    expect(events.filter((event) => event.kind === "usage")).toEqual([expect.objectContaining({ final: false })]);
  });

  it("refuses a blocked prompt as conversation content, never a retryable stream tear", async () => {
    streamChunks = [{
      promptFeedback: { blockReason: "PROHIBITED_CONTENT", blockReasonMessage: "The prompt was blocked." },
      usageMetadata: USAGE,
    }];
    const client = await createTestGoogleAdapter();

    const { events, error } = await collectWithError(client);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    if (!(error instanceof ProviderAttemptFailure)) return;
    expect(error.failure._tag).toBe("InvalidRequestFailure");
    expect(isRetryableFailure(error.failure)).toBe(false);
    expect(isFailoverFailure(error.failure)).toBe(false);
    expect(error.cause).toBeInstanceOf(ContentRefusedError);
    if (!(error.cause instanceof ContentRefusedError)) return;
    expect(error.cause.reason).toBe("PROHIBITED_CONTENT");
    expect(error.cause.policy).toBe("PROHIBITED_CONTENT");
    expect(error.cause.part).toBeUndefined();
    expect(error.cause.cause.message).toBe("Google blocked the prompt: PROHIBITED_CONTENT: The prompt was blocked.");
    // The block is the provider's terminal answer, so its usage is the final report.
    expect(events.filter((event) => event.kind === "usage")).toEqual([expect.objectContaining({ final: true })]);
  });

  it("emits the latest cumulative usage before an iterator failure", async () => {
    streamChunks = [{ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 7, thoughtsTokenCount: 3 } }];
    streamError = new Error("prompt is too long");
    const client = await createTestGoogleAdapter();

    const { events, error } = await collectWithError(client);

    expect(error).toBeDefined();
    expect(events.filter((event) => event.kind === "usage")).toEqual([expect.objectContaining({
      final: false,
      inputTokens: 100,
      outputTokens: 10,
      reasoningTokens: 3,
    })]);
  });

  it("emits no usage when a failed stream reports no usage metadata", async () => {
    streamError = new Error("prompt is too long");
    const client = await createTestGoogleAdapter();

    const { events } = await collectWithError(client);

    expect(events.filter((event) => event.kind === "usage")).toHaveLength(0);
  });

  it("surfaces MALFORMED_FUNCTION_CALL with the raw reason instead of a silent success", async () => {
    streamChunks = [{
      candidates: [{ content: { parts: [{ text: "garbled" }] }, finishReason: "MALFORMED_FUNCTION_CALL" }],
      usageMetadata: USAGE,
    }];
    const client = await createTestGoogleAdapter();

    const { events, error } = await collectWithError(client);

    expect(error?.message).toContain("MALFORMED_FUNCTION_CALL");
    expect(events.some((event) => event.kind === "done")).toBe(false);
  });

  it("keeps SAFETY as a content_filter done, not an error", async () => {
    streamChunks = [{
      candidates: [{ content: { parts: [{ text: "cut" }] }, finishReason: "SAFETY" }],
      usageMetadata: USAGE,
    }];
    const client = await createTestGoogleAdapter();

    const { events, error } = await collectWithError(client);

    expect(error).toBeUndefined();
    expect(events.find((event) => event.kind === "done")).toMatchObject({ stopReason: "content_filter" });
    expect(events.filter((event) => event.kind === "usage")).toEqual([expect.objectContaining({ final: true })]);
  });

  it("classifies a terminal quota-exceeded stream as chain-failover evidence", async () => {
    streamError = new Error("429 RESOURCE_EXHAUSTED: token quota_exceeded for this billing account");
    const client = await createTestGoogleAdapter();

    const { error } = await collectWithError(client);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    expect(error).toMatchObject({ failure: { _tag: "QuotaExhaustedFailure" } });
    expect(lastRequest?.retryOptions).toBeUndefined();
  });


  it("keeps a RESOURCE_EXHAUSTED request-rate throttle retryable", async () => {
    streamError = new Error("429 RESOURCE_EXHAUSTED: request rate limit exceeded");
    const client = await createTestGoogleAdapter();

    const { error } = await collectWithError(client);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    expect(error).toMatchObject({ failure: { _tag: "RateLimitFailure" } });
  });

  it("classifies an SDK 402 as terminal quota, not a retryable blip", async () => {
    streamError = new TestApiError("Payment required", 402);
    const client = await createTestGoogleAdapter();

    const { error } = await collectWithError(client);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    expect(error).toMatchObject({ failure: { _tag: "QuotaExhaustedFailure" } });
  });

  it("classifies a spent-quota 429 body the local vocabulary does not name", async () => {
    streamError = new Error("429 Too Many Requests: insufficient_quota for this project");
    const client = await createTestGoogleAdapter();

    const { error } = await collectWithError(client);

    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    expect(error).toMatchObject({ failure: { _tag: "QuotaExhaustedFailure" } });
  });

  it.each([
    {
      name: "terminal payment refusal",
      accessProvider: "google_api" as const,
      status: 402,
      message: "Payment required",
      code: "PAYMENT_REQUIRED",
      failure: "QuotaExhaustedFailure",
    },
    {
      name: "Vertex model refusal with 503 inside the project number",
      accessProvider: "google_vertex" as const,
      status: 404,
      message: "Publisher model `projects/412275039031/locations/us-central1/publishers/google/models/gemini-flash-latest` was not found or your project does not have access to it. Ensure you are using a valid model name and that the model is available in the specified region. For more information, see: https://docs.cloud.google.com/...",
      code: "NOT_FOUND",
      failure: "ModelAccessFailure",
    },
    {
      name: "AI Studio model refusal",
      accessProvider: "google_api" as const,
      status: 404,
      message: "models/gemini-flash-latest is not found for API version v1beta",
      code: "NOT_FOUND",
      failure: "ModelAccessFailure",
    },
    {
      name: "non-model 404 with rate-limit and overload text",
      accessProvider: "google_vertex" as const,
      status: 404,
      message: "projects/429503 was not found; unavailable rate limit settings",
      code: "NOT_FOUND",
      failure: "InvalidRequestFailure",
    },
    {
      name: "429 without rate-limit text",
      accessProvider: "google_api" as const,
      status: 429,
      message: "RESOURCE_EXHAUSTED",
      code: "RESOURCE_EXHAUSTED",
      failure: "RateLimitFailure",
    },
    {
      name: "503 with 429 inside a project number",
      accessProvider: "google_vertex" as const,
      status: 503,
      message: "projects/412274299031 request failed",
      code: "UNAVAILABLE",
      failure: "OverloadedFailure",
    },
  ])("uses the real SDK transport once for $name", async ({ accessProvider, status, message, code, failure }) => {
    const { error, fetchCalls } = await failureThroughSdk(accessProvider, status, { error: { code: status, message, status: code } });

    expect(fetchCalls).toBe(1);
    expect(error).toBeInstanceOf(ProviderAttemptFailure);
    expect(error).toMatchObject({ failure: { _tag: failure } });
    expect(error?.message).toContain(message);
    if (failure === "ModelAccessFailure") {
      expect(error?.cause).toMatchObject({ name: "ModelAccessRefusedError", refusal: { kind: "model" } });
    }
  });

  // Gemini states a per-minute and a per-day limit in the same words; only the quota id and the retry delay differ.
  it("classifies a Gemini per-minute quota as a rate limit with its retry delay, and a per-day quota as spent", async () => {
    const geminiQuota = (quotaId: string, retryIn: string, retryDelay: string) => ({
      error: {
        code: 429,
        message: `You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 10, model: gemini-2.5-flash\nPlease retry in ${retryIn}.`,
        status: "RESOURCE_EXHAUSTED",
        details: [
          { "@type": "type.googleapis.com/google.rpc.Help", links: [{ description: "Learn more about Gemini API quotas", url: "https://ai.google.dev/gemini-api/docs/rate-limits" }] },
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_free_tier_requests", quotaId, quotaDimensions: { location: "global", model: "gemini-2.5-flash" }, quotaValue: "10" }] },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay },
        ],
      },
    });

    const perMinute = await failureThroughSdk("google_api", 429, geminiQuota("GenerateRequestsPerMinutePerProjectPerModel-FreeTier", "52.719223156s", "52s"));
    expect(perMinute.error).toMatchObject({ failure: { _tag: "RateLimitFailure", retryAfterMs: 52_000 } });
    const perDay = await failureThroughSdk("google_api", 429, geminiQuota("GenerateRequestsPerDayPerProjectPerModel-FreeTier", "9.5s", "9s"));
    expect(perDay.error).toMatchObject({ failure: { _tag: "QuotaExhaustedFailure" } });
  });
});

/** Runs one request through the real Google SDK transport against a fetch that answers `body` with `status`. */
async function failureThroughSdk(accessProvider: "google_api" | "google_vertex", status: number, body: UnknownRecord): Promise<{ error: Error | undefined; fetchCalls: number }> {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = Object.assign(async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }, { preconnect: originalFetch.preconnect });
  try {
    const client = await createGoogleAdapter(Redacted.make("test-key"), "gemini-3-pro", MODEL_INFO, { accessProvider });
    const { error } = await collectWithError(client);
    return { error, fetchCalls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const PNG = { type: "image" as const, mediaType: "image/png", data: "AAA" };

function toolResultHistory(): ConversationMessage[] {
  return [
    { kind: "user", content: "go" },
    { kind: "assistant", content: [{ type: "tool_use", id: "c1", name: "shot", input: {} }], provider: "google", model: "gemini-3-pro", api: "google-generative-ai", timestamp: 1 },
    { kind: "toolResult", toolUseId: "c1", content: [PNG] },
  ];
}

describe("Google tool-result image wire shape", () => {
  it("nests images inside functionResponse.parts on Gemini 3+", () => {
    const contents = toGoogleGenerativeAiRequest({ accessProvider: "google_api", provider: "google", model: "gemini-3-pro", supportsImages: true }, toolResultHistory());
    const responseTurn = contents.at(-1);
    const fnPart = responseTurn?.parts?.find((p) => p.functionResponse);

    expect(fnPart?.functionResponse?.response).toEqual({ output: "(see attached image)" });
    expect(fnPart?.functionResponse?.parts).toHaveLength(1);
    expect(responseTurn?.parts?.some((p) => p.inlineData)).toBe(false);
  });

  it("sends a separate labeled user turn on Gemini < 3", () => {
    const contents = toGoogleGenerativeAiRequest({ accessProvider: "google_api", provider: "google", model: "gemini-2.5-pro", supportsImages: true }, toolResultHistory());
    const imageTurn = contents.at(-1);
    const responseTurn = contents.at(-2);

    expect(responseTurn?.parts?.some((p) => p.functionResponse)).toBe(true);
    expect(responseTurn?.parts?.some((p) => p.inlineData)).toBe(false);
    expect(imageTurn?.parts?.[0]).toEqual({ text: "Tool result image:" });
    expect(imageTurn?.parts?.some((p) => p.inlineData)).toBe(true);
  });

  it("gives a non-vision model the omitted-image placeholder in user content", () => {
    const contents = toGoogleGenerativeAiRequest(
      { accessProvider: "google_api", provider: "google", model: "gemini-3-pro", supportsImages: false },
      [{ kind: "user", content: [{ type: "text", text: "look" }, PNG] }],
    );

    const text = JSON.stringify(contents);
    expect(text).not.toContain("inlineData");
    expect(text).toContain("image/png");
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
