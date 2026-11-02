/** Exact candidate-mode quota folds and ChatGPT provider observations. */

import { describe, expect, test } from "bun:test";
import { createProviderAvailability, observeChatGptQuotaFrame } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability.js";
import { CHATGPT_RATE_LIMIT_HEADER_PREFIX } from "../../../../../src/infra/auth/openai-auth-types.js";
import type { AccessProviderCandidate } from "../../../../../src/infra/llm/access-provider.js";
import {
  CHATGPT,
  GOOGLE_API,
  harness,
  OPENAI_API,
  OPENROUTER,
  SAFE_RECHECK_MS,
} from "./_provider-availability-harness.js";

interface StringRecord { [key: string]: string }


describe("generic quota exhaustion entries", () => {
  test("an exhaustion with a future reset expires on read once the clock passes it", () => {
    const h = harness([]);

    h.availability.markQuotaExhausted(OPENAI_API, 1_000_000 + 3_600_000);
    expect(h.availability.quotaExhaustion(OPENAI_API))
      .toEqual({ exhaustedAtMs: 1_000_000, resetsAtMs: 1_000_000 + 3_600_000 });

    h.advance(3_600_000);
    expect(h.availability.quotaExhaustion(OPENAI_API)).toBeUndefined();
  });

  test("an exhaustion the provider gave no reset for holds only to its bounded safe recheck", () => {
    const h = harness([]);

    h.availability.markQuotaExhausted(OPENROUTER);
    expect(h.availability.quotaExhaustion(OPENROUTER))
      .toEqual({ exhaustedAtMs: 1_000_000, resetsAtMs: 1_000_000 + SAFE_RECHECK_MS });

    h.advance(SAFE_RECHECK_MS);
    expect(h.availability.quotaExhaustion(OPENROUTER)).toBeUndefined();
  });

  test("entries are per provider and the next observation supersedes the last", () => {
    const h = harness([]);

    h.availability.markQuotaExhausted(OPENAI_API, 1_000_000 + 1_000);
    expect(h.availability.quotaExhaustion(GOOGLE_API)).toBeUndefined();

    h.advance(2_000);
    expect(h.availability.quotaExhaustion(OPENAI_API)).toBeUndefined();

    h.availability.markQuotaExhausted(OPENAI_API);
    expect(h.availability.quotaExhaustion(OPENAI_API))
      .toEqual({ exhaustedAtMs: 1_002_000, resetsAtMs: 1_002_000 + SAFE_RECHECK_MS });
  });

});

