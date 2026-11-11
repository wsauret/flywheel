import { describe, expect, it } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GenerateContentResponse } from "@google/genai";
import { Redacted } from "effect";
import { createAnthropicAdapter, operationsFromAnthropicClient, type AnthropicOperations } from "../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import { engineBlockLocation } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/engine-additions.js";
import { createGoogleAdapter } from "../../../../../src/orchestration/agent-runtime/llm/google.js";
import { createOpenAIAdapter } from "../../../../../src/orchestration/agent-runtime/llm/openai.js";
import { createOpenAIChatCompletionsAdapter } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions.js";
import { ContentFilteredError, ContentRefusedError, LlmStreamError, OutputLengthExceededError, QuotaCoordinationError, QuotaExhaustedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { isProviderAttributedFailure, normalizeProviderAttemptFailure, ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { createProviderAvailability } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability.js";
import { createAvailabilityAuthority } from "../../../../../src/infra/llm/availability-store.js";
import { availabilityFixtures } from "./_provider-availability-harness.js";
import type { ConversationMessage, LLMClient, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { providerModelInfo } from "../../../../../src/infra/llm/provider-model-info.js";
import { wireClient, wireResponse } from "./_wire-fixtures.js";

const fixtures = availabilityFixtures();

const GPT_5 = providerModelInfo({ provider: "openai", id: "gpt-5", reasoning: true });
const GPT_4O = providerModelInfo({ provider: "openai", id: "gpt-4o" });
const OPUS = providerModelInfo({ provider: "anthropic", id: "claude-opus-4-8", reasoning: true });
const GEMINI = providerModelInfo({ provider: "google", id: "gemini-3-pro", reasoning: true });
const options: StreamOptions = { messages: [{ kind: "user", content: "hi" }], tools: [], systemPrompt: stableSystemPrompt("system"), reasoningEffort: "off" };

async function failureOf(client: LLMClient, overrides: Partial<StreamOptions> = {}): Promise<Error | undefined> {
  try {
    for await (const _event of client.streamWithTools({ ...options, ...overrides })) {}
    return undefined;
  } catch (error) {
    if (!(error instanceof Error)) throw new Error("Expected an Error from the adapter", { cause: error });
    return error;
  }
}

function openai(frames: Parameters<typeof wireClient>[0], onRequest?: Parameters<typeof wireClient>[1]) {
  return createOpenAIAdapter({ kind: "apiKey", apiKey: Redacted.make("test-key") }, "gpt-5", GPT_5, { client: wireClient(frames, onRequest) });
}

function anthropic(frames: Parameters<typeof wireResponse>[0]) {
  const sdk = new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch: async () => wireResponse(frames) });
  return createAnthropicAdapter(Redacted.make("test-key"), "claude-opus-4-8", OPUS, { operations: operationsFromAnthropicClient(sdk) });
}

function google(stream: AsyncGenerator<GenerateContentResponse>) {
  return createGoogleAdapter(Redacted.make("test-key"), "gemini-3-pro", GEMINI, {
    client: { async generateContentStream() { return stream; }, apiErrorStatus: () => undefined },
  });
}

const incomplete = { type: "response.incomplete", response: { id: "response", status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } } };

