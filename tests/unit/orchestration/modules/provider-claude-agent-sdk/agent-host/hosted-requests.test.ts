import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { classifyAnthropicError } from "../../../../../../src/orchestration/agent-runtime/llm/anthropic-adapter-helpers.js";
import { LlmStreamError, ProviderRequestValidationError } from "../../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { isFailoverFailure, normalizeProviderAttemptFailure } from "../../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { hostedRequests } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/hosted-requests.js";
import { wireFailure } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/service-requests.js";
import { debugLineReader, silentVersions } from "../../../../../../src/orchestration/modules/provider-claude-agent-sdk/stderr-signals.js";
import { apiErrorLine, forwardDiagnostics, payloads, responseBlock, sentBlock, streamErrorLine } from "../_bridge-harness.js";

forwardDiagnostics();

const A = "a1d3a6ff025503d2d";
const B = "a951bb3b29f511aee";
const MODEL_REFUSED = (requestId: string) => `{"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-5-5"},"request_id":"${requestId}"}`;
const RATE_LIMITED = (requestId: string) => `{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"},"request_id":"${requestId}"}`;
const statusLine = (logId: string, requestId: string, status: number) =>
  `[Anthropic SDK INFO] [${logId}, request-id: "${requestId}"] post http://127.0.0.1:1/v1/messages?beta=true failed with status ${status} in 1ms - error; not retryable`;

function host(version = "2.1.306", recordBoundMs = 10) {
  let served = 0;
  const requests = hostedRequests({ sessionId: "host-session", silentVersions: silentVersions(), cliVersion: () => version, recordBoundMs, dispatcherServed: () => { served += 1; } });
  const read = debugLineReader((line) => { requests.read(line); });
  return { requests, served: () => served, write: (lines: readonly string[]) => { for (const line of lines) read(line); } };
}

const failureOf = (error: Error) => normalizeProviderAttemptFailure(classifyAnthropicError(error)).failure;

