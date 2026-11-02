import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import Anthropic from "@anthropic-ai/sdk";
import type { SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { BetaRawMessageStreamEvent } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { ContextLengthExceededError, LlmStreamError, ModelAccessRefusedError, QuotaExhaustedError, StreamIdleTimeoutError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import type { QuotaExhaustionObservation } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js";
import { ProviderAuthenticationError } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { classifySdkMessage, cliFailure, cliResendFailure, readSdkMessages, type CliErrorReport, type CliTurnResult } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/sdk-events.js";
import type { WireFailure } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/service-requests.js";
import { assistantError, cliInit, cliOnlyMessage, ENVELOPE, event, rateLimitReport, turnError, turnResult, type CliRateLimitInfo } from "./_bridge-harness.js";

const turn = (overrides: Partial<CliTurnResult> = {}): CliTurnResult => ({ isError: true, status: null, terminalReason: undefined, text: "", userMessageUuid: undefined, ...overrides });
const OBSERVATION: QuotaExhaustionObservation = { exhaustion: { exhaustedAtMs: 1, resetsAtMs: 2_000 }, newlyExhausted: true, reportedResetAtMs: 2_000 };
/** The reset that each quota mark of `fail` named. */
const marks: (number | undefined)[] = [];
const fail = (report: CliErrorReport | undefined, result: CliTurnResult | undefined, wire?: WireFailure) => cliFailure(report, result, (resetsAtMs) => {
  marks.push(resetsAtMs);
  return OBSERVATION;
}, 2_000, wire);

describe("the SDK message classification", () => {
  test("separates the main stream's events from pings and subagent events", () => {
    const delta: BetaRawMessageStreamEvent = {
      type: "message_delta", context_management: null, delta: { stop_reason: "end_turn", stop_sequence: null, container: null, stop_details: null },
      usage: { output_tokens: 3, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, iterations: null, server_tool_use: null },
    };
    expect(classifySdkMessage(event(delta))).toEqual({ kind: "event", event: delta });
    expect(classifySdkMessage(cliOnlyMessage({ type: "stream_event", parent_tool_use_id: null, event: { type: "ping" } }))).toEqual({ kind: "ping" });
    expect(classifySdkMessage(event(delta, "toolu_1"))).toEqual({ kind: "ignored" });
  });

  test("reads the CLI's error report, turn result with the user message it answers, init, and rate limit", () => {
    const idle = "API Error: Stream idle timeout - no chunks received";
    expect(classifySdkMessage(assistantError("unknown", idle))).toEqual({ kind: "cli-error", report: { error: "unknown", text: "API Error: Stream idle timeout - no chunks received" } });
    expect(classifySdkMessage(assistantError(undefined, idle))).toEqual({ kind: "ignored" });
    expect(classifySdkMessage(turnResult({ is_error: true, api_error_status: 529, terminal_reason: "api_error", result: "Overloaded", user_message_uuid: "row-1" })))
      .toEqual({ kind: "turn-result", result: { isError: true, status: 529, terminalReason: "api_error", text: "Overloaded", userMessageUuid: "row-1" } });
    expect(classifySdkMessage(turnError({ subtype: "error_during_execution", terminal_reason: undefined, errors: ["one", "two"] })))
      .toEqual({ kind: "turn-result", result: { isError: true, status: null, terminalReason: undefined, text: "one\ntwo", userMessageUuid: undefined } });
    expect(classifySdkMessage(cliInit({ session_id: "s1", claude_code_version: "2.1.295", plugins: [{ name: "step-gate", path: "/plugins/gate", version: "1.0.0" }] })))
      .toEqual({ kind: "init", sessionId: "s1", cliVersion: "2.1.295", plugins: ["step-gate"], perTurnEffort: undefined });
    // CLI 2.1.296 states on its init whether it copies the effort onto the conversation's turns, and reports a change to false.
    expect(classifySdkMessage(cliInit({ session_id: "s1", claude_code_version: "2.1.296", plugins: [], per_turn_effort_active: true })))
      .toEqual({ kind: "init", sessionId: "s1", cliVersion: "2.1.296", plugins: [], perTurnEffort: true });
    expect(classifySdkMessage(cliOnlyMessage({ type: "system", subtype: "per_turn_effort_changed", per_turn_effort_active: false }))).toEqual({ kind: "per-turn-effort", active: false });
    expect(classifySdkMessage({ type: "system", subtype: "status", status: null, ...ENVELOPE })).toEqual({ kind: "ignored" });
    // A field that the classification does not read stays out of the info it hands on.
    const warning = { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9, resetsAt: 1, extra: true } as const;
    expect(classifySdkMessage(rateLimitReport(warning)))
      .toEqual({ kind: "rate-limit", info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.9, resetsAt: 1 }, billing: "included" });
  });

  test("reads the account's five-hour and seven-day windows that a rate-limit event carries, and skips a window it cannot read (CLI 2.1.295)", () => {
    const windows = (info: Omit<CliRateLimitInfo, "status">) => {
      const input = classifySdkMessage(rateLimitReport({ status: "allowed", ...info }));
      return input.kind === "rate-limit" ? input.windows : "not a report";
    };
    // `unifiedWindows` is the CLI's internal field: utilization is a fraction and the reset is in epoch seconds.
    expect(windows({ unifiedWindows: {
      five_hour: { utilization: 0.42, resetsAt: 1_800_000_000 }, seven_day: { utilization: 0.17, resetsAt: 1_800_500_000 },
      seven_day_overage_included: { utilization: 0.5, resetsAt: 1_800_500_000 },
    } })).toEqual({ fiveHour: { usedFraction: 0.42, resetsAtMs: 1_800_000_000_000 }, sevenDay: { usedFraction: 0.17, resetsAtMs: 1_800_500_000_000 } });
    // A window past its limit reads as full.
    expect(windows({ unifiedWindows: { five_hour: { utilization: 1.3, resetsAt: 1_800_000_000 }, seven_day: { utilization: "high", resetsAt: 1_800_500_000 } } }))
      .toEqual({ fiveHour: { usedFraction: 1, resetsAtMs: 1_800_000_000_000 } });
    expect(windows({ unifiedWindows: { seven_day: { utilization: 0.2 } } })).toBeUndefined();
    expect(windows({ unifiedWindows: {} })).toBeUndefined();
    expect(windows({ rateLimitType: "five_hour", utilization: 0.9, resetsAt: 1 })).toBeUndefined();
  });

  test("states from each rate-limit event whether the response before it spent included usage or extra usage (CLI 2.1.295)", () => {
    const billing = (info: SDKRateLimitInfo) => {
      const input = classifySdkMessage(rateLimitReport(info));
      return input.kind === "rate-limit" ? input.billing : undefined;
    };
    const window = { rateLimitType: "five_hour", resetsAt: 1_791_540_527 } as const;
    expect(billing({ status: "allowed", ...window, overageStatus: "allowed", isUsingOverage: false })).toBe("included");
    // A refusal at the limit, with extra usage off, served nothing.
    expect(billing({ status: "rejected", ...window, overageStatus: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false })).toBe("included");
    // The CLI sets isUsingOverage for a spent window whose overflow extra usage serves.
    expect(billing({ status: "rejected", ...window, overageStatus: "allowed", overageResetsAt: 1_793_261_328, isUsingOverage: true, overageInUse: true })).toBe("extra-usage");
    // The service's own overage-in-use header, also while the window still shows allowed.
    expect(billing({ status: "allowed", ...window, overageStatus: "allowed", isUsingOverage: false, overageInUse: true })).toBe("extra-usage");
    expect(billing({ status: "allowed", rateLimitType: "overage", resetsAt: 1 })).toBe("extra-usage");
    // A response without the service's usage headers names no window, so nothing shows which usage served it.
    expect(billing({ status: "allowed", isUsingOverage: false })).toBe("unconfirmed");
    // The engine's report of a 429 without those headers (CLI 2.1.296): the service refused the request, which spent nothing.
    expect(billing({ status: "rejected", isUsingOverage: false })).toBe("refused");
  });
});

describe("the error map", () => {
  test("raises the error that native Flywheel raises for each CLI failure", () => {
    const report = (error: CliErrorReport["error"], text: string): CliErrorReport => ({ error, text });

    const idle = fail(report("unknown", "API Error: Stream idle timeout - no chunks received"), undefined);
    expect(idle).toBeInstanceOf(StreamIdleTimeoutError);
    expect(idle).toMatchObject({ phase: "idle" });
    expect(fail(report("authentication_failed", "Invalid API key"), turn({ status: 401 }))).toBeInstanceOf(ProviderAuthenticationError);
    const spent = fail(report("rate_limit", "You've hit your session limit · resets 5pm"), turn({ status: 429 }));
    expect(spent).toBeInstanceOf(QuotaExhaustedError);
    expect(spent).toMatchObject({ quotaObservation: OBSERVATION });
    expect(fail(report("invalid_request", "Prompt is too long"), turn({ terminalReason: "blocking_limit", text: "Prompt is too long" }))).toBeInstanceOf(ContextLengthExceededError);
    expect(fail(undefined, turn({ terminalReason: "prompt_too_long" }))).toBeInstanceOf(ContextLengthExceededError);

    const overloaded = fail(report("overloaded", "API Error: 529 Overloaded"), turn({ status: 529 }));
    expect(overloaded).toBeInstanceOf(Anthropic.APIError);
    expect(overloaded).toMatchObject({ status: 529 });
    expect(fail(report("rate_limit", "API Error: 429 rate limited"), turn({ status: 429 }))).toBeInstanceOf(Anthropic.RateLimitError);

    // The CLI refuses an image above its own limit before it sends anything; the service refuses such an image natively.
    const image = fail(report("invalid_request", "API Error: image exceeds 5 MB maximum"), turn({ terminalReason: "image_error", text: "image exceeds 5 MB maximum" }));
    expect(image).toBeInstanceOf(Anthropic.BadRequestError);
    expect(image).toMatchObject({ status: 400, error: { type: "error", error: { type: "invalid_request_error" } } });

    // The engine's own end of a response without an event carries no status. It is the error that native's client
    // raises for the same response: the connection timeout after headers with no bytes, and the runtime's fetch
    // timeout after bytes with no event (CLI 2.1.296 beside the native adapter on a fake host).
    const connection = fail(report("unknown", "Request timed out"), turn({ text: "Request timed out" }));
    expect(connection).toBeInstanceOf(Anthropic.APIConnectionTimeoutError);
    expect(connection.message).toBe("Request timed out.");
    const fetchTimeout = fail(report("unknown", "API Error: The operation timed out."), turn({ text: "API Error: The operation timed out." }));
    expect(fetchTimeout).toBeInstanceOf(DOMException);
    expect(fetchTimeout).toMatchObject({ name: "TimeoutError", message: "The operation timed out." });
    const unknown = fail(report("server_error", "API Error: something else"), turn());
    expect(unknown).toBeInstanceOf(LlmStreamError);
    expect(unknown).toMatchObject({ kind: "transient" });
    expect(fail(undefined, undefined).message).toBe("The Claude CLI ended the request without a stop reason");
    // Only the spent allowance marks the account; a rate limit with time left in its window does not.
    expect(marks).toEqual([2_000]);
  });

  test("a failure for which the engine logged the service's response is the native error of that response, unless the engine reports the account's spent allowance", () => {
    const body = '{"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired"}}';
    const headers = new Headers({ "request-id": "req_1" });
    const expired = fail({ error: "authentication_failed", text: "Failed to authenticate. API Error: 401 OAuth token has expired · Please run /login" }, turn({ status: 401 }), { status: 401, body, headers });
    expect(expired).toBeInstanceOf(Anthropic.AuthenticationError);
    expect(expired).toMatchObject({ status: 401, message: `401 ${body}`, requestID: "req_1" });

    const limit = '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}}';
    const spent = fail({ error: "rate_limit", text: "You've hit your session limit · resets 5pm" }, turn({ status: 429 }), { status: 429, body: limit, headers });
    expect(spent).toBeInstanceOf(QuotaExhaustedError);
  });

  test("a login that the engine refuses before it sends a request names Flywheel's login command, not the engine's /login", () => {
    const refused = fail({ error: "authentication_failed", text: "Not logged in · Please run /login" }, turn({ terminalReason: "api_error" }));
    expect(refused).toBeInstanceOf(ProviderAuthenticationError);
    expect(refused.message).toBe("Not logged in. Run: flywheel auth login --claude-agent-sdk");
  });

  test("raises a refused model access, not a rate limit or a bad request, when the login does not grant the model or its 1M window", () => {
    const report = (error: CliErrorReport["error"], text: string): CliErrorReport => ({ error, text });
    // The CLI reports a long-context refusal as a 429 rate limit (CLI 2.1.295).
    const window = fail(report("rate_limit", "API Error: Usage credits required for 1M context · turn on usage credits at https://claude.ai/settings/usage"), turn({ status: 429 }));
    expect(window).toBeInstanceOf(ModelAccessRefusedError);
    expect(window).toMatchObject({ refusal: { kind: "extended-context", contextLimit: 200_000 } });
    const model = fail(report("model_not_found", "There's an issue with the selected model (claude-sonnet-4-5). It may not exist or you may not have access to it."), turn({ status: 404 }));
    expect(model).toBeInstanceOf(ModelAccessRefusedError);
    expect(model).toMatchObject({ refusal: { kind: "model" } });
  });

  test("fails a request that the CLI resent with a message that holds only the tag", () => {
    const badRequest = cliResendFailure({ tag: "thinking-signature", failure: "bad-request" });
    expect(badRequest).toBeInstanceOf(Anthropic.BadRequestError);
    expect(badRequest.message).toContain("(thinking-signature)");
    const transient = cliResendFailure({ tag: "dispatch", failure: "transient" });
    expect(transient).toBeInstanceOf(LlmStreamError);
    expect(transient).toMatchObject({ kind: "transient" });
  });

  test("the reader settles a replayed row's answer, hands on the rest, and ends with the stream's own failure", async () => {
    const settled: (string | undefined)[] = [];
    const inputs: string[] = [];
    let ended = false;
    async function* stream(): AsyncGenerator<SDKMessage> {
      yield turnResult({ api_error_status: null, terminal_reason: "completed", user_message_uuid: "replayed" });
      yield turnResult({ api_error_status: null, terminal_reason: "completed", user_message_uuid: "pushed" });
      throw new Error("engine process exited with code 1");
    }
    const acks = { settle: (uuid: string | undefined) => { settled.push(uuid); return uuid === "replayed"; }, end: () => { ended = true; } };

    const failure = await Effect.runPromise(readSdkMessages(stream(), acks, (input) => { inputs.push(input.kind); }));

    // The CLI's own failure, not a wrapper that names only the call that failed.
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toBe("Error: engine process exited with code 1");
    expect(settled).toEqual(["replayed", "pushed"]);
    expect(inputs).toEqual(["turn-result"]);
    expect(ended).toBe(true);
  });
});