describe("adapter provider boundaries", () => {
  it.each([
    { status: 402, code: "insufficient_quota", message: "You exceeded your current quota. Add credits.", tag: "QuotaExhaustedFailure" },
    { status: 429, code: "insufficient_quota", message: "You exceeded your current quota. Add credits.", tag: "QuotaExhaustedFailure" },
    { status: undefined, code: "insufficient_quota", message: "You exceeded your current quota. Add credits.", tag: "QuotaExhaustedFailure" },
    { status: 529, code: "overloaded_error", message: "Overloaded", tag: "OverloadedFailure" },
    { status: undefined, code: "overloaded_error", message: "Overloaded", tag: "OverloadedFailure" },
    { status: undefined, code: "rate_limit_exceeded", message: "Rate limit exceeded. Too many requests.", tag: "RateLimitFailure" },
  ])("normalizes actual chat-completions failures at HTTP or stream boundaries ($status, $code)", async ({ status, code, message, tag }) => {
    const payload = { message, code, type: code };
    const sdk = new OpenAI({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async () => status === undefined
        ? new Response(`data: ${JSON.stringify({ error: payload })}\n\n`, { headers: { "content-type": "text/event-stream" } })
        : Response.json({ error: payload }, { status }),
    });
    const client = await createOpenAIChatCompletionsAdapter(sdk, "gpt-4o", GPT_4O);
    const failure = await failureOf(client);
    expect(failure).toBeInstanceOf(ProviderAttemptFailure);
    if (!(failure instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome");
    expect(failure.failure._tag).toBe(tag);
    expect(isProviderAttributedFailure(failure.failure)).toBe(tag !== "QuotaExhaustedFailure");
    const raw = failure.cause instanceof QuotaExhaustedError || failure.cause instanceof LlmStreamError ? failure.cause.cause : failure.cause;
    expect(raw).toBeInstanceOf(OpenAI.APIError);
    expect(raw).toMatchObject({ status, code, type: code });
  });

  it("keeps actual OpenAI onDispatch rejection strict and never sends", async () => {
    let sends = 0;
    const client = await openai([], () => { sends += 1; });
    const local = new Error("dispatch persistence rejected");
    const failure = await failureOf(client, { onDispatch: async () => { throw local; } });
    expect(failure).toBe(local);
    expect(failure).not.toBeInstanceOf(ProviderAttemptFailure);
    expect(sends).toBe(0);
  });

  it("keeps OpenAI telemetry callback failure outside provider normalization", async () => {
    const client = await openai([{ type: "response.created", response: { id: "response" } }]);
    const local = new Error("telemetry persistence rejected");
    expect(await failureOf(client, { telemetry: { observe(event) { if (event.source === "provider") throw local; } } })).toBe(local);
  });

  it("keeps Anthropic request timing callback failures strict", async () => {
    const client = await anthropic([{ type: "message_stop" }]);
    const local = new Error("timing callback rejected");
    expect(await failureOf(client, { telemetry: { observe(event) { if (event.kind === "timing") throw local; } } })).toBe(local);
  });

  it("normalizes OpenAI output overflow at the terminal decode seam", async () => {
    const failure = await failureOf(await openai([incomplete]));
    expect(failure).toBeInstanceOf(ProviderAttemptFailure);
    if (!(failure instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome");
    expect(failure.failure._tag).toBe("OutputOverflowFailure");
    expect(failure.cause).toBeInstanceOf(OutputLengthExceededError);
  });

  it("normalizes Anthropic max_tokens at the terminal decode seam", async () => {
    const failure = await failureOf(await anthropic([{ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 1 } }]));
    expect(failure).toBeInstanceOf(ProviderAttemptFailure);
    if (!(failure instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome");
    expect(failure.failure._tag).toBe("OutputOverflowFailure");
    expect(failure.cause).toBeInstanceOf(OutputLengthExceededError);
  });

  it("normalizes Google MAX_TOKENS at the terminal decode seam", async () => {
    const client = await google((async function* () {
      yield Object.assign(new GenerateContentResponse(), {
        candidates: [{ content: { parts: [{ text: "cut" }] }, finishReason: "MAX_TOKENS" }],
        usageMetadata: { candidatesTokenCount: 8 },
      });
    })());
    const kinds: string[] = [];
    const failure = await (async () => {
      try {
        for await (const event of client.streamWithTools(options)) kinds.push(event.kind);
        return undefined;
      } catch (error) {
        return error;
      }
    })();
    expect(failure).toBeInstanceOf(ProviderAttemptFailure);
    if (!(failure instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome");
    expect(failure.failure._tag).toBe("OutputOverflowFailure");
    expect(failure.cause).toBeInstanceOf(OutputLengthExceededError);
    expect(kinds).toContain("usage");
    expect(kinds).not.toContain("done");
  });

  it("classifies an Anthropic content_filter error payload as a content filter stop", async () => {
    const failure = await failureOf(await anthropic([{ type: "error", error: { type: "content_filter", message: "Output blocked by content filtering policy" } }]));
    expect(failure).toBeInstanceOf(ProviderAttemptFailure);
    if (!(failure instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome");
    expect(failure.cause).toBeInstanceOf(ContentFilteredError);
  });

  it("fails an Anthropic body that closes without message_start as a dropped connection", async () => {
    // A 200 with an empty SSE body is what a proxy returns when the upstream
    // went away. Passing it through settled the turn as a completed empty
    // response; the walk must retry it in place instead.
    const failure = await failureOf(await anthropic([]));
    expect(failure).toBeInstanceOf(ProviderAttemptFailure);
    if (!(failure instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome");
    expect(failure.failure._tag).toBe("TransientNetworkFailure");
    expect(failure.message).toContain("before message_start");
  });

  it("surfaces an Anthropic caller abort before headers as the caller's own reason", async () => {
    // The SDK turns the aborted fetch into APIUserAbortError. Surfacing that
    // as a provider failure logs the Stop as a fatal stream error.
    const caller = new AbortController();
    const reason = new DOMException("caller stopped", "AbortError");
    const sdk = new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      caller.abort(reason);
    }) });
    const client = await createAnthropicAdapter(Redacted.make("test-key"), "claude-opus-4-8", OPUS, { operations: operationsFromAnthropicClient(sdk) });
    expect(await failureOf(client, { signal: caller.signal })).toBe(reason);
  });

  it("holds an Anthropic API account that the API throttles until its stated reset, and a recheck whose stream fails after HTTP 200 keeps it held", async () => {
    let nowMs = Date.now();
    const throttledAtMs = nowMs;
    const candidate = { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" } as const;
    // The fleet's recheck lease lives in the durable authority, so the probe needs a real one.
    const owner = createProviderAvailability({ now: () => nowMs, authority: createAvailabilityAuthority({ dbFile: fixtures.tempDbFile() }) });
    const availability = owner.forCandidates("default", [candidate]);
    const reset = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
    let throttled = true;
    const sdk = new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch: async () => throttled
      ? Response.json({ type: "error", error: { type: "rate_limit_error", message: "Number of request tokens has exceeded your per-minute rate limit" } }, {
        status: 429,
        headers: { "retry-after": "20", "anthropic-ratelimit-requests-reset": reset(20_000), "anthropic-ratelimit-input-tokens-reset": reset(42_000) },
      })
      : wireResponse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]) });
    const client = await createAnthropicAdapter(Redacted.make("test-key"), "claude-opus-4-8", OPUS, { operations: operationsFromAnthropicClient(sdk), candidate, availability });
    try {
      const failure = await failureOf(client);
      if (!(failure instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome");
      expect(failure.failure._tag).toBe("RateLimitFailure");
      expect(availability.genericQuotaStanding(candidate)).toEqual({ kind: "suppressed", exhaustion: { exhaustedAtMs: throttledAtMs, resetsAtMs: throttledAtMs + 42_000, hold: { kind: "rate_limit" } } });

      // Past the reset, this request holds the fleet's one recheck. Its response headers arrive, then the stream
      // fails: only a successful settlement may reopen the account, so every other request stays held.
      nowMs = throttledAtMs + 43_000;
      throttled = false;
      expect(availability.claimQuotaProbe(candidate)).toBeDefined();
      const recheck = await failureOf(client);
      if (!(recheck instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome");
      expect(recheck.failure._tag).toBe("OverloadedFailure");
      expect(availability.genericQuotaStanding(candidate).kind).toBe("recheck_pending");
    } finally {
      await owner.dispose();
    }
  });

  it("preserves coordination identity through the real OpenAI SDK fetch wrapper", async () => {
    const strict = new QuotaCoordinationError({ message: "coordination failed", provider: "openai", reason: "storage" });
    const client = await openai([], () => { throw strict; });
    expect(await failureOf(client)).toBe(strict);
  });

  it("preserves nested caller abort and coordination as strict original errors", () => {
    for (const strict of [new DOMException("caller stopped", "AbortError"), new QuotaCoordinationError({ message: "storage failed", provider: "openai", reason: "storage" })]) {
      const wrapped = new Error("SDK transport failure", { cause: new Error("fetch failed", { cause: strict }) });
      let failure: unknown;
      try { normalizeProviderAttemptFailure(wrapped); } catch (error) { failure = error; }
      expect(failure).toBe(strict);
    }
  });

  it("awaits Google iterator return before early close completes", async () => {
    const cleanup = Promise.withResolvers<void>();
    const cleanupStarted = Promise.withResolvers<void>();
    let cleaned = false;
    const source = (async function* () {
      try { yield new GenerateContentResponse(); }
      finally { cleanupStarted.resolve(); await cleanup.promise; cleaned = true; }
    })();
    const client = await google(source);
    const iterator = client.streamWithTools(options);
    while (true) {
      const event = await iterator.next();
      if (event.done) throw new Error("Provider did not start");
      if (event.value.kind === "provider_response_started") break;
    }
    let closed = false;
    const closing = iterator.return(undefined).then(() => { closed = true; });
    await cleanupStarted.promise;
    expect(closed).toBe(false);
    expect(cleaned).toBe(false);
    cleanup.resolve();
    await closing;
    expect(cleaned).toBe(true);
  });

  it("retains the Google consumer failure when iterator cleanup also fails", async () => {
    const local = new Error("telemetry rejected");
    let cleaned = false;
    const source = (async function* () {
      try { yield new GenerateContentResponse(); }
      finally { cleaned = true; await Promise.reject(new Error("cleanup rejected")); }
    })();
    const failure = await failureOf(await google(source), { telemetry: { observe(event) { if (event.source === "provider") throw local; } } });
    expect(failure).toBe(local);
    expect(cleaned).toBe(true);
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

const imagePart = { type: "image", mediaType: "image/png", data: "AAAA" } as const;
const sameProvider = { accessProvider: "anthropic_api", provider: "anthropic", api: "anthropic-messages", model: "claude-opus-4-8" } as const;
const otherProvider = { accessProvider: "openai_api", provider: "openai", api: "openai-responses", model: "o4" } as const;
const D1_REASON = "The image was specified using the image/png media type, but the image appears to be a image/webp image";
const imageModel: ModelInfo = {
  provider: "anthropic", family: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true, reasoningEfforts: ["low", "medium", "high", "max"],
  toolCall: true, attachment: true, temperature: true, openWeights: false, cost: { input: 0, output: 0 }, pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text", "image"], output: ["text"] }, contextLimit: 200_000, outputLimit: 64_000,
};

/** [user, assistant(2 calls), trA, trB], which the converter sends as [user, assistant, user(trA, trB)]. */
function twoReads(trB: Extract<ConversationMessage, { kind: "toolResult" }>["content"], ids = ["toolu_a", "toolu_b"], metadata: typeof sameProvider | typeof otherProvider = sameProvider, after: ConversationMessage[] = []): ConversationMessage[] {
  const [a = "", b = ""] = ids;
  return [
    { kind: "user", content: "Read both files." },
    { kind: "assistant", content: [{ type: "tool_use", id: a, name: "read", input: {} }, { type: "tool_use", id: b, name: "read", input: {} }], ...metadata, timestamp: 1 },
    { kind: "toolResult", toolUseId: a, content: [{ type: "text", text: "a" }] },
    { kind: "toolResult", toolUseId: b, content: trB },
    ...after,
  ];
}

const refusalBody = (message: string) => ({ type: "invalid_request_error", message });
type Entry = "http" | "stream" | "frame";

/** An Anthropic adapter whose request fails with `body` at one entry point: the HTTP response, a stream error event
 *  that the SDK raises from its iterator, or an error frame that a route's own stream yields (the Claude engine). */
function refusing(entry: Entry, body: { type: string; message: string }, route: { preparedBlock?: AnthropicOperations["preparedBlock"]; model?: ModelInfo } = {}) {
  const sdk = new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch: async () => entry === "http"
    ? Response.json({ type: "error", error: body }, { status: 400 })
    : wireResponse([{ type: "error", error: body }]) });
  const frames: AnthropicOperations = {
    createStream: async () => ({ data: Object.assign((async function* () { yield { type: "error" as const, error: body }; })(), { controller: new AbortController() }), response: new Response(null) }),
    isBadRequestError: (error) => error instanceof Anthropic.BadRequestError,
  };
  const operations = { ...(entry === "frame" ? frames : operationsFromAnthropicClient(sdk)), ...(route.preparedBlock ? { preparedBlock: route.preparedBlock } : {}) };
  const model = route.model ?? imageModel;
  return createAnthropicAdapter(Redacted.make("test-key"), model.id, model, { operations });
}

async function refusalOf(entry: Entry, messages: ConversationMessage[], message: string, route: Parameters<typeof refusing>[2] = {}, overrides: Partial<StreamOptions> = {}) {
  const failure = await failureOf(await refusing(entry, refusalBody(message), route), { messages, ...overrides });
  if (!(failure instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome", { cause: failure });
  return failure;
}

const ENTRIES: Entry[] = ["http", "stream", "frame"];
interface LocatedCase { entry: Entry; name: string; history: ConversationMessage[]; path: string; id: string; partIndex: number; effort?: boolean; engine?: boolean }
interface UnlocatedCase { entry: Entry; name: string; history: ConversationMessage[]; message: string; engine?: boolean; model?: ModelInfo }
const textOnlyModel: ModelInfo = { ...imageModel, modalities: { input: ["text"], output: ["text"] } };
const reminder: ConversationMessage = { kind: "user", origin: "system", content: "<system-reminder>\nCurrent local date: 2026-10-24.\n</system-reminder>", framing: "reminder" };
// Wire: 0 greeting, 1 the engine's section, 2 answer, 3 the request, 4 the engine's copy of the reminder.
const remindedGreeting: ConversationMessage[] = [{ kind: "user", content: "Say hello." }, { kind: "assistant", content: [{ type: "text", text: "Hello." }], ...sameProvider, timestamp: 1 }, reminder];

describe("Anthropic content refusals", () => {
  it.each(ENTRIES.flatMap((entry): LocatedCase[] => [
    { entry, name: "native route", history: twoReads([{ type: "text", text: "b" }, imagePart]), path: "messages.2.content.1.tool_result.content.1.image.source.base64", id: "toolu_b", partIndex: 1 },
    { entry, name: "native route behind the per-turn effort message", history: twoReads([{ type: "text", text: "b" }, imagePart]), path: "messages.3.content.1.tool_result.content.1.image.source.base64", id: "toolu_b", partIndex: 1, effort: true },
    { entry, name: "Claude engine, which adds a message after the first", history: twoReads([{ type: "text", text: "b" }, imagePart]), path: "messages.3.content.1.tool_result.content.1.image.source.base64", id: "toolu_b", partIndex: 1, engine: true },
    { entry, name: "reminders after the tool results on the Claude engine", history: twoReads([{ type: "text", text: "b" }, imagePart], undefined, sameProvider, [reminder]), path: "messages.3.content.1.tool_result.content.1.image.source.base64", id: "toolu_b", partIndex: 1, engine: true },
    { entry, name: "an earlier reminder, which the Claude engine sends as its own message", history: [...remindedGreeting, ...twoReads([{ type: "text", text: "b" }, imagePart])], path: "messages.6.content.1.tool_result.content.1.image.source.base64", id: "toolu_b", partIndex: 1, engine: true },
    { entry, name: "a whitespace text part that the wire drops (probe d4)", history: twoReads([{ type: "text", text: "  " }, imagePart, imagePart]), path: "messages.2.content.1.tool_result.content.0.image.source.base64", id: "toolu_b", partIndex: 1 },
    { entry, name: "a foreign call id that the request rewrites", history: twoReads([{ type: "text", text: "b" }, imagePart], ["fc/a", "fc/b"], otherProvider), path: "messages.2.content.1.tool_result.content.1.image.source.base64", id: "fc/b", partIndex: 1 },
  ]))("names the canonical tool result part: $name ($entry)", async ({ entry, history, path, id, partIndex, effort, engine }) => {
    const failure = await refusalOf(entry, history, `${path}: ${D1_REASON}`, engine ? { preparedBlock: engineBlockLocation } : {}, { reasoningEffort: effort ? "low" : "off" });
    expect(failure.failure._tag).toBe("InvalidRequestFailure");
    expect(failure.cause).toBeInstanceOf(ContentRefusedError);
    if (!(failure.cause instanceof ContentRefusedError)) return;
    expect(failure.cause.part).toEqual({ toolUseId: id, partIndex, kind: "image" });
    expect(failure.cause.reason).toBe(D1_REASON);
    expect(failure.cause.cause.message).toContain(path);
  });

  it("sends the per-turn effort message that shifts the native wire index", async () => {
    let roles: unknown;
    const sdk = new Anthropic({ apiKey: "test-key", maxRetries: 0, fetch: async (_url, init) => {
      const body: { messages: { role: string }[] } = JSON.parse(String(init?.body));
      roles = body.messages.map((message) => message.role);
      return wireResponse([]);
    } });
    await failureOf(await createAnthropicAdapter(Redacted.make("test-key"), imageModel.id, imageModel, { operations: operationsFromAnthropicClient(sdk) }), { messages: twoReads([imagePart]), reasoningEffort: "low" });
    expect(roles).toEqual(["user", "system", "assistant", "user"]);
  });

  it.each(ENTRIES.flatMap((entry): UnlocatedCase[] => [
    { entry, name: "the message that holds the Claude engine's copy of earlier reminders", history: [...remindedGreeting, ...twoReads([{ type: "text", text: "b" }, imagePart])], message: `messages.4.content.1.tool_result.content.1.image.source.base64: ${D1_REASON}`, engine: true },
    { entry, name: "the Claude engine's own section message", history: twoReads([{ type: "text", text: "b" }, imagePart]), message: `messages.1.content.1.tool_result.content.1.image.source.base64: ${D1_REASON}`, engine: true },
    { entry, name: "a path whose wire part has another kind", history: twoReads([{ type: "text", text: "b" }, imagePart]), message: `messages.2.content.1.tool_result.content.0.image.source.base64: ${D1_REASON}` },
    { entry, name: "a wire placeholder for an image that the model cannot read", history: twoReads([{ type: "text", text: "b" }, imagePart]), message: "messages.2.content.1.tool_result.content.1.text: The text is invalid", model: textOnlyModel },
    { entry, name: "a user attachment", history: [{ kind: "user", content: [{ type: "text", text: "Look." }, imagePart] }], message: `messages.0.content.1.image.source.base64: ${D1_REASON}` },
    { entry, name: "a lowered result", history: [{ kind: "user", content: "Read it." }, { kind: "assistant", content: [{ type: "text", text: "Earlier operation toolu_b: changed." }], ...sameProvider, timestamp: 1 }, { kind: "user", origin: "system", content: [{ type: "text", text: "Earlier operation toolu_b result:" }, imagePart] }], message: `messages.2.content.1.image.source.base64: ${D1_REASON}` },
    { entry, name: "an image refusal with no path (probe d3)", history: twoReads([imagePart]), message: "Could not process image" },
  ]))("refuses content without a located part: $name ($entry)", async ({ entry, history, message, engine, model }) => {
    const failure = await refusalOf(entry, history, message, { ...(engine ? { preparedBlock: engineBlockLocation } : {}), ...(model ? { model } : {}) });
    expect(failure.cause).toBeInstanceOf(ContentRefusedError);
    if (!(failure.cause instanceof ContentRefusedError)) return;
    expect(failure.cause.part).toBeUndefined();
  });

  it.each(ENTRIES)("keeps a request error about another field unchanged (%s)", async (entry) => {
    const failure = await refusalOf(entry, twoReads([imagePart]), "temperature: Input should be a valid number");
    expect(failure.cause).not.toBeInstanceOf(ContentRefusedError);
    expect(failure.cause instanceof Error ? failure.cause.message : "").toContain("temperature: Input should be a valid number");
    if (entry === "http") expect(failure.failure._tag).toBe("InvalidRequestFailure");
  });
});