describe("the service requests of an agent host's engine", () => {
  test("interleaved requests of two agents each fail with their own answer: A's model refusal fails over, and B's rate limit keeps its retry delay from a status line that came before its response block", async () => {
    const { requests, write } = host();
    requests.admitted(A);
    requests.admitted(B);
    write([
      ...sentBlock("log_a", { agent: A }),
      ...sentBlock("log_b", { agent: B }),
      // B's status line arrives first; its response block follows after A's whole answer.
      statusLine("log_b", "req_b", 429),
      statusLine("log_a", "req_a", 404),
      ...responseBlock("error", 404, { "request-id": "req_a" }, "log_a"),
      ...responseBlock("error", 429, { "request-id": "req_b", "retry-after": "17" }, "log_b"),
      // Both await a body, so each body joins its record by its request id, not by order.
      apiErrorLine(429, RATE_LIMITED("req_b")),
      apiErrorLine(404, MODEL_REFUSED("req_a")),
    ]);
    const [a, b] = await Promise.all([requests.failure(A), requests.failure(B)]);

    expect(a).toBeInstanceOf(Anthropic.NotFoundError);
    expect(a).toMatchObject({ requestID: "req_a" });
    const refused = failureOf(a);
    expect(refused._tag).toBe("ModelAccessFailure");
    expect(isFailoverFailure(refused)).toBe(true);
    expect(b).toBeInstanceOf(Anthropic.RateLimitError);
    expect(failureOf(b)).toMatchObject({ _tag: "RateLimitFailure", retryAfterMs: 17_000 });
  });

  test("a 404 that the engine sends again without streaming keeps the first answer as the step's failure and counts the resend as one hidden request of that agent", async () => {
    const { requests, write } = host();
    requests.admitted(A);
    write([
      ...sentBlock("log_1", { agent: A }), ...responseBlock("error", 404, { "request-id": "req_1" }, "log_1"), apiErrorLine(404, MODEL_REFUSED("req_1")),
      ...sentBlock("log_2", { agent: A }), ...responseBlock("error", 404, { "request-id": "req_2" }, "log_2"), apiErrorLine(404, '{"type":"error","error":{"type":"not_found_error","message":"other"},"request_id":"req_2"}'),
    ]);

    expect(await requests.failure(A)).toMatchObject({ requestID: "req_1", message: expect.stringContaining("model: claude-opus-5-5") });
    expect(requests.takeHidden(A)).toEqual([{ source: "agent-host-agent" }]);
    expect(requests.takeHidden(A)).toEqual([]);
    expect(payloads("provider.claude_sdk.request.hidden")).toContainEqual({ sessionId: "host-session", agentId: A, tag: "unadmitted", phase: "hosted", announcedBy: "request-block" });
  });

  test("a log id that a complete record retired opens a new record, whose answer is its own", async () => {
    const { requests, write } = host();
    requests.admitted(A);
    write([...sentBlock("log_1", { agent: A }), ...responseBlock("error", 404, { "request-id": "req_1" }, "log_1"), apiErrorLine(404, MODEL_REFUSED("req_1"))]);
    expect(await requests.failure(A)).toMatchObject({ requestID: "req_1" });
    requests.admitted(A);
    write([...sentBlock("log_1", { agent: A }), ...responseBlock("error", 429, { "request-id": "req_9", "retry-after": "17" }, "log_1"), apiErrorLine(429, RATE_LIMITED("req_9"))]);

    expect(await requests.failure(A)).toMatchObject({ requestID: "req_9", status: 429 });
  });

  test("a step whose response began and then ended without its stop met an SSE error, which the engine reports without a key: it fails as a transient cut, recorded once per engine version", async () => {
    const { requests, write } = host("2.1.306-sse");
    requests.admitted(A);
    write([...sentBlock("log_1", { agent: A }), ...responseBlock("start", 200, { "request-id": "req_1" }, "log_1"), "2026-11-01T21:59:52.416Z [WARN] Mid-stream server error after 1 block(s) yielded — finalizing partial response"]);

    expect(await requests.failure(A)).toBeInstanceOf(LlmStreamError);
    expect(await requests.failure(A)).toBeInstanceOf(LlmStreamError);
    expect(payloads("provider.claude_sdk.host.stream_error.unattributed")).toEqual([{ sessionId: "host-session", agentId: A, cliVersion: "2.1.306-sse" }]);
    expect(payloads("provider.claude_sdk.debug_output.silent")).toEqual([]);
  });

  test("a step that ended without its stop before its success response block arrived still fails as a transient cut, and the version stays served", async () => {
    const { requests, write } = host("2.1.306-late");
    requests.admitted(A);
    write(sentBlock("log_1", { agent: A }));
    const failure = requests.failure(A);
    write(responseBlock("start", 200, { "request-id": "req_1" }, "log_1"));

    expect(await failure).toBeInstanceOf(LlmStreamError);
    expect(payloads("provider.claude_sdk.debug_output.silent")).toEqual([]);
  });

  test("a step whose request the service never answered, such as a connection that dropped before the response headers, fails as a transient cut and the version stays served; a response block that the reader cannot read still fails closed", async () => {
    const { requests, write } = host("2.1.306-unanswered");
    requests.admitted(A);
    write(sentBlock("log_1", { agent: A }));

    expect(await requests.failure(A)).toBeInstanceOf(LlmStreamError);
    expect(payloads("provider.claude_sdk.debug_output.silent")).toEqual([]);
    requests.admitted(A);
    write(sentBlock("log_2", { agent: A }));
    expect(await requests.failure(A)).toBeInstanceOf(LlmStreamError);

    const unread = host("2.1.996");
    unread.requests.admitted(A);
    unread.write([...sentBlock("log_1", { agent: A }), "[Anthropic SDK DEBUG] [log_1] response error (error; not retryable) {", "}"]);
    expect(await unread.requests.failure(A)).toBeInstanceOf(ProviderRequestValidationError);
    expect(payloads("provider.claude_sdk.debug_output.silent")).toEqual([{ sessionId: "host-session", cliVersion: "2.1.996", rule: "record-incomplete" }]);
  });

  test("a status line is partial evidence: a failure whose response block the reader cannot read never completes, so its body joins nothing and the step fails closed", async () => {
    const { requests, write } = host("2.1.997");
    requests.admitted(A);
    write([
      ...sentBlock("log_1", { agent: A }), statusLine("log_1", "req_1", 429),
      "[Anthropic SDK DEBUG] [log_1] response error (error; not retryable) {", "}",
      apiErrorLine(429, RATE_LIMITED("req_1")),
    ]);

    expect(await requests.failure(A)).toBeInstanceOf(ProviderRequestValidationError);
    expect(payloads("provider.claude_sdk.debug_output.silent")).toEqual([{ sessionId: "host-session", cliVersion: "2.1.997", rule: "body-unjoined" }]);
  });

  test("an error that the engine writes no body for fails with its status and request id, and a later body without a request id joins the newer request", async () => {
    const { requests, write } = host();
    requests.admitted(A);
    // The engine writes no body line for a 400 `dlp_request_denied` (CLI 2.1.306).
    write([...sentBlock("log_1", { agent: A }), ...responseBlock("error", 400, { "request-id": "req_dlp" }, "log_1")]);
    expect(await requests.failure(A)).toMatchObject({ status: 400, requestID: "req_dlp" });
    requests.admitted(A);
    // The dispatcher's request without a body stays behind its next request.
    write([
      ...sentBlock("log_d1"), ...responseBlock("error", 400, { "request-id": "req_d1" }, "log_d1"),
      ...sentBlock("log_d2"), ...sentBlock("log_2", { agent: A }),
      ...responseBlock("error", 502, {}, "log_2"), apiErrorLine(502, '{"type":"error","error":{"type":"api_error","message":"bad gateway"}}'),
    ]);

    expect(await requests.failure(A)).toMatchObject({ status: 502, message: expect.stringContaining("bad gateway") });
    expect(payloads("provider.claude_sdk.debug_output.silent")).toEqual([]);
  });

  test("the records of agents whose tasks ended and whose last transport was consumed retire: the engine keeps only the streams of agents that still run", () => {
    const { requests, write } = host();
    const finished = Array.from({ length: 50 }, (_, index) => `a${String(index).padStart(16, "0")}`);
    for (const agentId of [...finished, A, B]) {
      requests.admitted(agentId);
      write([...sentBlock(`log_${agentId}`, { agent: agentId }), ...responseBlock("start", 200, { "request-id": `req_${agentId}` }, `log_${agentId}`)]);
    }
    // Half of them end their task first and then release their transport, the other half the other way round.
    for (const [index, agentId] of finished.entries()) {
      if (index % 2 === 0) requests.retire(agentId);
      requests.released(agentId);
      if (index % 2 === 1) requests.retire(agentId);
    }
    // An agent whose task ended while its consumer still reads its stream keeps its record.
    requests.retire(B);
    // A stream error that names no request reports how many streams the engine's records hold open.
    write([streamErrorLine('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')]);

    expect(payloads("provider.claude_sdk.api_error.unattributed")).toEqual([{ sessionId: "host-session", signal: "stream-error", streaming: 2 }]);
  });

  test("a dispatcher request that the service refused and the engine sent again without streaming fails its frame with the first answer, and the frame's records state both requests, each once, with its status", async () => {
    const { requests, write } = host();
    requests.frameOpened("frame");
    write([
      ...sentBlock("log_d1"), ...responseBlock("error", 404, { "request-id": "req_1" }, "log_d1"), apiErrorLine(404, MODEL_REFUSED("req_1")),
      ...sentBlock("log_d2"), ...responseBlock("error", 404, { "request-id": "req_2" }, "log_d2"), apiErrorLine(404, '{"type":"error","error":{"type":"not_found_error","message":"other"},"request_id":"req_2"}'),
    ]);

    const failure = await requests.frameFailure("frame");
    if (failure === undefined) throw new Error("the frame has no failure");
    expect(failureOf(wireFailure(failure))._tag).toBe("ModelAccessFailure");
    expect(failure.body).toContain("model: claude-opus-5-5");
    expect(requests.takeHidden(A)).toEqual([{ source: "agent-host-dispatcher", status: 404 }, { source: "agent-host-dispatcher", status: 404 }]);
    expect(requests.takeHidden(A)).toEqual([]);
  });

  test("a dispatcher frame that succeeded states each request with its status and the input tokens of the response that answered it, a request that no frame asked for is still stated once, and each response is served when it ended: at the dispatcher's next ask or at the turn's success", () => {
    const { requests, write, served } = host();
    write([...sentBlock("log_early"), ...responseBlock("start", 200, { "request-id": "req_0" }, "log_early")]);
    requests.frameOpened("frame");
    write([...sentBlock("log_d1"), ...responseBlock("start", 200, { "request-id": "req_1" }, "log_d1")]);
    requests.dispatcherUsage("frame", 120);
    // The response's first blocks came, but it still streams.
    expect(served()).toBe(0);
    requests.dispatcherAsked("frame");
    expect(served()).toBe(1);
    write([...sentBlock("log_d2"), ...responseBlock("start", 200, { "request-id": "req_2" }, "log_d2")]);
    requests.dispatcherUsage("frame", 140);
    requests.frameEnded("frame");
    expect(served()).toBe(2);

    expect(requests.takeHidden(A)).toEqual([
      { source: "agent-host-dispatcher", status: 200 },
      { source: "agent-host-dispatcher", status: 200, inputTokens: 120 },
      { source: "agent-host-dispatcher", status: 200, inputTokens: 140 },
    ]);
  });

  test("a dispatcher response that an SSE error cut, or that a failed turn or the host's close ended, is not served", async () => {
    const { requests, write, served } = host();
    requests.frameOpened("cut");
    write([...sentBlock("log_d1"), ...responseBlock("start", 200, { "request-id": "req_1" }, "log_d1"), streamErrorLine('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')]);
    requests.dispatcherAsked("cut");
    requests.frameOpened("failed");
    write([...sentBlock("log_d2"), ...responseBlock("start", 200, { "request-id": "req_2" }, "log_d2")]);
    await requests.frameFailure("failed");
    requests.frameOpened("closed");
    write([...sentBlock("log_d3"), ...responseBlock("start", 200, { "request-id": "req_3" }, "log_d3")]);
    requests.close(new Error("closed"));

    expect(served()).toBe(0);
  });

  test("a dispatcher record stays the evidence of its request after its frame ended, until a transport record takes it: a response that came late states its status and input tokens, and each record of the frame then retires, also one that never got its headers and one that the engine wrote no body for", async () => {
    const { requests, write } = host();
    requests.frameOpened("late");
    write(sentBlock("log_d1"));
    requests.dispatcherUsage("late", 120);
    requests.frameEnded("late");
    write(responseBlock("start", 200, { "request-id": "req_1" }, "log_d1"));
    expect(requests.takeHidden(A)).toEqual([{ source: "agent-host-dispatcher", status: 200, inputTokens: 120 }]);

    requests.frameOpened("failed");
    write([...sentBlock("log_d2"), ...responseBlock("error", 400, { "request-id": "req_2" }, "log_d2"), ...sentBlock("log_d3")]);
    expect(await requests.frameFailure("failed")).toMatchObject({ status: 400, body: "" });
    expect(requests.takeHidden(A)).toEqual([{ source: "agent-host-dispatcher", status: 400 }, { source: "agent-host-dispatcher" }]);
    expect(requests.close(new Error("closed"))).toBe(0);

    // The retired records open no stream, so a later response of one and a stream error find none.
    write([...responseBlock("start", 200, { "request-id": "req_3" }, "log_d3"), ...responseBlock("start", 200, { "request-id": "req_1" }, "log_d1"), streamErrorLine('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')]);
    expect(payloads("provider.claude_sdk.api_error.unattributed")).toEqual([{ sessionId: "host-session", signal: "stream-error", streaming: 0 }]);
  });

  test("the host's close ends a frame failure's wait for its record at once", async () => {
    const { requests, write } = host("2.1.306", 60_000);
    requests.frameOpened("frame");
    write(sentBlock("log_d1"));
    const failure = requests.frameFailure("frame");
    requests.close(new Error("closed"));

    expect(await failure).toBeUndefined();
  });

  test("an agent whose step a person cancelled before its response headers came, and whose task then ended, keeps no record: its late response opens no stream", () => {
    const { requests, write } = host();
    requests.admitted(A);
    requests.admitted(B);
    write([...sentBlock("log_a", { agent: A }), ...sentBlock("log_b", { agent: B }), ...responseBlock("start", 200, { "request-id": "req_b" }, "log_b")]);
    requests.released(A);
    requests.retire(A);
    write([...responseBlock("start", 200, { "request-id": "req_a" }, "log_a"), streamErrorLine('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}')]);

    // Only B's stream is open, so the stream error is B's alone.
    expect(payloads("provider.claude_sdk.api_error.unattributed")).toEqual([]);
  });

  test("fails closed when the engine's output does not account for an agent's request: a hosted block without its agent header, or an error body that joins no record, fails the step as silent output, once per engine version", async () => {
    const { requests, write } = host("2.1.999");
    requests.admitted(A);
    write([...sentBlock("log_1"), ...responseBlock("error", 404, { "request-id": "req_1" }, "log_1"), apiErrorLine(404, MODEL_REFUSED("req_1"))]);
    const missing = await requests.failure(A);
    expect(missing).toBeInstanceOf(ProviderRequestValidationError);
    expect(missing.message).toContain("The Claude engine 2.1.999");

    const unjoined = host("2.1.998");
    unjoined.requests.admitted(A);
    unjoined.requests.admitted(B);
    unjoined.write([
      ...sentBlock("log_a", { agent: A }), ...sentBlock("log_b", { agent: B }),
      ...responseBlock("error", 404, {}, "log_a"), ...responseBlock("error", 404, {}, "log_b"),
      apiErrorLine(404, '{"type":"error","error":{"type":"not_found_error","message":"gone"}}'),
    ]);
    expect(await unjoined.requests.failure(A)).toBeInstanceOf(ProviderRequestValidationError);
    expect(payloads("provider.claude_sdk.debug_output.silent")).toEqual([
      { sessionId: "host-session", cliVersion: "2.1.999", rule: "agent-header-missing" },
      { sessionId: "host-session", cliVersion: "2.1.998", rule: "body-unjoined" },
    ]);
  });
});
