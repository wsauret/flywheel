import { describe, expect, it } from "bun:test";
import { Redacted } from "effect";
import { extractAccountId } from "../../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/request.js";
import { JWT_CLAIM_PATH } from "../../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/types.js";

function makeJwt(payload: unknown): string {
  const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.signature`;
}

describe("extractAccountId", () => {
  it("extracts the chatgpt_account_id claim from a well-formed token", () => {
    const token = makeJwt({ [JWT_CLAIM_PATH]: { chatgpt_account_id: "acct-123" } });
    expect(extractAccountId(Redacted.make(token))).toBe("acct-123");
  });

  it("rejects a token that is not three dot-delimited segments", () => {
    expect(() => extractAccountId(Redacted.make("not.a.jwt.token"))).toThrow("Failed to extract accountId from token");
  });

  it("preserves the underlying base64/JSON parse reason for a malformed payload", () => {
    // Valid 3-segment shape, but the middle segment is not valid base64 JSON.
    let captured: unknown;
    try {
      extractAccountId(Redacted.make("header.!!!not-base64!!!.signature"));
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(Error);
    if (!(captured instanceof Error)) throw new Error("expected Error");
    const error = captured;
    // The generic prefix is kept, but the real cause is appended (not collapsed away).
    expect(error.message).toContain("Failed to extract accountId from token:");
    expect(error.message.length).toBeGreaterThan("Failed to extract accountId from token: ".length);
    expect(error.cause).toBeDefined();
  });

  it("throws when the token lacks the account id claim", () => {
    const token = makeJwt({ [JWT_CLAIM_PATH]: {} });
    expect(() => extractAccountId(Redacted.make(token))).toThrow("No account ID in token");
  });
});