describe("Anthropic API rate limits", () => {
  const ANTHROPIC_API: AccessProviderCandidate = { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" };
  const resetAt = (offsetMs: number) => new Date(1_000_000 + offsetMs).toISOString();

  test("a throttled response holds the account until every limit it states is full again", () => {
    const { availability } = harness([]);

    availability.observeAnthropicRateLimit(ANTHROPIC_API, new Headers({
      "anthropic-ratelimit-requests-reset": resetAt(20_000),
      "anthropic-ratelimit-tokens-reset": resetAt(45_000),
      "anthropic-ratelimit-input-tokens-reset": resetAt(-5_000),
      "retry-after": "20",
    }));

    expect(availability.genericQuotaStanding(ANTHROPIC_API)).toEqual({
      kind: "suppressed",
      exhaustion: { exhaustedAtMs: 1_000_000, resetsAtMs: 1_000_000 + 45_000 },
    });
  });

  test("a throttled response that states no reset leaves the account as it was", () => {
    const { availability } = harness([]);

    availability.observeAnthropicRateLimit(ANTHROPIC_API, new Headers({ "retry-after": "20" }));

    expect(availability.genericQuotaStanding(ANTHROPIC_API)).toEqual({ kind: "live" });
  });
});

/** ChatGPT rate-limit headers, each named by its suffix after the header prefix. */
function rateHeaders(values: StringRecord): Headers {
  return new Headers(Object.fromEntries(Object.entries(values).map(([suffix, value]) => [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-${suffix}`, value])));
}

describe("ChatGPT quota windows", () => {
  // The owner's fixed clock starts at 1_000_000ms; header resets are Unix
  // seconds, so any future reset must clear that epoch.
  const RESET_SECONDS = 1_000_000;

  test("windows under their limits are live observations, whatever their usage reads", () => {
    const { availability } = harness([]);

    availability.observeChatGptRateHeaders(CHATGPT, rateHeaders({
      "primary-used-percent": "12.5",
      "primary-window-minutes": "300",
      "primary-reset-at": String(RESET_SECONDS),
      "secondary-used-percent": "80",
      "secondary-window-minutes": "10080",
    }));

    expect(availability.chatGptStanding(CHATGPT)).toEqual({ kind: "live" });
  });

  test("an at-limit secondary window suppresses the account until its reset", () => {
    const { availability } = harness([]);

    availability.observeChatGptRateHeaders(CHATGPT, rateHeaders({
      "primary-used-percent": "40",
      "primary-window-minutes": "300",
      "secondary-used-percent": "100",
      "secondary-window-minutes": "10080",
      "secondary-reset-at": String(RESET_SECONDS),
    }));

    expect(availability.chatGptStanding(CHATGPT)).toMatchObject({
      kind: "suppressed",
      exhaustion: { resetsAtMs: RESET_SECONDS * 1000 },
    });
  });

  test("both windows at their limits hold the account to the later reset", () => {
    const { availability } = harness([]);

    availability.observeChatGptRateHeaders(CHATGPT, rateHeaders({
      "primary-used-percent": "100",
      "primary-reset-at": String(RESET_SECONDS),
      "secondary-used-percent": "100",
      "secondary-reset-at": String(RESET_SECONDS + 3_600),
    }));

    expect(availability.chatGptStanding(CHATGPT)).toMatchObject({
      kind: "suppressed",
      exhaustion: { resetsAtMs: (RESET_SECONDS + 3_600) * 1000 },
    });
  });

  test("an under-limit window observed later ends the suppression it renews", () => {
    const { availability } = harness([]);

    availability.observeChatGptQuotaExhausted(CHATGPT, RESET_SECONDS);
    availability.observeChatGptRateHeaders(CHATGPT, rateHeaders({ "primary-used-percent": "3" }));

    expect(availability.chatGptStanding(CHATGPT)).toEqual({ kind: "live" });
  });

  test("a terminal quota frame suppresses the account until the reset it names", () => {
    const { availability } = harness([]);

    availability.observeChatGptQuotaExhausted(CHATGPT, RESET_SECONDS);

    expect(availability.chatGptStanding(CHATGPT)).toMatchObject({
      kind: "suppressed",
      exhaustion: { resetsAtMs: RESET_SECONDS * 1000 },
    });
  });

  test("a response.failed frame carrying a terminal quota code names its reset window", () => {
    const { availability } = harness([]);

    observeChatGptQuotaFrame({
      type: "response.failed",
      response: { id: "resp_1", error: { code: "usage_limit_reached", message: "limit hit", resets_at: RESET_SECONDS } },
    }, CHATGPT, availability);

    expect(availability.chatGptStanding(CHATGPT)).toMatchObject({
      kind: "suppressed",
      exhaustion: { resetsAtMs: RESET_SECONDS * 1000 },
    });
  });

  test("an error frame carrying a terminal quota code without a reset holds to the safe recheck", () => {
    const h = harness([]);

    observeChatGptQuotaFrame({ type: "error", code: "insufficient_quota", message: "out of credit" }, CHATGPT, h.availability);

    expect(h.availability.chatGptStanding(CHATGPT)).toMatchObject({
      kind: "suppressed",
      exhaustion: { resetsAtMs: 1_000_000 + SAFE_RECHECK_MS },
    });
  });

  test("frames that name no terminal quota code leave the account untouched", () => {
    const { availability } = harness([]);

    observeChatGptQuotaFrame({ type: "error", code: "rate_limit_exceeded", message: "slow down" }, CHATGPT, availability);
    observeChatGptQuotaFrame({ type: "response.failed", response: { incomplete_details: { reason: "max_output_tokens" } } }, CHATGPT, availability);
    observeChatGptQuotaFrame("not a frame", CHATGPT, availability);

    expect(availability.chatGptStanding(CHATGPT)).toEqual({ kind: "live" });
  });
});

describe("exact-mode ChatGPT observations", () => {
  test("rate headers affect included mode only", () => {
    const included: AccessProviderCandidate = { kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-account", spendMode: "included" };
    const prepaid: AccessProviderCandidate = { kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-account", spendMode: "prepaid" };
    const availability = createProviderAvailability().forCandidates("default", [included, prepaid]);
    const headers = rateHeaders({ "primary-used-percent": "100", "primary-reset-at": String(Math.floor(Date.now() / 1000) + 3_600) });

    availability.observeChatGptRateHeaders(prepaid, headers);
    expect(availability.chatGptStanding(prepaid)).toEqual({ kind: "live" });
    availability.observeChatGptRateHeaders(included, headers);
    expect(availability.chatGptStanding(included).kind).toBe("suppressed");
    expect(availability.chatGptStanding(prepaid)).toEqual({ kind: "live" });
  });
});

