import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { classifyAnthropicError } from "../../../../../src/orchestration/agent-runtime/llm/anthropic-adapter-helpers.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { wireFailure } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/service-requests.js";
import {
  admittedStart, answers, apiErrorLine, forwardDiagnostics, init, logLines, modelRequest, payloads, records, refused, rateLimitReport, request, responseBlock, send, sentBlock, settle,
  streamErrorLine, text, U1, until, withBridge,
} from "./_bridge-harness.js";

forwardDiagnostics();

describe("the chat engine's service requests in its debug output", () => {
  test("an answer that the CLI logged becomes the error that the native client raises for the same response", () => {
    const body = '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}';
    const headers = new Headers({ "request-id": "req_1", "retry-after": "17" });
    const native = Anthropic.APIError.generate(400, JSON.parse(body), undefined, headers);
    const failure = wireFailure({ status: 400, body, headers });
    expect(failure).toBeInstanceOf(Anthropic.BadRequestError);
    expect(failure).toMatchObject({ status: 400, message: native.message, error: native.error, requestID: "req_1", headers });
    const plain = wireFailure({ status: 400, body: "Bad Request", headers: new Headers() });
    expect(plain).toBeInstanceOf(Anthropic.BadRequestError);
    expect(plain.message).toBe("400 Bad Request");
    // The Anthropic client raises an SSE error event with no status, its body as the message, and its type.
    const event = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    const streamed = wireFailure({ status: undefined, body: event, headers });
    expect(streamed).toBeInstanceOf(Anthropic.APIError);
    expect(streamed).toMatchObject({ status: undefined, message: event, error: JSON.parse(event), type: "overloaded_error", requestID: "req_1" });
  });

  test("an HTTP 400 that the CLI logs fails the open request once with the native error, and its resend never reaches the adapter", () => withBridge(async ({ ops, queries, log }) => {
    const first = await send(ops, request([U1]));
    queries[0]?.emit(init);
    await settle();
    const body = '{"type":"error","error":{"type":"invalid_request_error","message":"thinking.type: adaptive is not supported"}}';
    logLines(queries[0], [...modelRequest(), ...responseBlock("error", 400, { "request-id": "req_1" }), apiErrorLine(400, body)]);
    // The CLI's healer resends at once, before the interrupt reaches it.
    logLines(queries[0], modelRequest("log_resend"));
    queries[0]?.emit(...answers("Healed."));
    const error = await first.error;
    expect(error).toBeInstanceOf(Anthropic.BadRequestError);
    expect(error).toMatchObject({ message: `400 ${body}`, error: JSON.parse(body) });
    expect(first.types).toEqual([]);
    await until(() => log.includes("close"));
    expect(log).toEqual(["push", "interrupt", "close"]);
    expect(payloads("provider.claude_sdk.query.stopped")[0]).toMatchObject({ reason: "cli-error", rule: "api-error-line", phase: "awaiting", evidence: { report: "none", status: 400 } });
    expect(JSON.stringify(records)).not.toContain("adaptive is not supported");
  }));

  // Every model request of the chat's engine is its main loop's: with nonessential traffic off, the engine sends no
  // side query (CLI 2.1.306). Its token counts and other API requests answer on their own records.
  test("an HTTP error of a request that the engine sends to another endpoint, such as a token count, leaves the open request to its own stream", () => withBridge(async ({ ops, queries, log }) => {
    const first = await send(ops, request([U1]));
    const query = queries[0];
    query?.emit(init);
    await settle();
    const body = '{"type":"error","error":{"type":"invalid_request_error","message":"count refused"},"request_id":"req_count"}';
    logLines(query, [
      ...modelRequest(), ...responseBlock("start", 200, { "request-id": "req_main" }),
      ...sentBlock("log_count", { path: "/v1/messages/count_tokens" }), ...responseBlock("error", 400, { "request-id": "req_count" }, "log_count"), apiErrorLine(400, body),
    ]);
    await settle();
    query?.emit(...answers("Done."));
    expect(await first.error).toBeUndefined();
    expect(log).toEqual(["push"]);
    expect(payloads("provider.claude_sdk.api_error.unattributed")).toEqual([{ sessionId: query?.launch.session.id, signal: "http", status: 400, model: false, hosted: false }]);
    expect(JSON.stringify(records)).not.toContain("count refused");
  }));

  test("an error body that joins no record ends the engine's version as silent output: the open request fails closed", () => withBridge(async ({ ops, queries }) => {
    const first = await send(ops, request([U1]));
    const query = queries[0];
    query?.emit(init);
    await settle();
    logLines(query, [
      ...modelRequest(), ...responseBlock("error", 400, { "request-id": "req_1" }),
      apiErrorLine(400, '{"type":"error","error":{"type":"invalid_request_error","message":"other"},"request_id":"req_other"}'),
    ]);
    expect(String(await first.error)).toContain("wrote debug output that does not account for the model requests");
    expect(payloads("provider.claude_sdk.debug_output.silent")).toEqual([{ sessionId: query?.launch.session.id, cliVersion: expect.any(String), rule: "body-unjoined" }]);
  }));

  test("an HTTP error that the engine logs for the open request fails it at once with the native error, its retry-after, and its request id, and the report of the refused request holds nothing", () => withBridge(async ({ ops, queries, log, quotaMarks, usageStops }) => {
    const body = '{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"},"request_id":"req_wire"}';
    const first = await send(ops, request([U1]));
    const query = queries[0];
    query?.emit(init);
    await settle();
    // The engine reports a response without the unified headers as rejected with no usage window (CLI 2.1.296).
    query?.emit(rateLimitReport({ status: "rejected", isUsingOverage: false }));
    // A response block of another request that the reader cannot read, then the status line of the open request,
    // then its response block, each arriving as the engine wrote it.
    logLines(query, [
      ...modelRequest(), "[Anthropic SDK DEBUG] [log_0a1b2b] response error (error; not retryable) {", "}",
      '[Anthropic SDK INFO] [log_0a1b2c, request-id: "req_wire"] post http://127.0.0.1:1/v1/messages?beta=true failed with status 429 in 1ms - error; no more retries left',
    ]);
    await settle();
    logLines(query, [...responseBlock("error", 429, { "request-id": "req_wire", "retry-after": "17" }), apiErrorLine(429, body)]);
    const error = await first.error;

    const native = Anthropic.APIError.generate(429, JSON.parse(body), undefined, new Headers({ "request-id": "req_wire", "retry-after": "17" }));
    expect(error).toBeInstanceOf(Anthropic.RateLimitError);
    expect(error).toMatchObject({ status: 429, message: native.message, error: native.error, requestID: "req_wire" });
    expect(normalizeProviderAttemptFailure(classifyAnthropicError(error)).failure).toMatchObject({ _tag: "RateLimitFailure", retryAfterMs: 17_000 });
    await until(() => log.includes("close"));
    expect(log).toEqual(["push", "interrupt", "close"]);
    expect([quotaMarks, usageStops]).toEqual([[], []]);
    expect(payloads("provider.claude_sdk.query.stopped")[0]).toMatchObject({ reason: "cli-error", rule: "api-error-line", evidence: { report: "none", status: 429 } });
    expect(payloads("provider.claude_sdk.response_log.unread")).toEqual([{ sessionId: query?.launch.session.id }]);
    expect(JSON.stringify(records)).not.toContain("per-minute");
  }));

  test("an SSE error event that ends the open request's stream fails it with the error that the native client raises, with the stream's request id", () => withBridge(async ({ ops, queries, log }) => {
    const body = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    const first = await send(ops, request([U1]));
    const query = queries[0];
    query?.emit(init, ...admittedStart(), ...text(0, "par"));
    await settle();
    logLines(query, [...modelRequest(), ...responseBlock("start", 200, { "request-id": "req_stream" }), streamErrorLine(body)]);
    const error = await first.error;

    expect(error).toBeInstanceOf(Anthropic.APIError);
    expect(error).toMatchObject({ status: undefined, message: body, error: JSON.parse(body), requestID: "req_stream" });
    expect(normalizeProviderAttemptFailure(classifyAnthropicError(error)).failure).toMatchObject({ _tag: "OverloadedFailure", message: body });
    expect(first.types).toEqual(["message_start", "content_block_start", "content_block_delta", "content_block_stop"]);
    await until(() => log.includes("close"));
    expect(payloads("provider.claude_sdk.query.stopped")[0]).toMatchObject({ reason: "cli-error", rule: "stream-error-line", phase: "streaming" });
  }));

  test("an HTTP 401 waits for the engine's turn end, because the engine renews its login and sends the request again, and then fails with the native error", () => withBridge(async ({ ops, queries, log, outcomes }) => {
    const body = '{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}';
    const first = await send(ops, request([U1]));
    const query = queries[0];
    query?.emit(init);
    await settle();
    logLines(query, [...modelRequest("log_1"), ...responseBlock("error", 401, { "request-id": "req_1" }, "log_1"), apiErrorLine(401, body)]);
    await settle();
    expect(log).toEqual(["push"]);
    logLines(query, [...modelRequest("log_2"), ...responseBlock("error", 401, { "request-id": "req_2" }, "log_2"), apiErrorLine(401, body)]);
    query?.emit(...refused("authentication_failed", 401, "Failed to authenticate. API Error: 401 OAuth token has expired · Please run /login"));
    const error = await first.error;

    expect(error).toBeInstanceOf(Anthropic.AuthenticationError);
    expect(error).toMatchObject({ status: 401, message: `401 ${body}`, error: JSON.parse(body), requestID: "req_2" });
    expect(outcomes).toEqual(["login-rejected"]);
    expect(log).toEqual(["push", "close"]);
    expect(payloads("provider.claude_sdk.query.stopped")[0]).toMatchObject({ reason: "cli-error", rule: "turn-result-during-request", evidence: { report: "authentication_failed", status: 401, wire: "http" } });
  }));

});
