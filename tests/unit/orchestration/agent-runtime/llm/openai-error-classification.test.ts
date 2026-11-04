import { describe, expect, spyOn, test } from "bun:test";
import OpenAI from "openai";
import { ChatGptAdapterApiError, mapChatGptAdapterEvents } from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/sse.js";
import { parseChatGptAdapterErrorResponse } from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter-error.js";
import { classifyOpenAIStreamError, classifyResponseFailed, createOpenAIStream } from "../../../../../src/orchestration/agent-runtime/llm/openai-helpers.js";
import { ContentFilteredError, ContentRefusedError, ContextLengthExceededError, LlmStreamError, ProviderRequestValidationError, QuotaCoordinationError, QuotaExhaustedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { createOpenAIChatCompletionsAdapter } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions.js";
import { ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { ChatGptAdapterTransportError } from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/types.js";

interface UnknownRecord {
  [key: string]: unknown;
}

function classify(err: unknown, quotaObservation?: Parameters<typeof classifyOpenAIStreamError>[1]): Error {
  try {
    classifyOpenAIStreamError(err, quotaObservation);
  } catch (classified) {
    if (classified instanceof Error) return classified;
    throw new Error("classifyOpenAIStreamError threw a non-error value", { cause: classified });
  }
  throw new Error("classifyOpenAIStreamError did not throw");
}

async function* once(event: UnknownRecord): AsyncGenerator<UnknownRecord> {
  yield event;
}

async function drainAdapterEvents(event: UnknownRecord): Promise<Error> {
  try {
    for await (const _ of mapChatGptAdapterEvents(once(event))) {
      // exhaust
    }
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error("mapChatGptAdapterEvents threw a non-error value", { cause: err });
  }
  throw new Error("mapChatGptAdapterEvents did not throw");
}

describe("classifyOpenAIStreamError folds ChatGptAdapterApiError into the stream-error family", () => {
  test("an unsupported parameter rejection is invalid request, not a connection loss", () => {
    const backend = new ChatGptAdapterApiError("Unsupported parameter", { code: "unsupported_parameter" });
    const result = classify(new ChatGptAdapterTransportError("read", backend));
    expect(result).toBeInstanceOf(ProviderRequestValidationError);
    expect(result.message).toContain("Unsupported parameter");
  });
  test("a rate-limit ChatGptAdapterApiError becomes a retryable LlmStreamError", () => {
    const classified = classify(
      new ChatGptAdapterApiError("slow down", { code: "rate_limit_exceeded" }),
    );
    expect(classified).toBeInstanceOf(LlmStreamError);
    if (!(classified instanceof LlmStreamError)) throw new Error("expected LlmStreamError");
    expect(classified.kind).toBe("rate_limit");
  });

  test("a usage-limit ChatGptAdapterApiError is terminal, not retried as transient", () => {
    const classified = classify(
      new ChatGptAdapterApiError("usage limit reached", { code: "usage_limit_reached" }),
    );
    // A quota ceiling cannot clear within the retry window, so the loop must
    // not hammer it.
    expect(classified).toBeInstanceOf(QuotaExhaustedError);
  });

  test("structural quota evidence survives a lost adapter prototype", () => {
    const source = Object.assign(new Error("ChatGPT backend error: The usage limit has been reached"), {
      payload: { type: "error", error: { type: "usage_limit_reached", message: "The usage limit has been reached" } },
    });
    const quotaObservation = {
      exhaustion: { exhaustedAtMs: 1_000, resetsAtMs: 2_000 },
      newlyExhausted: true,
      reportedResetAtMs: 2_000,
    };

    const classified = classify(source, quotaObservation);

    expect(classified).toBeInstanceOf(QuotaExhaustedError);
    if (!(classified instanceof QuotaExhaustedError)) throw new Error("expected QuotaExhaustedError");
    expect(classified.cause).toBe(source);
    expect(classified.quotaObservation).toBe(quotaObservation);
  });

  test("preserves a quota code while normalizing an HTTP ChatGPT error", async () => {
    const error = await parseChatGptAdapterErrorResponse(new Response(JSON.stringify({
      error: { code: "usage_limit_reached", message: "weekly allowance reached" },
    }), { status: 429 }));
    expect(error.code).toBe("usage_limit_reached");
    expect(classify(new ChatGptAdapterApiError(error.message, { code: error.code ?? "" }))).toBeInstanceOf(QuotaExhaustedError);
  });

  test.each(["insufficient_quota", "usage_not_included", "usage_limit_reached"])(
    "%s is a terminal quota failure",
    (code) => {
      const classified = classifyResponseFailed({ code, message: "no credit left" }, undefined);
      expect(classified).toBeInstanceOf(QuotaExhaustedError);
    },
  );

  test.each(["server_is_overloaded", "slow_down", "server_error"])("%s stays a terminal overload, not a quota failure", (code) => {
    const classified = classifyResponseFailed({ code, message: "busy" }, undefined);
    expect(classified).toBeInstanceOf(LlmStreamError);
    if (!(classified instanceof LlmStreamError)) throw new Error("expected LlmStreamError");
    expect(classified.kind).toBe("overload");
  });

  test("an overloaded message classifies as overload whatever code carries it", () => {
    const classified = classifyResponseFailed({ code: "something_new", message: "Our servers are currently overloaded. Please try again later." }, undefined);
    expect(classified).toBeInstanceOf(LlmStreamError);
    if (!(classified instanceof LlmStreamError)) throw new Error("expected LlmStreamError");
    expect(classified.kind).toBe("overload");
  });

  test("rate limits keep their retryable classification", () => {
    const classified = classifyResponseFailed({ code: "rate_limit_exceeded", message: "try again in 2s" }, undefined);
    expect(classified).toBeInstanceOf(LlmStreamError);
    if (!(classified instanceof LlmStreamError)) throw new Error("expected LlmStreamError");
    expect(classified.kind).toBe("rate_limit");
  });

  test.each(["invalid_request_error", "bad_request_error"])("%s is a deterministic rejection, never retried", (code) => {
    const classified = classifyResponseFailed({ code, message: "No tool output found for function call call_x." }, undefined);
    expect(classified).not.toBeInstanceOf(LlmStreamError);
  });

  test("an HTTP rate-limit code stays retryable even when ChatGPT renders usage-limit copy", () => {
    const message = "You have hit your ChatGPT usage limit. Try again in ~1 min.";
    const classified = classify(new OpenAI.APIError(
      429,
      { message, type: "chatgpt_usage_limit", code: "rate_limit_exceeded" },
      message,
      new Headers(),
    ));
    expect(classified).toBeInstanceOf(LlmStreamError);
    if (!(classified instanceof LlmStreamError)) throw new Error("expected LlmStreamError");
    expect(classified.kind).toBe("rate_limit");
  });

  test("preserves the extracted code from a ChatGPT backend error frame through retry classification", async () => {
    const backendError = await drainAdapterEvents({
      type: "error",
      code: "rate_limit_exceeded",
      message: "too many requests",
    });
    expect(backendError).toBeInstanceOf(ChatGptAdapterApiError);
    if (!(backendError instanceof ChatGptAdapterApiError)) throw new Error("expected ChatGptAdapterApiError");
    expect(backendError.code).toBe("rate_limit_exceeded");

    const classified = classify(backendError);
    expect(classified).toBeInstanceOf(LlmStreamError);
    if (!(classified instanceof LlmStreamError)) throw new Error("expected LlmStreamError");
    expect(classified.kind).toBe("rate_limit");
  });

  test("a missing-parameter rejection is a request defect: deterministic, never retried, never failed over", () => {
    const classified = classify(
      new ChatGptAdapterApiError("ChatGPT backend error: One of \"input\" or \"previous_response_id\" must be provided.", { code: "missing_required_parameter" }),
    );
    expect(classified).toBeInstanceOf(ProviderRequestValidationError);
  });

  test("a WebSocket transport failure classifies by the backend frame it wraps", () => {
    const frame = new ChatGptAdapterApiError("You have hit your usage limit", { code: "usage_limit_reached" });
    const classified = classify(new ChatGptAdapterTransportError("read", frame));
    expect(classified).toBeInstanceOf(QuotaExhaustedError);

    const rejected = classify(new ChatGptAdapterTransportError("read", new ChatGptAdapterApiError("bad input", { code: "missing_required_parameter" })));
    expect(rejected).toBeInstanceOf(ProviderRequestValidationError);
  });

  test("a Responses 400 naming the input is a content refusal that keeps today's failure text", () => {
    const body = { type: "invalid_request_error", param: "input", code: "invalid_value", message: "The image data you provided does not represent a valid image." };
    const failure = new OpenAI.BadRequestError(400, body, undefined, new Headers());
    const classified = classify(failure);
    expect(classified).toBeInstanceOf(ContentRefusedError);
    if (!(classified instanceof ContentRefusedError)) throw new Error("expected ContentRefusedError");
    expect(classified.part).toBeUndefined();
    expect(classified.reason).toBe(body.message);
    expect(classified.cause).toBe(failure);
    expect(classified.cause.message).toBe(`400 ${body.message}`);
  });

  test("a Responses 400 naming the input for its length is a context overflow, not a content refusal", () => {
    const message = "This model's maximum context length is 272000 tokens. However, your messages resulted in 300000 tokens.";
    const body = { type: "invalid_request_error", param: "input", code: "context_length_exceeded", message };
    const classified = classify(new OpenAI.BadRequestError(400, body, undefined, new Headers()));
    expect(classified.name).toBe("ContextLengthExceededError");
  });

  test("a ChatGPT backend input_image rejection is a content refusal that keeps today's failure text", () => {
    const message = "ChatGPT backend error: input_image image_url unsupported image format: unknown";
    const classified = classify(new ChatGptAdapterApiError(message, { code: "invalid_request_error" }));
    expect(classified).toBeInstanceOf(ContentRefusedError);
    if (!(classified instanceof ContentRefusedError)) throw new Error("expected ContentRefusedError");
    expect(classified.part).toBeUndefined();
    expect(classified.reason).toBe(message);
    expect(classified.cause).toBeInstanceOf(ProviderRequestValidationError);
    expect(classified.cause.message).toBe(`OpenAI request validation failed: ${message}`);
  });

  test("an unsupported parameter rejection is not a content refusal", () => {
    const classified = classify(new ChatGptAdapterApiError("Unsupported parameter: temperature", { code: "unsupported_parameter" }));
    expect(classified).toBeInstanceOf(ProviderRequestValidationError);
    expect(classified).not.toBeInstanceOf(ContentRefusedError);
    expect(classified.message).toBe("OpenAI request validation failed: Unsupported parameter: temperature");
  });

  test("a context-length ChatGptAdapterApiError routes to the overflow error, not a generic ApiError", () => {
    const classified = classify(
      new ChatGptAdapterApiError("context too long", { code: "context_length_exceeded" }),
    );
    if (!(classified instanceof Error)) throw new Error("expected Error");
    expect(classified.name).toBe("ContextLengthExceededError");
  });

  test("a 402 from the Copilot proxy is a terminal QuotaExhaustedError", () => {
    const message = "You have exceeded your premium request allowance.";
    const classified = classify(new OpenAI.APIError(402, { message }, message, new Headers()));
    expect(classified).toBeInstanceOf(QuotaExhaustedError);
  });

  test("a Responses 408 is a lost connection that the walk retries in place", () => {
    const classified = classify(new OpenAI.APIError(408, { message: "Request timed out" }, "Request timed out", new Headers()));
    expect(classified).toBeInstanceOf(LlmStreamError);
    if (!(classified instanceof LlmStreamError)) throw new Error("expected LlmStreamError");
    expect(classified.kind).toBe("transient");
  });

  test.each([
    { code: "server_error", expected: "overload" },
    { code: "rate_limit_exceeded", expected: "rate_limit" },
    { code: "context_length_exceeded", expected: "ContextLengthExceededError" },
  ])("a named Responses error frame with $code classifies like the frame it carries", async ({ code, expected }) => {
    const classified = classify(await namedErrorFrameFailure({ type: "error", sequence_number: 1, code, message: "frame failure", param: null }));
    expect(classified instanceof LlmStreamError ? classified.kind : classified.name).toBe(expected);
    expect(classified.message).toContain("frame failure");
  });

  test.each([
    { type: "rate_limit_exceeded", expected: "rate_limit" },
    { type: "overloaded_error", expected: "overload" },
  ])("a named error frame that names $type only as its type is classified by it", async ({ type, expected }) => {
    const classified = classify(await namedErrorFrameFailure({ error: { type, message: "frame failure" } }));
    expect(classified).toBeInstanceOf(LlmStreamError);
    if (!(classified instanceof LlmStreamError)) throw new Error("expected LlmStreamError");
    expect(classified.kind).toBe(expected);
  });

  test("a named rate-limit error frame keeps the retry-after-ms delay of its response", async () => {
    const thrown = await namedErrorFrameFailure({ type: "error", sequence_number: 1, code: "rate_limit_exceeded", message: "frame failure", param: null }, "4200");
    const classified = classify(thrown);
    expect(classified).toBeInstanceOf(LlmStreamError);
    if (!(classified instanceof LlmStreamError)) throw new Error("expected LlmStreamError");
    expect(classified.retryDelayMs).toBe(4200);
    expect(classified.cause).toBe(thrown);
  });

  test("a coordination failure thrown inside the SDK fetch is unwrapped, terminal, and never a connection blip", () => {
    const coordination = new QuotaCoordinationError({
      message: "the chatgpt quota suppression did not reach the account's availability authority",
      provider: "chatgpt",
      reason: "SQLITE_BUSY",
    });
    const classified = classify(new OpenAI.APIConnectionError({ message: "Connection error.", cause: coordination }));
    expect(classified).toBe(coordination);
  });
});

/** The error the real SDK throws when a Responses stream sends `data` as a named `event: error` frame. */
async function namedErrorFrameFailure(data: UnknownRecord, retryAfterMs?: string): Promise<Error> {
  const sdk = new OpenAI({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async () => new Response(`event: error\ndata: ${JSON.stringify(data)}\n\n`, { headers: { "content-type": "text/event-stream", ...(retryAfterMs === undefined ? {} : { "retry-after-ms": retryAfterMs }) } }),
  });
  try {
    for await (const _ of await createOpenAIStream(sdk, { model: "gpt-5.4", input: "hi", stream: true }, new AbortController().signal)) {
      // exhaust
    }
  } catch (err) {
    if (err instanceof Error) return err;
    throw new Error("the Responses stream threw a non-error value", { cause: err });
  }
  throw new Error("the Responses stream did not fail");
}

/** The error the chat-completions adapter raises when the real SDK meets `error` as an HTTP response with
 *  `status`, or as an in-stream error frame when `status` is undefined. */
async function chatCompletionsFailure(status: number | undefined, error: UnknownRecord): Promise<Error> {
  const sdk = new OpenAI({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async () => status === undefined
      ? new Response(`data: ${JSON.stringify({ error })}\n\n`, { headers: { "content-type": "text/event-stream" } })
      : Response.json({ error }, { status }),
  });
  const models = { async refresh() {}, getProviderCatalog() { return []; }, getTokenizerIdentity() { return undefined; } };
  const client = await createOpenAIChatCompletionsAdapter(sdk, "gpt-4o", models, { resolvedModelMetadata: null });
  try {
    for await (const _event of client.streamWithTools({ messages: [{ kind: "user", content: "hi" }], tools: [], systemPrompt: stableSystemPrompt("system"), reasoningEffort: "off" })) {
      // exhaust
    }
  } catch (failure) {
    const cause = failure instanceof ProviderAttemptFailure ? failure.cause : failure;
    if (cause instanceof Error) return cause;
    throw new Error("the chat-completions adapter threw a non-error value", { cause: failure });
  }
  throw new Error("the chat-completions adapter did not fail");
}

describe("chat-completions error classification", () => {
  test.each([408, 409])("a %i is a lost connection that the walk retries in place", async (status) => {
    const classified = await chatCompletionsFailure(status, { message: "Request timed out", type: "server_error" });
    expect(classified).toBeInstanceOf(LlmStreamError);
    if (!(classified instanceof LlmStreamError)) throw new Error("expected LlmStreamError");
    expect(classified.kind).toBe("transient");
  });

  test.each([
    { name: "an HTTP 400", status: 400, error: { code: "context_length_exceeded", type: "invalid_request_error", message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130000 tokens." } },
    { name: "an HTTP 413", status: 413, error: { code: "context_length_exceeded", type: "invalid_request_error", message: "Request too large." } },
    { name: "an in-stream frame", status: undefined, error: { code: "context_length_exceeded", type: "invalid_request_error", message: "Input exceeds the context window of this model." } },
  ])("$name that names the context length is a context overflow", async ({ status, error }) => {
    expect(await chatCompletionsFailure(status, error)).toBeInstanceOf(ContextLengthExceededError);
  });

  test("an in-stream content_filter frame is a content filter stop", async () => {
    expect(await chatCompletionsFailure(undefined, { code: "content_filter", type: "invalid_request_error", message: "The response was filtered due to the prompt triggering content management policy." })).toBeInstanceOf(ContentFilteredError);
  });
});

test("a cache-field 404 performs one Responses request and preserves the provider failure", async () => {
  const message = "Not found";
  const failure = new OpenAI.NotFoundError(404, { message }, message, new Headers());
  let requests = 0;
  const client = new OpenAI({ apiKey: "test-key", maxRetries: 0 });
  const create = spyOn(client.responses, "create").mockImplementation(() => {
    requests += 1;
    throw failure;
  });

  try {
    await expect(createOpenAIStream(
      client,
      {
        model: "gpt-5.4",
        input: "hi",
        stream: true,
        prompt_cache_key: "session",
        prompt_cache_retention: "24h",
      },
      new AbortController().signal,
    )).rejects.toBe(failure);
    expect(requests).toBe(1);
  } finally { create.mockRestore(); }
});
