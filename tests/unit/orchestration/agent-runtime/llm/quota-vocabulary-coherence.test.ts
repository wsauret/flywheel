/**
 * Holds the two quota vocabularies together: every message shape
 * `classifyQuotaError` reads as a terminal exhaustion must render as the
 * out-of-credits copy in `classifyApiError`, never as a rate limit. The two
 * regexes live in different layers (the chain's classifier decides failover;
 * the copy authority decides the notice), so drift between them shows a user
 * wait-and-retry guidance for a condition waiting cannot fix.
 */

import { describe, expect, test } from "bun:test";
import { classifyApiError } from "../../../../../src/infra/llm/provider-error-copy.js";
import { classifyQuotaError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";

/** One message per pattern arm of the classifier, phrased the way the
 *  providers actually phrase them. */
const TERMINAL_QUOTA_MESSAGES: ReadonlyArray<{ status: number | undefined; message: string; code?: string }> = [
  { status: 402, message: "402 Payment Required" },
  { status: 429, message: "You have hit your usage limit." },
  { status: 429, message: "insufficient_quota: You exceeded your current quota." },
  { status: 429, message: "Agent run failed: you are out of budget." },
  { status: 429, message: "quota_exceeded for this billing account" },
  { status: 429, message: "You have exhausted your premium request allowance." },
  { status: 400, message: "Your credit balance is too low to access the API." },
  { status: 429, message: "You exceeded your current quota. Add credits.", code: "insufficient_quota" },
  { status: undefined, message: "You exceeded your current quota. Add credits.", code: "insufficient_quota" },
];

describe("quota vocabulary coherence", () => {
  for (const { status, message, code } of TERMINAL_QUOTA_MESSAGES) {
    test(`terminal for the chain renders as out-of-credits copy: "${message}"`, () => {
      const cause = Object.assign(new Error(message), { code });
      expect(classifyQuotaError(status, message, cause)).toMatchObject({ cause });
      expect(classifyApiError(message).title).toBe("Out of credits");
    });
  }

  test("a plain rate limit stays with the wait-and-retry copy and never reads as terminal", () => {
    const message = "429 Too Many Requests: please slow down";
    expect(classifyQuotaError(429, message, undefined)).toBeUndefined();
    expect(classifyApiError(message).title).toBe("Rate limited");
  });
});
