import { describe, expect, it } from "bun:test";
import { boundProviderDetail, classifyApiError, exhaustedProvidersCopy, exhaustedProvidersRecovery, extractProviderErrorDetail, providerErrorProse } from "../../../../src/infra/llm/provider-error-copy.js";

describe("classifyApiError", () => {
  it("delegates auth failures to the auth copy with a /auth action", () => {
    const copy = classifyApiError("401 Incorrect API key provided by OpenAI");
    expect(copy.title).toBe("Authentication failed");
    expect(copy.message).toContain("configuration problem");
    expect(copy.action).toEqual({ label: "Manage credentials", command: "/auth" });
  });

  it("classifies credit exhaustion as billing, not rate limiting, even on a 429", () => {
    const raw = '429 {"type":"error","error":{"type":"rate_limit_error","message":"Your credit balance is too low to access the API."}}';
    const copy = classifyApiError(raw);
    expect(copy.title).toBe("Out of credits");
    expect(copy.guidance).toContain("/model");
    expect(copy.detail).toBe("Your credit balance is too low to access the API.");
    expect(copy.message).not.toContain("rate-limiting");
    expect(copy.action).toEqual({ label: "Switch models", command: "/model" });
  });

  it.each(["insufficient_quota", "You exceeded your current quota", "monthly spend limit reached", "usage limit reached"])(
    "recognizes billing/quota exhaustion in %p",
    (raw) => { expect(classifyApiError(raw).title).toBe("Out of credits"); },
  );

  it("renders the chain's all-candidates-exhausted error with the reset localized", () => {
    const resetsAt = new Date("2026-08-01T07:00:00.000Z");
    const copy = classifyApiError(
      `No access provider can run "gpt-5.5" right now. ChatGPT: The ChatGPT usage limit for this window is reached. Capacity returns at ${resetsAt.toISOString()}.`,
    );
    expect(copy.title).toBe("Out of credits");
    expect(copy.message).toContain(`Capacity returns at ${resetsAt.toLocaleString()}`);
    expect(copy.guidance).toContain("/model");
    expect(copy.action).toEqual({ label: "Switch models", command: "/model" });
  });

  it("makes no reset claim when the chain error carries none", () => {
    const copy = classifyApiError('No access provider can run "gpt-5.5" right now. OpenAI: OpenAI reported its quota exhausted.');
    expect(copy.title).toBe("Out of credits");
    expect(copy.message).toContain("waiting alone will not fix this");
    expect(copy.message).not.toContain("Capacity returns at");
  });

  it("explains throttling as temporary and distinct from quota", () => {
    const copy = classifyApiError("429 Too Many Requests");
    expect(copy.title).toBe("Rate limited");
    expect(copy.message).toContain("rate-limiting");
    expect(copy.message).toContain("not your quota");
    expect(copy.guidance).toContain("/model");
  });

  it("explains content-policy declines with a rephrase action", () => {
    const copy = classifyApiError("Content filtered: Output blocked by content filtering policy");
    expect(copy.message).toContain("content policy");
    expect(copy.guidance).toContain("Rephrase");
  });

  it("gives an actionable, retry-oriented message for a transient upstream 520", () => {
    const copy = classifyApiError("520 status code (no body)");
    expect(copy.message).toContain("520");
    expect(copy.guidance).toContain("Send a message to retry");
  });

  it.each(["502 Bad Gateway", "503 Service Unavailable", "504 Gateway Timeout", "500 Internal Server Error", "522 connection timed out", "530"])(
    "recognizes transient upstream code in %p",
    (raw) => { expect(classifyApiError(raw).message).toContain("temporary server error"); },
  );

  it("falls back to an extracted detail for unrecognized errors", () => {
    const raw = '400 {"error":{"message":"image exceeds maximum dimensions"}}';
    const copy = classifyApiError(raw);
    expect(copy.title).toBe("Model request failed");
    expect(copy.detail).toBe("image exceeds maximum dimensions");
  });

  it("keeps every guidance sentence out of the message field", () => {
    for (const raw of ["401 unauthorized", "usage limit reached", "429 Too Many Requests", "503", "unclassified"]) {
      const copy = classifyApiError(raw);
      expect(copy.message).not.toContain("/models");
      expect(copy.message).not.toContain("/auth");
      expect(copy.message.toLowerCase()).not.toContain("send a message");
    }
  });
});

