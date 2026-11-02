import { describe, expect, test } from "bun:test";
import { InvariantViolation } from "../../../../src/infra/invariant";
import { classifyError, type ErrorType, WorkerFailedError } from "../../../../src/workflows/context-bundle/error-classifier";
import { HandoffInvalidError, HandoffNotProducedError } from "../../../../src/workflows/context-bundle/handoff-errors";
import { PersistenceWriteRefused } from "../../../../src/infra/event-store-types.js";

describe("classifyError", () => {
  const cases: Array<[string, unknown, ErrorType]> = [
    ["local persistence refusal", new PersistenceWriteRefused(129, 128), "fatal"],
    ["local persistence refusal with workflow summary copy", new Error("local persistence failure", { cause: new PersistenceWriteRefused(129, 128, "publication") }), "fatal"],
    // Fatal — message patterns
    ["unauthorized message", new Error("Request unauthorized"), "fatal"],
    ["forbidden message", new Error("Access forbidden"), "fatal"],
    ["invalid api key", new Error("Invalid API key provided"), "fatal"],
    ["invalid x-api-key", new Error("Invalid x-api-key header"), "fatal"],
    ["authentication failed", new Error("Authentication failed for user"), "fatal"],
    ["permission denied", new Error("Permission denied: write access"), "fatal"],
    ["credit exhaustion", new Error("Insufficient credit balance"), "fatal"],
    ["billing issue", new Error("Billing account suspended"), "fatal"],
    ["quota exceeded", new Error("API quota exceeded for project"), "fatal"],

    // Fatal — status codes
    ["status 401", Object.assign(new Error("unauthorized"), { status: 401 }), "fatal"],
    ["status 403", Object.assign(new Error("forbidden"), { status: 403 }), "fatal"],

    // Transient — message patterns
    ["timeout", new Error("Request timeout after 30s"), "transient"],
    ["timed out", new Error("Connection timed out"), "transient"],
    ["etimedout", new Error("connect ETIMEDOUT 1.2.3.4:443"), "transient"],
    ["econnrefused", new Error("connect ECONNREFUSED 127.0.0.1:3000"), "transient"],
    ["econnreset", new Error("read ECONNRESET"), "transient"],
    ["enotfound", new Error("getaddrinfo ENOTFOUND api.example.com"), "transient"],
    ["epipe", new Error("write EPIPE"), "transient"],
    ["socket hang up", new Error("socket hang up"), "transient"],
    ["rate limit", new Error("Rate limit exceeded"), "transient"],
    ["rate_limit", new Error("error type: rate_limit_error"), "transient"],
    ["too many requests", new Error("Too many requests"), "transient"],
    ["overloaded", new Error("API is overloaded"), "transient"],
    ["service unavailable", new Error("Service unavailable"), "transient"],
    ["bad gateway", new Error("Bad gateway"), "transient"],

    // Transient — status codes
    ["status 408", Object.assign(new Error("request timeout"), { status: 408 }), "transient"],
    ["status 429", Object.assign(new Error("slow down"), { status: 429 }), "transient"],
    ["status 502", Object.assign(new Error("bad gateway"), { status: 502 }), "transient"],
    ["status 503", Object.assign(new Error("service unavailable"), { status: 503 }), "transient"],
    ["status 529", Object.assign(new Error("overloaded"), { status: 529 }), "transient"],

    // Unknown
    ["generic error", new Error("Something went wrong"), "unknown"],
    ["worker crash", new Error("Worker crashed on step: step-1"), "unknown"],
    ["null handoff", new Error("Worker completed without a handoff path"), "unknown"],
    ["non-error value", "just a string", "unknown"],

    // Invariant — internal contract violations
    [
      "InvariantViolation",
      new InvariantViolation({
        kind: "schema-mismatch",
        eventType: "handoff.validated",
        eventPosition: 42,
        aggregateId: "step-1",
        detail: "missing field summary",
      }),
      "invariant",
    ],
    ["HandoffNotProducedError", new HandoffNotProducedError("step-1"), "handoff"],
    ["HandoffInvalidError", new HandoffInvalidError("step-1", "missing field"), "handoff"],

    // WorkerFailedError — typed terminal kind wins over message heuristics
    ["worker transient_disconnect (recovery exhaustion)", new WorkerFailedError("transient_disconnect", "Persistent connection failure after 10 recovery attempts: boom", "boom"), "transient"],
    ["worker api_overloaded", new WorkerFailedError("api_overloaded", "provider said no", "provider said no"), "transient"],
    ["worker input_closed", new WorkerFailedError("input_closed", "Worker input source closed mid-run", "Worker input source closed mid-run"), "invariant"],
    ["worker budget_exhausted", new WorkerFailedError("budget_exhausted", "LLM-call budget exhausted before the step completed", "LLM-call budget exhausted before the step completed"), "fatal"],
    ["worker interrupted", new WorkerFailedError("interrupted", "Interrupted before the step completed", "Interrupted before the step completed"), "unknown"],
    ["worker aborted", new WorkerFailedError("aborted", "Aborted", "Aborted"), "unknown"],

    // WorkerFailedError — provider-boundary kinds defer to heuristics on the
    // RAW detail, not the humanized display message
    ["worker api_error with auth detail", new WorkerFailedError("api_error", "Authentication failed: the OpenAI API key was rejected.", "401 invalid api key"), "fatal"],
    ["worker api_error with rate-limit detail", new WorkerFailedError("api_error", "The model provider is rate-limiting requests (temporary throttling, not your quota or credits). Wait a moment and resend, or switch models with /models if it keeps happening.", "429 Rate limit exceeded"), "transient"],
    ["worker api_error with opaque detail", new WorkerFailedError("api_error", "Model request failed: provider exploded", "provider exploded"), "unknown"],
    ["worker output_overflow", new WorkerFailedError("output_overflow", "Output overflow", "Output overflow"), "unknown"],

    // Status code takes precedence over message
    ["fatal status overrides transient message", Object.assign(new Error("timeout"), { status: 401 }), "fatal"],
  ];

  for (const [label, error, expected] of cases) {
    test(label, () => {
      expect(classifyError(error)).toBe(expected);
    });
  }

  test("fatal patterns checked before transient patterns", () => {
    const error = new Error("unauthorized rate limit");
    expect(classifyError(error)).toBe("fatal");
  });
});