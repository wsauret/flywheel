/** Terminal quota classification on the anthropic-messages wire. The Copilot
 *  proxy serves Claude models over this wire and rejects a spent premium
 *  allowance with 402, which must advance the provider chain to the metered
 *  API key instead of retrying against the spent subscription. */

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, test } from "bun:test";
import { classifyAnthropicError } from "../../../../../src/orchestration/agent-runtime/llm/anthropic-adapter-helpers.js";
import { LlmStreamError, ModelAccessRefusedError, QuotaExhaustedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";

function apiError(status: number, message: string): InstanceType<typeof Anthropic.APIError> {
  return new Anthropic.APIError(status, { error: { message } }, message, new Headers());
}

describe("classifyAnthropicError terminal quota failures", () => {
  test("a 402 is a terminal QuotaExhaustedError, never retried", () => {
    const classified = classifyAnthropicError(apiError(402, "You have exceeded your premium request allowance."));
    expect(classified).toBeInstanceOf(QuotaExhaustedError);
    // Terminal: the retry policy refuses it, so the provider chain sees it.
  });

  test("a 429 naming a spent quota is terminal, not a rate limit", () => {
    const classified = classifyAnthropicError(apiError(429, "Quota exceeded for premium requests on this account."));
    expect(classified).toBeInstanceOf(QuotaExhaustedError);
  });

  test("a plain 429 stays a retryable rate limit", () => {
    const classified = classifyAnthropicError(apiError(429, "Number of request tokens has exceeded your per-minute rate limit."));
    expect(classified).toBeInstanceOf(LlmStreamError);
    if (!(classified instanceof LlmStreamError)) throw new Error("expected LlmStreamError");
    expect(classified.kind).toBe("rate_limit");
  });

  test.each([400, 429])("a %i depleted credit balance is terminal quota exhaustion", (status) => {
    const classified = classifyAnthropicError(apiError(status, "Your credit balance is too low to access the Anthropic API."));
    expect(classified).toBeInstanceOf(QuotaExhaustedError);
  });

  test.each([
    "Extra usage is required for long context requests.",
    "Usage credits are required for long context requests.",
  ])("a 429 that asks for usage credits for long context refuses the extended window, not the provider (%s)", (message) => {
    const classified = classifyAnthropicError(apiError(429, message));
    expect(classified).toBeInstanceOf(ModelAccessRefusedError);
    if (!(classified instanceof ModelAccessRefusedError)) throw new Error("expected ModelAccessRefusedError");
    expect(classified.refusal).toEqual({ kind: "extended-context", contextLimit: 200_000 });
  });

  test("a 404 not_found_error that names the model refuses the model, not the provider", () => {
    const body = { type: "error", error: { type: "not_found_error", message: "model: claude-opus-9" } };
    const classified = classifyAnthropicError(new Anthropic.APIError(404, body, undefined, new Headers()));
    expect(classified).toBeInstanceOf(ModelAccessRefusedError);
    if (!(classified instanceof ModelAccessRefusedError)) throw new Error("expected ModelAccessRefusedError");
    expect(classified.refusal).toEqual({ kind: "model" });
  });

  test("a 404 not_found_error about something other than the model stays unclassified", () => {
    const body = { type: "error", error: { type: "not_found_error", message: "file: file_011" } };
    expect(classifyAnthropicError(new Anthropic.APIError(404, body, undefined, new Headers()))).not.toBeInstanceOf(ModelAccessRefusedError);
  });

  test("a proxy envelope of a long-context refusal refuses the extended window, not a rate limit", () => {
    const envelope = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Extra usage is required for long context requests." } });
    const classified = classifyAnthropicError(new Error(envelope));
    expect(classified).toBeInstanceOf(ModelAccessRefusedError);
  });

  test("a long-context refusal wrapped as the cause of another error keeps its class", () => {
    const classified = classifyAnthropicError(new Error("stream failed", { cause: apiError(429, "Extra usage is required for long context requests.") }));
    expect(classified).toBeInstanceOf(ModelAccessRefusedError);
  });
});