describe("providerErrorProse", () => {
  it("deduplicates presentation only after preserving different reasons and redacts provider credentials", () => {
    const credential = "aB3_".repeat(10);
    const copy = exhaustedProvidersCopy([
      { provider: "account", cause: "quota", detail: `Authorization: Bearer ${credential}`, reset: undefined },
      { provider: "account", cause: "rate_limit", detail: "slow down", reset: undefined },
      { provider: "account", cause: "rate_limit", detail: "slow down", reset: undefined },
    ]);
    expect(copy.detail).not.toContain(credential);
    expect(copy.detail?.match(/slow down/g)).toHaveLength(1);
    expect(providerErrorProse(copy)).toContain("Out of credits");
    expect(providerErrorProse(copy)).toContain("Rate limited");
  });
  it("composes title plus detail for unrecognized errors", () => {
    expect(providerErrorProse(classifyApiError("ECONNRESET"))).toBe("Model request failed: ECONNRESET");
    expect(providerErrorProse(classifyApiError("501 Not Implemented"))).toBe("Model request failed: 501 Not Implemented");
  });

  it("composes title plus problem statement when no detail exists", () => {
    const prose = providerErrorProse(classifyApiError("429 Too Many Requests"));
    expect(prose.startsWith("Rate limited: ")).toBe(true);
    expect(prose).toContain("rate-limiting");
  });

  it("never carries chat-surface guidance", () => {
    for (const raw of ["401 unauthorized", "usage limit reached", "429 Too Many Requests", "503", "unclassified"]) {
      const prose = providerErrorProse(classifyApiError(raw));
      expect(prose).not.toContain("/models");
      expect(prose.toLowerCase()).not.toContain("send a message");
    }
  });
});

describe("extractProviderErrorDetail", () => {
  it("extracts the innermost message from nested JSON error payloads", () => {
    const raw = '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011"}';
    expect(extractProviderErrorDetail(raw)).toBe("Overloaded");
  });

  it("extracts JSON embedded after a status prefix", () => {
    expect(extractProviderErrorDetail('529 {"error":{"message":"Overloaded"}}')).toBe("Overloaded");
  });

  it("reduces HTML error pages to their title", () => {
    const raw = "<html><head><title>502 Bad Gateway</title></head><body>...</body></html>";
    expect(extractProviderErrorDetail(raw)).toBe("502 Bad Gateway");
  });

  it("passes plain text through unchanged", () => {
    expect(extractProviderErrorDetail("stream timeout")).toBe("stream timeout");
  });

  it("keeps the whole extracted detail, which a display bounds on its own", () => {
    expect(extractProviderErrorDetail("x".repeat(1000))).toBe("x".repeat(1000));
    const credential = "aB3_".repeat(10);
    const copy = exhaustedProvidersCopy([
      { provider: "first", cause: "quota", detail: `Authorization: Bearer ${credential} ${"x".repeat(300)}`, reset: undefined },
      { provider: "ChatGPT", cause: "connection", detail: `automatic recheck failed ${"y".repeat(300)}`, reset: undefined },
    ]);
    expect(copy.title).toBe("Providers unavailable");
    expect(copy.detail).not.toContain(credential);
    expect(copy.detail).toContain(`ChatGPT: Connection lost. automatic recheck failed ${"y".repeat(300)}`);
    const shown = boundProviderDetail(copy.detail ?? "");
    expect(shown).toHaveLength(403);
    expect(shown.endsWith("...")).toBe(true);
  });
});

describe("exhaustedProvidersCopy", () => {
  it("names a banked reset in the line of each quota-refused account that holds one, without predicting that it helps", () => {
    const hint = "This account has a banked reset that you can apply in Usage (/usage).";
    const banked = exhaustedProvidersCopy([
      { provider: "ChatGPT", cause: "quota", detail: "out of quota", reset: undefined, bankedReset: true },
      { provider: "OpenAI", cause: "quota", detail: "insufficient_quota", reset: undefined },
    ]);
    expect(banked.title).toBe("Out of credits");
    expect(banked.detail).toBe(`ChatGPT: Out of credits. ${hint} out of quota OpenAI: Out of credits. insufficient_quota`);
    expect(banked.message).not.toContain("banked reset");
    // Embedded registers, such as a workflow step failure, render the lines.
    expect(providerErrorProse(banked)).toContain(`ChatGPT: Out of credits. ${hint}`);

    // A reset restores used-up included usage only, so another refusal names none.
    const throttled = exhaustedProvidersCopy([{ provider: "ChatGPT", cause: "rate_limit", detail: "slow down", reset: undefined, bankedReset: true }]);
    expect(throttled.detail).not.toContain("banked reset");
  });
});

