/** ChatGPT recovery through the shared probe lease: one request per fleet
 *  rechecks an expired suppression, exactly like every generic provider, and
 *  an admission concludes for both usage windows. The generic probe lifecycle
 *  is in `provider-availability-authority.test.ts`. */

import { describe, expect, test } from "bun:test";
import { harness, NOW_MS, SAFE_RECHECK_MS, availabilityFixtures } from "./_provider-availability-harness.js";
import { CHATGPT_RATE_LIMIT_HEADER_PREFIX } from "../../../../../src/infra/auth/openai-auth-types.js";

const { tempDbFile, createAuthority: createAvailabilityAuthority } = availabilityFixtures();

const SUBJECT = "account-one";
const CANDIDATE = { kind: "subscription", providerId: "chatgpt", instanceId: SUBJECT, spendMode: "included" } as const;

/** One file-backed authority plus a second handle on the same file for the
 *  other process in a test. */
function twoProcessAuthority() {
  const dbFile = tempDbFile();
  return { authority: createAvailabilityAuthority({ dbFile }), other: createAvailabilityAuthority({ dbFile }) };
}

describe("ChatGPT probe lease", () => {
  test("one probe per fleet rechecks an expired ChatGPT suppression, and its admission returns every owner", async () => {
    const { authority, other } = twoProcessAuthority();
    const a = harness([], authority, [CANDIDATE]);
    const b = harness([], other, [CANDIDATE]);
    a.availability.observeChatGptQuotaExhausted(CANDIDATE, undefined);
    b.availability.refreshProjection();
    expect(b.availability.chatGptStanding(CANDIDATE).kind).toBe("suppressed");

    // Past the bound, the recheck belongs to exactly one request: ChatGPT is
    // gated through the same probe lease as every generic provider, so a
    // still-dead account costs the fleet one request, not a stampede.
    a.advance(SAFE_RECHECK_MS + 1);
    b.advance(SAFE_RECHECK_MS + 1);
    expect(a.availability.chatGptStanding(CANDIDATE).kind).toBe("probe_due");
    const probe = a.availability.claimQuotaProbe(CANDIDATE);
    if (probe === undefined) throw new Error("expected the first claim to win");
    expect(probe.window).toBe("primary");

    expect(b.availability.claimQuotaProbe(CANDIDATE)).toBeUndefined();
    expect(b.availability.chatGptStanding(CANDIDATE).kind).toBe("recheck_pending");
    const pending = b.availability.chatGptStanding(CANDIDATE);
    if (pending.kind !== "recheck_pending") throw new Error("expected pending recheck");

    expect(a.availability.markQuotaLive(CANDIDATE, probe)).toBe(true);
    await b.availability.waitForChange(pending, new AbortController().signal);
    expect(b.availability.chatGptStanding(CANDIDATE)).toEqual({ kind: "live" });
  });

  test("a ChatGPT probe admission returns a sibling window whose bound has also passed", () => {
    const { authority } = twoProcessAuthority();
    const a = harness([], authority, [CANDIDATE]);
    a.availability.observeChatGptQuotaExhausted(CANDIDATE, undefined);
    a.availability.observeChatGptRateHeaders(CANDIDATE, new Headers({
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-secondary-used-percent`]: "100",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-secondary-reset-at`]: String(Math.floor((NOW_MS + SAFE_RECHECK_MS) / 1000)),
    }));

    a.advance(SAFE_RECHECK_MS + 1);
    expect(a.availability.chatGptStanding(CANDIDATE).kind).toBe("probe_due");
    const probe = a.availability.claimQuotaProbe(CANDIDATE);
    if (probe === undefined) throw new Error("expected the claim to win");

    // The admission speaks for the account, so the expired secondary window
    // returns with the probed primary and nothing holds the account back.
    expect(a.availability.markQuotaLive(CANDIDATE, probe)).toBe(true);
    expect(a.availability.chatGptStanding(CANDIDATE)).toEqual({ kind: "live" });
  });
});
