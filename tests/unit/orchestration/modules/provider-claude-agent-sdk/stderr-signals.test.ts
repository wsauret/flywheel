import { describe, expect, spyOn, test } from "bun:test";
import { announcedRequest, apiErrorLine, classifyStderrLine, debugLineReader, signInTrace, type DebugLine } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/stderr-signals.js";

const warn = (message: string) => `2026-10-07T12:00:00.000Z [WARN] ${message}`;

describe("the CLI stderr signals", () => {
  test("times sign-in observations from engine creation, not from the debug line's timestamp", () => {
    const now = spyOn(performance, "now").mockReturnValue(1_000);
    try {
      const trace = signInTrace();
      now.mockReturnValue(1_075);
      trace.read(warn("[keychain] read failed; serving stale cache"));
      expect(trace.snapshot()).toEqual({ signals: [{ kind: "keychain-read-failed-stale", sinceStartMs: 75 }], omitted: 0 });
    } finally {
      now.mockRestore();
    }
  });

  test("keeps only closed sign-in kinds, never the debug message or its variable values", () => {
    const now = spyOn(performance, "now").mockReturnValue(0);
    const trace = signInTrace();
    now.mockRestore();
    for (const line of [
      "2026-10-15T00:28:13.676Z [ERROR] API error (attempt 1/11): Could not resolve authentication method. private detail",
      "2026-10-15T00:28:13.677Z [WARN] [keychain] read failed; serving stale cache",
      "2026-10-15T00:28:13.678Z [WARN] [keychain] readAsync failed; not caching a null",
      "2026-10-15T00:28:13.679Z [ERROR] OAuth refresh failed (expected): secret-value",
      "2026-10-15T00:28:13.680Z [ERROR] OAuth refresh lock compromised: secret-value",
      "2026-10-15T00:28:13.681Z [ERROR] OAuth refresh lock release failed: secret-value",
      "2026-10-15T00:28:13.682Z [ERROR] SDK getOAuthToken callback failed: secret-value",
      "2026-10-15T00:28:13.683Z [WARN] Existing sign-in check failed: secret-value",
      "2026-10-15T00:28:13.684Z [DEBUG] unrelated secret-value",
    ]) trace.read(line);
    const { signals, omitted } = trace.snapshot();
    expect(omitted).toBe(0);
    expect(signals.map((signal) => signal.kind)).toEqual([
      "authentication-unresolved", "keychain-read-failed-stale", "keychain-async-read-failed", "refresh-failed",
      "refresh-lock-compromised", "refresh-lock-release-failed", "oauth-callback-failed", "existing-sign-in-check-failed",
    ]);
    expect(JSON.stringify(signals)).not.toContain("secret-value");
    expect(JSON.stringify(signals)).not.toContain("private detail");
  });

  test("names each silent retry path of CLI 2.1.293 to 2.1.296", () => {
    const lines: [string, string, "bad-request" | "transient"][] = [
      ["[server-fallback] 400 attributed to the fast mode beta, retrying without it", "server-fallback", "bad-request"],
      ["[thinking] server rejected a thinking block signature, retrying with thinking stripped", "thinking-signature", "bad-request"],
      ["[thinking] model rejected thinking.type=adaptive, retrying with enabled", "thinking-type", "bad-request"],
      ["[dispatch] connection reset before the first byte, retrying once", "dispatch", "transient"],
      ["[server-classifier] the request classifier failed, retrying once", "server-classifier", "bad-request"],
      ["[reminders] the API rejected clear_at, retrying without it", "reminders-clear-at", "bad-request"],
      ["[mid-conv-system] the model rejected a mid-conversation system message, resending", "mid-conv-system", "bad-request"],
      ["[per-turn-control] the API rejected the control block, resending without it", "per-turn-control", "bad-request"],
      ["[effort] the model rejected output_config.effort, retrying without it", "effort", "bad-request"],
      ["[structured-outputs] the model rejected output_config.format, retrying without it", "structured-outputs", "bad-request"],
      ["[thinking-token-count] the count request failed, retrying", "thinking-token-count", "bad-request"],
      ["Removed unprocessable image at messages.2.content.1.tool_result.content.0; retrying.", "media-strip", "bad-request"],
      ["Removed base64 image blocks from carrier 3 (API 400 had no usable path); retrying.", "media-strip", "bad-request"],
      // CLI 2.1.296 resends a 400 once without the 1M context beta header.
      ["[betas] an HTTP 400 reads as the backend rejecting context-1m-2025-08-07; resending once without it", "betas", "bad-request"],
      ['[betas] an HTTP 400 says "invalid beta flag", which may be about context-1m-2025-08-07; resending once without it', "betas", "bad-request"],
    ];
    for (const [message, tag, failure] of lines) expect(classifyStderrLine(warn(message)), tag).toEqual({ tag, failure });
  });

  test("fails closed on a warn line that names a retry the table does not know", () => {
    expect(classifyStderrLine(warn("[new-path] the API rejected the request, resending"))).toEqual({ tag: "unrecognized", failure: "transient" });
    expect(classifyStderrLine(warn("[cache] Retried the write"))).toEqual({ tag: "unrecognized", failure: "transient" });
  });

  test("ignores other levels and warn lines that name no retry", () => {
    expect(classifyStderrLine("2026-10-07T12:00:00.000Z [DEBUG] [dispatch] retrying once")).toBeUndefined();
    expect(classifyStderrLine("2026-10-07T12:00:00.000Z [ERROR] [server-fallback] 400 attributed, retrying")).toBeUndefined();
    expect(classifyStderrLine(warn("[config] the settings file has an unknown key"))).toBeUndefined();
    expect(classifyStderrLine("plain output with retrying in it")).toBeUndefined();
  });

  test("reads the status, the raw response body, and the body's request id of each HTTP error that the CLI logs", () => {
    const body = '{"type":"error","error":{"type":"invalid_request_error","message":"messages.2.content.0: bad"}}';
    // The CLI writes the status, then the Anthropic SDK error's message, which repeats the status.
    expect(apiErrorLine(`2026-10-08T12:00:00.000Z [ERROR] API error (attempt 1/1): 400 400 ${body}`)).toEqual({ status: 400, body, requestId: undefined });
    // The service names the request id in the body, equal to its `request-id` header (CLI 2.1.306).
    const named = '{"type":"error","error":{"type":"not_found_error","message":"model: claude-opus-5-5"},"request_id":"req_2"}';
    expect(apiErrorLine(`2026-11-01T21:59:47.152Z [ERROR] API error (attempt 1/1): 404 404 ${named}`)).toEqual({ status: 404, body: named, requestId: "req_2" });
    expect(apiErrorLine("2026-10-08T12:00:00.000Z [ERROR] API error (attempt 2/3): 529 529 Overloaded")).toEqual({ status: 529, body: "Overloaded", requestId: undefined });
    expect(apiErrorLine("2026-10-08T12:00:00.000Z [ERROR] API error (attempt 1/1): Connection error.")).toBeUndefined();
    expect(apiErrorLine(`2026-10-08T12:00:00.000Z [ERROR] Error in API request: 400 ${body}`)).toBeUndefined();
    expect(apiErrorLine(`2026-10-08T12:00:00.000Z [WARN] API error (attempt 1/1): 400 400 ${body}`)).toBeUndefined();
  });

  test("reads each debug line that announces a request: whether it goes to the model endpoint, and its caller only by a short kind", () => {
    const line = (rest: string) => `2026-10-07T12:00:00.000Z [DEBUG] [API REQUEST] ${rest}`;
    expect(announcedRequest(line("/v1/messages source=sdk"))).toEqual({ model: true, source: "sdk" });
    expect(announcedRequest(line("/v1/messages x-client-request-id=ff4e7f9b-9a42-4c25-bcee-30758680b41c source=sdk"))).toEqual({ model: true, source: "sdk" });
    expect(announcedRequest(line("/v1/messages source=repl_main_thread:compact"))).toEqual({ model: true, source: "repl_main_thread:compact" });
    expect(announcedRequest(line("/v1/messages"))).toEqual({ model: true, source: "none" });
    expect(announcedRequest(line("/v1/messages source=agent:explorer querySource=x"))).toEqual({ model: true, source: "agent:explorer" });
    expect(announcedRequest(line("/v1/messages source=/a/path/with?text"))).toEqual({ model: true, source: "unknown" });
    // A request to another endpoint can also fail with an HTTP error line, so it is announced too.
    expect(announcedRequest(line("/v1/messages/count_tokens source=sdk"))).toEqual({ model: false, source: "sdk" });
    expect(announcedRequest(warn("[API REQUEST] gzip request body rejected (rollout=api status=400 kind=decode); re-sent uncompressed"))).toBeUndefined();
    expect(announcedRequest("[API REQUEST] /v1/messages source=sdk")).toBeUndefined();
  });

  test("reads the log id, the status, and the retry, request-id, and unified-limit headers of each response that the engine's Anthropic client logs at ANTHROPIC_LOG=debug", () => {
    // The `response error` block of a 429 and the `response start` block of a stream, as CLI 2.1.296 writes them.
    const read = readAll([
      "[Anthropic SDK DEBUG] [log_74b933] response error (error; no more retries left) {",
      '  url: "http://127.0.0.1:59010/v1/messages?beta=true",',
      "  status: 429,",
      "  headers: {",
      '    "content-length": "158",',
      '    date: "Fri, 09 Oct 2026 22:45:57 GMT",',
      '    "request-id": "req_011CT",',
      '    "retry-after": "17",',
      '    "retry-after-ms": "16500",',
      '    "x-should-retry": "true",',
      '    "anthropic-ratelimit-unified-status": "rejected",',
      '    "anthropic-ratelimit-unified-5h-utilization": "1.02",',
      "  },",
      "  message: undefined,",
      "  durationMs: 2,",
      "}",
      "[Anthropic SDK DEBUG] [log_fba7f7] response start {",
      '  url: "http://127.0.0.1:59080/v1/messages?beta=true",',
      "  status: 200,",
      "  headers: {",
      '    "content-type": "text/event-stream",',
      '    "request-id": "req_011CU",',
      "  },",
      "  durationMs: 2,",
      "}",
    ]);
    expect(read.map(responseOf)).toEqual([
      { logId: "log_74b933", status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected", "request-id": "req_011CT", "retry-after": "17", "retry-after-ms": "16500", "x-should-retry": "true" } },
      { logId: "log_fba7f7", status: 200, headers: { "request-id": "req_011CU" } },
    ]);
  });

  test("reads the log id, the path, the model, the sent body fields, the exact beta header, and the hosted agent of each request that the engine's Anthropic client logs, and no other header", () => {
    // The `sending request` block as CLI 2.1.296 writes it: the messages show as [Array ...] and the authorization as ***.
    expect(readAll([
      "[Anthropic SDK DEBUG] [log_6f9c8d] sending request {",
      '  method: "POST",',
      '  url: "http://127.0.0.1:61641/v1/messages?beta=true",',
      "  options: {",
      '    method: "post",',
      '    path: "/v1/messages?beta=true",',
      "    body: {",
      '      model: "claude-sonnet-5-5",',
      "      messages: [Array ...],",
      "      system: [Array ...],",
      "      tool_choice: undefined,",
      "      metadata: [Object ...],",
      "      max_tokens: 32000,",
      "      context_management: [Object ...],",
      "      stream: true,",
      "    },",
      "    timeout: 600000,",
      "    signal: AbortSignal {",
      "      aborted: false,",
      "    },",
      "  },",
      "  headers: {",
      '    "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,effort-2025-11-24",',
      '    authorization: "***",',
      '    "x-claude-code-agent-id": "a1d3a6ff025503d2d",',
      '    "x-claude-code-session-id": "9d3b72e1",',
      "  },",
      "}",
    ])).toEqual([{ kind: "request-sent", logId: "log_6f9c8d", agent: "a1d3a6ff025503d2d", request: {
      path: "/v1/messages", model: "claude-sonnet-5-5", fields: ["model", "messages", "system", "metadata", "max_tokens", "context_management", "stream"],
      betas: ["claude-code-20250219", "oauth-2025-04-20", "effort-2025-11-24"],
    } }]);
  });

  test("a request block without a path ends as unread, and one without a beta header states none", () => {
    expect(readAll([
      "[Anthropic SDK DEBUG] [log_1] sending request {",
      "  headers: {",
      '    authorization: "***",',
      "  },",
      "}",
      "[Anthropic SDK DEBUG] [log_2] sending request {",
      "  options: {",
      '    path: "/v1/messages/count_tokens?beta=true",',
      "  },",
      "}",
    ])).toEqual([{ kind: "request-unread", logId: "log_1" }, { kind: "request-sent", logId: "log_2", agent: undefined, request: { path: "/v1/messages/count_tokens", model: undefined, fields: [], betas: undefined } }]);
  });

  test("a response block without a status ends as unread, and a line that interrupts a block still reads as itself", () => {
    const body = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    expect(readAll([
      "[Anthropic SDK DEBUG] [log_1] response error (error; not retryable) {",
      '  headers: { "request-id": "req_1" },',
      "}",
      "[Anthropic SDK DEBUG] [log_2] response error (error; not retryable) {",
      "  status: 529,",
      `2026-10-09T12:00:00.000Z [ERROR] API error (attempt 1/1): 529 529 ${body}`,
    ])).toEqual([{ kind: "response-unread", logId: "log_1" }, { kind: "response-unread", logId: "log_2" }, { kind: "api-error", response: { status: 529, body, requestId: undefined } }]);
  });

  test("reads the log id, the request id, and the status of the line that the engine's Anthropic client writes when a response arrives", () => {
    expect(readAll([
      '[Anthropic SDK INFO] [log_a1e217, request-id: "req_fake_2"] post http://127.0.0.1:54411/v1/messages?beta=true failed with status 404 in 1ms - error; not retryable',
      "[Anthropic SDK INFO] [log_22e3b4] post http://127.0.0.1:54500/v1/messages?beta=true succeeded with status 200 in 3ms",
    ])).toEqual([
      { kind: "status-line", logId: "log_a1e217", status: 404, requestId: "req_fake_2" },
      { kind: "status-line", logId: "log_22e3b4", status: 200, requestId: undefined },
    ]);
  });

  test("reads the SSE error event that ended a stream, which the engine logs with its fallback off", () => {
    const body = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    expect(readAll([`2026-10-09T22:46:03.294Z [ERROR] Error streaming (non-streaming fallback disabled): ${body}`])).toEqual([{ kind: "stream-error", body }]);
    expect(readAll([`2026-10-09T22:46:03.294Z [ERROR] Error in API request: ${body}`])).toEqual([]);
  });
});

/** Every signal that one reader takes from `lines`, in order. */
function readAll(lines: readonly string[]): DebugLine[] {
  const read: DebugLine[] = [];
  const reader = debugLineReader((line) => { read.push(line); });
  for (const line of lines) reader(line);
  return read;
}

function responseOf(line: DebugLine) {
  return line.kind === "response" ? { logId: line.logId, status: line.response.status, headers: Object.fromEntries(line.response.headers) } : line;
}
