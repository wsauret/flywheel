import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { errorDetail } from "../../../../../../src/infra/error-message.js";
import { summarizeProviderError } from "../../../../../../src/infra/llm/errors/provider-error-diagnostic.js";
import { Log } from "../../../../../../src/infra/diagnostics/log.js";
import { classifyProviderFailure, type ProviderFailure } from "../../../../../../src/orchestration/agent-runtime/llm/stream/provider-failure.js";
import { AcpRequestError } from "../../../../../../src/orchestration/modules/provider-google-antigravity/acp/connection.js";
import {
  AccountVerificationRequiredError,
  acpRequestFailure,
  engineFailure,
  engineNoticeDetail,
} from "../../../../../../src/orchestration/modules/provider-google-antigravity/acp/errors.js";

const warn = spyOn(Log.create({ service: "provider-google-antigravity" }), "warn").mockImplementation(() => {});
beforeEach(() => warn.mockClear());

/** The failure the walk sees for one agy notice chunk, as agy 1.5.14 sent it. */
function noticeFailure(chunk: string) {
  const detail = engineNoticeDetail(chunk);
  if (detail === undefined) throw new Error("not a notice");
  return classifyProviderFailure(engineFailure(detail));
}

describe("engineFailure", () => {
  // Notice chunks recorded from agy 1.5.14 against the fake Gemini host and on a live login.
  const notices: ReadonlyArray<readonly [string, ProviderFailure["_tag"], string]> = [
    ["429 without details", "RateLimitFailure", "\n⚠ agent executor error: generating and executing: Error 429, Message: scripted 429, Status: RESOURCE_EXHAUSTED, Details: []\n"],
    ["429 for a per-day quota", "QuotaExhaustedFailure", "\n⚠ agent executor error: generating and executing: Error 429, Message: Quota exceeded for quota metric 'Generate Content API requests per day', Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.QuotaFailure violations:[map[quotaId:GenerateRequestsPerDayPerProjectPerModel quotaMetric:generativelanguage.googleapis.com/generate_content_requests_per_day]]]]\n"],
    ["500", "OverloadedFailure", "\n⚠ agent executor error: generating and executing: Error 500, Message: scripted 500, Status: INTERNAL, Details: []\n"],
    ["a system text too large for the model", "ContextOverflowFailure", "\n⚠ agent executor error: generating and executing: serializing trajectory: maxMessageTokens must be positive, got 0\n"],
    ["account verification", "AuthFailure", "\n⚠ Verification Required\n"],
  ];
  test.each(notices)("a notice of %s fails as %s", (_name, tag, chunk) => {
    expect(noticeFailure(chunk)._tag).toBe(tag);
    expect(warn).not.toHaveBeenCalled();
  });

  test("account verification is a typed account action", () => {
    expect(engineFailure("Verification Required")).toBeInstanceOf(AccountVerificationRequiredError);
    expect(engineFailure("generating and executing: PERMISSION_DENIED (code 403): Verify your account to continue.")).toBeInstanceOf(AccountVerificationRequiredError);
  });

  test("a retry line of agy's log fails as the response it names, with Google's retry delay", () => {
    const overloaded = classifyProviderFailure(engineFailure("Run: attempt 1 failed (Error 503, Message: The model is overloaded., Status: UNAVAILABLE, Details: []), retrying in 4s"));
    expect(overloaded._tag).toBe("OverloadedFailure");
    const throttled = classifyProviderFailure(engineFailure("Run: attempt 1 failed (Error 429, Message: scripted 429, Status: RESOURCE_EXHAUSTED, Details: [map[@type:type.googleapis.com/google.rpc.RetryInfo retryDelay:12s]]), retrying in 13s"));
    expect(throttled).toMatchObject({ _tag: "RateLimitFailure", retryAfterMs: 12_000 });
  });

  const SENTINEL = "SENTINEL-7f3a";
  const unknownTexts: ReadonlyArray<readonly [string, string]> = [
    ["plain text", `failed to construct executor: ${SENTINEL}`],
    ["a Gemini API error of a status that no rule names", `generating and executing: Error 418, Message: ${SENTINEL}, Status: UNKNOWN, Details: []`],
  ];
  test.each(unknownTexts)("an unknown text of %s fails as a provider failure whose error and record hold none of it", (_name, detail) => {
    const error = engineFailure(detail);
    expect(classifyProviderFailure(error)._tag).toBe("UnknownProviderFailure");
    expect(JSON.stringify([summarizeProviderError(error), errorDetail(error)])).not.toContain(SENTINEL);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({ sha256: createHash("sha256").update(detail).digest("hex"), bytes: Buffer.byteLength(detail) });
  });
});

describe("engineNoticeDetail", () => {
  test("model text is no notice", () => {
    expect(engineNoticeDetail("The answer is 4.")).toBeUndefined();
    expect(engineNoticeDetail("⚠ careful")).toBeUndefined();
  });
});

describe("acpRequestFailure", () => {
  test("Authentication required is a login refusal that names Flywheel's login command", () => {
    const error = acpRequestFailure(new AcpRequestError("session/new", { code: -32000, message: "Authentication required" }));
    expect(classifyProviderFailure(error)._tag).toBe("AuthFailure");
    expect(error.message).toContain("flywheel auth login --google-antigravity");
  });
});