describe("exhaustedProvidersRecovery", () => {
  const at = Date.parse("2026-10-10T12:00:00.000Z");

  it("waits for the earliest bound when every candidate that waiting can help states one", () => {
    expect(exhaustedProvidersRecovery([
      { cause: "quota", reset: { atMs: at + 60_000, hold: { kind: "usage_limit", stated: true } } },
      { cause: "rate_limit", reset: { atMs: at, hold: { kind: "rate_limit" } } },
      { cause: "model_access", reset: undefined },
    ])).toEqual({ kind: "at", atMs: at, hold: { kind: "rate_limit" } });
    // A hold that clears by itself at the earliest time can find a candidate that serves, so it decides a tie.
    expect(exhaustedProvidersRecovery([
      { cause: "quota", reset: { atMs: at + 60_000, hold: { kind: "usage_limit", stated: true } } },
      { cause: "quota", reset: { atMs: at, hold: { kind: "usage_limit", stated: true } } },
      { cause: "connection", reset: { atMs: at, hold: { kind: "recheck" } } },
    ])).toEqual({ kind: "at", atMs: at, hold: { kind: "recheck" } });
    expect(exhaustedProvidersRecovery([
      { cause: "quota", reset: { atMs: at + 60_000, hold: { kind: "usage_limit", stated: true } } },
      { cause: "quota", reset: { atMs: at, hold: { kind: "usage_limit", stated: true } } },
    ])).toEqual({ kind: "at", atMs: at, hold: { kind: "usage_limit", stated: true } });
    // When every candidate's limit is spent, the earliest recheck of a reset that no provider stated is still a spent
    // limit, and a stated reset at the same time names it.
    expect(exhaustedProvidersRecovery([
      { cause: "quota", reset: { atMs: at + 60_000, hold: { kind: "usage_limit", stated: true } } },
      { cause: "quota", reset: { atMs: at, hold: { kind: "usage_limit", stated: false } } },
    ])).toEqual({ kind: "at", atMs: at, hold: { kind: "usage_limit", stated: false } });
    expect(exhaustedProvidersRecovery([
      { cause: "quota", reset: { atMs: at, hold: { kind: "usage_limit", stated: false } } },
      { cause: "quota", reset: { atMs: at, hold: { kind: "usage_limit", stated: true } } },
    ])).toEqual({ kind: "at", atMs: at, hold: { kind: "usage_limit", stated: true } });
    // A spent limit at the earliest time names the earliest later hold that clears by itself, which a run that does
    // not wait for a spent limit waits for.
    expect(exhaustedProvidersRecovery([
      { cause: "quota", reset: { atMs: at, hold: { kind: "usage_limit", stated: true } } },
      { cause: "connection", reset: { atMs: at + 120_000, hold: { kind: "recheck" } } },
      { cause: "rate_limit", reset: { atMs: at + 60_000, hold: { kind: "rate_limit" } } },
    ])).toEqual({ kind: "at", atMs: at, hold: { kind: "usage_limit", stated: true }, selfClearing: { atMs: at + 60_000, hold: { kind: "rate_limit" } } });
  });

  it("states that no reset time is known when the earliest spent limit states none", () => {
    const copy = (stated: boolean) => exhaustedProvidersCopy([{ provider: "OpenRouter", cause: "quota", detail: "out of credit", reset: { atMs: at, hold: { kind: "usage_limit", stated } } }]).message;
    expect(copy(false)).toContain(`No reset time is known. A request after ${new Date(at).toLocaleString()} can recheck`);
    expect(copy(true)).not.toContain("No reset time is known");
  });

  it("retries without a time when a candidate that waiting can help states no bound", () => {
    expect(exhaustedProvidersRecovery([
      { cause: "quota", reset: { atMs: at, hold: { kind: "usage_limit", stated: true } } },
      { cause: "connection", reset: undefined },
    ])).toEqual({ kind: "retry" });
    // The next request uses the standard context window.
    expect(exhaustedProvidersRecovery([{ cause: "extended_context", reset: undefined }])).toEqual({ kind: "retry" });
  });

  it("states no recovery when only what the accounts grant refused the request", () => {
    expect(exhaustedProvidersRecovery([
      { cause: "ineligible", reset: undefined },
      { cause: "model_access", reset: undefined },
    ])).toEqual({ kind: "none" });
  });
});
