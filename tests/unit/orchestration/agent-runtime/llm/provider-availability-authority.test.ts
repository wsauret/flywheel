/** The availability owner against a durable, account-scoped authority: what
 *  two clients of one process read under two account bindings, what two
 *  processes on one account read from each other, and what each of them is
 *  allowed to conclude when the authority cannot be reached. The Copilot
 *  meter lease two processes contend for is in
 *  `provider-availability-copilot-coordination.test.ts`. */

import { describe, expect, test } from "bun:test";
import { accessProviderCandidateKey } from "../../../../../src/infra/llm/access-provider.js";
import {
  type AvailabilityAuthority,
  AvailabilityCorruptError,
  type AvailabilityKey,
  type AvailabilityObservation,
} from "../../../../../src/infra/llm/availability-store.js";
import {
  disposeSharedProviderAvailability,
  getSharedProviderAvailability,
} from "../../../../../src/orchestration/agent-runtime/llm/shared-provider-availability.js";
import { QuotaCoordinationError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import {
  harness,
  NOW_MS,
  SAFE_RECHECK_MS,
  singleton,
  subscription,
  availabilityFixtures,
} from "./_provider-availability-harness.js";
import { CHATGPT_RATE_LIMIT_HEADER_PREFIX } from "../../../../../src/infra/auth/openai-auth-types.js";

const { tempDbFile, createAuthority: createAvailabilityAuthority } = availabilityFixtures();

/** Every row one account can hold. The authority reads by key, so a test that
 *  asserts what another process would see names the accounts it wrote. */
function rowsFor(authority: AvailabilityAuthority, ...instanceIds: readonly string[]) {
  const keys: AvailabilityKey[] = instanceIds.flatMap((instanceId) => [
    { scope: "account", profileId: "default", provider: "openai_api", candidateKey: accessProviderCandidateKey(subscription("openai_api", instanceId)), window: "account" },
    { scope: "account", profileId: "default", provider: "github_copilot", candidateKey: accessProviderCandidateKey(subscription("github_copilot", instanceId)), window: "account" },
    { scope: "account", profileId: "default", provider: "chatgpt", candidateKey: accessProviderCandidateKey(subscription("chatgpt", instanceId)), window: "primary" },
    { scope: "account", profileId: "default", provider: "chatgpt", candidateKey: accessProviderCandidateKey(subscription("chatgpt", instanceId)), window: "secondary" },
  ]);
  return authority.snapshotFor(keys).rows;
}
type AccountObservation = Extract<AvailabilityObservation, { readonly scope: "account" }>;

describe("durable availability authority", () => {
  const FUTURE_RESET_MS = NOW_MS + 86_400_000;
  const PAST_RESET_MS = 900_000;
  const SUBJECT = "account-one";
  const OTHER_SUBJECT = "account-two";
  const OPENAI = subscription("openai_api", SUBJECT);
  const OTHER_OPENAI = subscription("openai_api", OTHER_SUBJECT);
  const CHATGPT = subscription("chatgpt", SUBJECT);
  const GOOGLE = subscription("google_api", SUBJECT);

  /** A file-backed authority holding the given rows, plus a second handle on
   *  the same file for the other process in a test. */
  function seeded(rows: Array<Omit<AccountObservation, "readGeneration">>) {
    const dbFile = tempDbFile();
    const other = createAvailabilityAuthority({ dbFile });
    for (const row of rows) other.commit({ ...row, readGeneration: 0 });
    return { authority: createAvailabilityAuthority({ dbFile }), other };
  }

  /** Authority double that records commits, and can fail every call the way a
   *  contended or corrupt database does. */
  function recordingAuthority(failWith?: Error) {
    const commits: AvailabilityObservation[] = [];
    const authority: AvailabilityAuthority = {
      snapshotFor: () => {
        if (failWith) throw failWith;
        return { incarnation: "test", revision: commits.length, rows: [] };
      },
      revision: () => {
        if (failWith) throw failWith;
        return commits.length;
      },
      commit: (observation) => {
        if (failWith) throw failWith;
        commits.push(observation);
        return {
          kind: "committed",
          row: { ...observation, generation: observation.readGeneration + 1, fence: observation.fence ?? 0, leaseExpiresAtMs: 0 },
        };
      },
      claimProbe: (claim) => {
        if (failWith) throw failWith;
        return {
          kind: "won",
          row: {
            ...claim,
            state: "probe_due",
            generation: 0,
            observedAtMs: claim.nowMs,
            source: "probe-lease",
            fence: 1,
            leaseExpiresAtMs: claim.nowMs + claim.leaseMs,
          },
          revision: commits.length,
        };
      },
      renewProbe: () => {
        if (failWith) throw failWith;
        return true;
      },
      releaseProbe: () => {
        if (failWith) throw failWith;
      },
      dispose: () => Promise.resolve(),
    };
    return { authority, commits };
  }

  const exhaustedRow = (overrides: Partial<Omit<AccountObservation, "readGeneration">>): Omit<AccountObservation, "readGeneration"> => {
    const provider = overrides.provider ?? "openai_api";
    return {
      scope: "account",
      profileId: overrides.profileId ?? "default",
      provider,
      candidateKey: overrides.candidateKey ?? accessProviderCandidateKey(subscription(provider, SUBJECT)),
      window: "account",
      state: "exhausted",
      observedAtMs: 500_000,
      resetsAtMs: FUTURE_RESET_MS,
      source: "terminal-quota-error",
      ...overrides,
    };
  };

  test("the first projection refresh hydrates a stored exhaustion with a future reset", () => {
    const { authority } = seeded([exhaustedRow({})]);
    const { availability } = harness([], authority, [subscription("openai_api", SUBJECT)]);

    availability.refreshProjection();

    expect(availability.quotaExhaustion(OPENAI))
      .toEqual({ exhaustedAtMs: 500_000, resetsAtMs: FUTURE_RESET_MS, hold: { kind: "usage_limit", stated: true } });
  });

  test("a stored live row leaves the provider available", () => {
    const { authority } = seeded([exhaustedRow({ state: "live", resetsAtMs: undefined })]);
    const { availability } = harness([], authority, [subscription("openai_api", SUBJECT)]);

    availability.refreshProjection();

    expect(availability.quotaExhaustion(OPENAI)).toBeUndefined();
  });

  test("stored suppressions whose reset or safe recheck has passed leave the provider available", () => {
    const { authority } = seeded([
      exhaustedRow({ resetsAtMs: PAST_RESET_MS }),
      exhaustedRow({ provider: "chatgpt", window: "primary", resetsAtMs: undefined, nextProbeAtMs: PAST_RESET_MS }),
    ]);
    const { availability } = harness([], authority, [subscription("openai_api", SUBJECT), subscription("chatgpt", SUBJECT)]);

    availability.refreshProjection();

    expect(availability.quotaExhaustion(OPENAI)).toBeUndefined();
    expect(availability.chatGptStanding(CHATGPT)).toEqual({ kind: "probe_due" });
  });

  test("a stored ChatGPT window with a future reset hydrates the window as exhausted", () => {
    const { authority } = seeded([exhaustedRow({ provider: "chatgpt", window: "primary" })]);
    const { availability } = harness([], authority, [subscription("chatgpt", SUBJECT)]);

    availability.refreshProjection();

    expect(availability.chatGptStanding(CHATGPT)).toMatchObject({
      kind: "suppressed",
      exhaustion: { resetsAtMs: FUTURE_RESET_MS },
    });
  });

  test("two accounts active at once read and commit only under their own key", () => {
    const { authority, other } = seeded([
      exhaustedRow({}),
      exhaustedRow({ candidateKey: accessProviderCandidateKey(OTHER_OPENAI), state: "live", resetsAtMs: undefined }),
    ]);
    const { owner } = harness([], authority);
    // Two clients of one process, authenticated as two accounts.
    const one = owner.forCandidates("default", [OPENAI]);
    const two = owner.forCandidates("default", [subscription("openai_api", OTHER_SUBJECT)]);

    one.refreshProjection();
    two.refreshProjection();
    expect(one.quotaExhaustion(OPENAI)?.resetsAtMs).toBe(FUTURE_RESET_MS);
    expect(two.quotaExhaustion(OTHER_OPENAI)).toBeUndefined();

    // A suppression the second account hits never holds the first one back.
    two.markQuotaExhausted(OTHER_OPENAI, FUTURE_RESET_MS + 1_000);

    expect(one.quotaExhaustion(OPENAI)?.resetsAtMs).toBe(FUTURE_RESET_MS);
    expect(two.quotaExhaustion(OTHER_OPENAI)?.resetsAtMs).toBe(FUTURE_RESET_MS + 1_000);
    expect(rowsFor(other, SUBJECT, OTHER_SUBJECT)).toEqual([
      expect.objectContaining({ candidateKey: accessProviderCandidateKey(OPENAI), resetsAtMs: FUTURE_RESET_MS }),
      expect.objectContaining({ candidateKey: accessProviderCandidateKey(OTHER_OPENAI), resetsAtMs: FUTURE_RESET_MS + 1_000 }),
    ]);
  });


  test("leaving exhaustion records a live version of the row rather than deleting it", () => {
    const { authority, other } = seeded([]);
    const { availability } = harness([], authority, [subscription("chatgpt", SUBJECT)]);
    const busyHeaders = new Headers({
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-used-percent`]: "50",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-window-minutes`]: "300",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-reset-at`]: "1704069000",
    });
    const exhaustedHeaders = new Headers({
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-used-percent`]: "100",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-window-minutes`]: "300",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-reset-at`]: "1704069000",
    });

    availability.observeChatGptRateHeaders(CHATGPT, exhaustedHeaders);
    availability.observeChatGptRateHeaders(CHATGPT, busyHeaders);

    expect(rowsFor(other, SUBJECT)).toEqual([expect.objectContaining({
      provider: "chatgpt",
      window: "primary",
      state: "live",
      generation: 2,
    })]);
  });

  test("a fresher usage report reopens the window the headers closed; an older one says nothing", () => {
    const { authority, other } = seeded([]);
    const { availability } = harness([], authority, [subscription("chatgpt", SUBJECT)]);
    const primary = (usedFraction: number) => [{ metricKey: "primary_window", label: "Primary window", scope: { kind: "account" as const }, rank: 0, usedFraction, timing: { kind: "exact" as const, startMs: NOW_MS - 1_000, endMs: FUTURE_RESET_MS } }];
    availability.observeChatGptRateHeaders(CHATGPT, new Headers({
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-used-percent`]: "100",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-window-minutes`]: "300",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-reset-at`]: String(Math.floor(FUTURE_RESET_MS / 1000)),
    }));
    expect(availability.chatGptStanding(CHATGPT).kind).toBe("suppressed");

    availability.observeChatGptUsage(CHATGPT, primary(1), NOW_MS - 1);
    expect(availability.chatGptStanding(CHATGPT).kind).toBe("suppressed");

    availability.observeChatGptUsage(CHATGPT, primary(0), NOW_MS + 1);
    expect(availability.chatGptStanding(CHATGPT).kind).toBe("live");
    expect(rowsFor(other, SUBJECT)).toEqual([expect.objectContaining({ window: "primary", state: "live", source: "chatgpt-usage-report", observedAtMs: NOW_MS + 1 })]);

    availability.observeChatGptUsage(CHATGPT, primary(1), NOW_MS);
    expect(availability.chatGptStanding(CHATGPT).kind).toBe("live");
  });

  test("the first observation of a window is committed once; restating it commits nothing", () => {
    const { authority, commits } = recordingAuthority();
    const { availability } = harness([], authority, [subscription("chatgpt", SUBJECT)]);
    const busyHeaders = new Headers({
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-used-percent`]: "50",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-window-minutes`]: "300",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-reset-at`]: "1704069000",
    });
    const exhaustedHeaders = new Headers({
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-used-percent`]: "100",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-window-minutes`]: "300",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-reset-at`]: "1704069000",
    });

    availability.observeChatGptRateHeaders(CHATGPT, busyHeaders);
    availability.observeChatGptRateHeaders(CHATGPT, busyHeaders);
    availability.observeChatGptRateHeaders(CHATGPT, busyHeaders);
    expect(commits).toEqual([expect.objectContaining({ window: "primary", state: "live", readGeneration: 0 })]);

    availability.observeChatGptRateHeaders(CHATGPT, exhaustedHeaders);
    availability.observeChatGptRateHeaders(CHATGPT, exhaustedHeaders);
    expect(commits.slice(1)).toEqual([{
      provider: "chatgpt",
      scope: "account",
      profileId: "default",
      candidateKey: accessProviderCandidateKey(CHATGPT),
      window: "primary",
      state: "exhausted",
      resetsAtMs: 1_704_069_000_000,
      observedAtMs: NOW_MS,
      source: "chatgpt-rate-headers",
      readGeneration: 1,
    }]);

    availability.observeChatGptRateHeaders(CHATGPT, busyHeaders);
    expect(commits).toHaveLength(3);
    expect(commits[2]).toMatchObject({ state: "live", readGeneration: 2 });
  });

  test("a terminal ChatGPT frame with no reported reset is durable under a bounded safe recheck", () => {
    const { authority, commits } = recordingAuthority();
    const { availability } = harness([], authority, [subscription("chatgpt", SUBJECT)]);

    availability.observeChatGptQuotaExhausted(CHATGPT, undefined);

    expect(availability.chatGptStanding(CHATGPT)).toMatchObject({ kind: "suppressed" });
    expect(commits).toEqual([expect.objectContaining({
      state: "exhausted",
      nextProbeAtMs: NOW_MS + SAFE_RECHECK_MS,
    })]);
  });

  test("a rejected commit adopts the row another process committed", () => {
    const { authority, other } = seeded([]);
    const { availability } = harness([], authority, [subscription("chatgpt", SUBJECT)]);

    // The other process suppresses the window while this one is mid-request.
    other.commit({ ...exhaustedRow({ provider: "chatgpt", window: "primary" }), readGeneration: 0 });
    availability.observeChatGptRateHeaders(CHATGPT, new Headers({
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-used-percent`]: "50",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-window-minutes`]: "300",
    }));

    expect(availability.chatGptStanding(CHATGPT)).toMatchObject({
      kind: "suppressed",
      exhaustion: { resetsAtMs: FUTURE_RESET_MS },
    });
  });

  test("one probe per fleet rechecks an expired generic suppression, and its live commit returns every owner", async () => {
    const { authority, other } = seeded([]);
    const a = harness([], authority, [subscription("openai_api", SUBJECT)]);
    const b = harness([], other, [subscription("openai_api", SUBJECT)]);
    a.availability.markQuotaExhausted(OPENAI);
    b.availability.refreshProjection();
    expect(b.availability.genericQuotaStanding(OPENAI).kind).toBe("suppressed");

    // Past the bound, the recheck belongs to exactly one request.
    a.advance(SAFE_RECHECK_MS + 1);
    b.advance(SAFE_RECHECK_MS + 1);
    expect(a.availability.genericQuotaStanding(OPENAI).kind).toBe("probe_due");
    const probe = a.availability.claimQuotaProbe(OPENAI);
    if (probe === undefined) throw new Error("expected the first claim to win");

    // The loser's claim exposes the lease deadline and authority revision that
    // its transaction observed.
    expect(b.availability.claimQuotaProbe(OPENAI)).toBeUndefined();
    const pending = b.availability.genericQuotaStanding(OPENAI);
    expect(pending).toEqual({
      kind: "recheck_pending",
      untilMs: expect.any(Number),
      revision: 1,
    });
    if (pending.kind !== "recheck_pending") throw new Error("expected pending recheck");

    // The winner's admission commits live, and one commit returns the fleet.
    a.availability.markQuotaLive(OPENAI, probe);
    await b.availability.waitForChange(pending, new AbortController().signal);
    expect(b.availability.genericQuotaStanding(OPENAI)).toEqual({ kind: "live" });
  });

  test("a released probe admits the next claimant without waiting the lease out", () => {
    const { authority, other } = seeded([]);
    const a = harness([], authority, [subscription("openai_api", SUBJECT)]);
    const b = harness([], other, [subscription("openai_api", SUBJECT)]);
    a.availability.markQuotaExhausted(OPENAI);
    a.advance(SAFE_RECHECK_MS + 1);
    b.advance(SAFE_RECHECK_MS + 1);

    const probe = a.availability.claimQuotaProbe(OPENAI);
    if (probe === undefined) throw new Error("expected the first claim to win");
    // The probe request died on something that said nothing about quota.
    a.availability.releaseQuotaProbe(OPENAI, probe);

    expect(b.availability.claimQuotaProbe(OPENAI)?.fence).toBeGreaterThan(probe.fence);
  });

  test("a singleton candidate coordinates under its canonical candidate key", () => {
    const { authority, other } = seeded([]);
    const candidate = singleton("openai_api");
    const { availability } = harness([], authority, [candidate]);

    availability.markQuotaExhausted(candidate, FUTURE_RESET_MS);

    expect(availability.quotaExhaustion(candidate)?.resetsAtMs).toBe(FUTURE_RESET_MS);
    expect(other.snapshotFor([{ scope: "account", profileId: "default", provider: "openai_api", candidateKey: accessProviderCandidateKey(candidate), window: "account" }]).rows)
      .toEqual([expect.objectContaining({ candidateKey: accessProviderCandidateKey(candidate), state: "exhausted" })]);
  });

  test("a terminal suppression that did not reach the account blocks the fallback it would license", () => {
    const { authority } = recordingAuthority(new Error("SQLITE_BUSY: database is locked"));
    const { availability } = harness([], authority, [subscription("openai_api", SUBJECT)]);

    // Every other process still believes this account can serve, so serving
    // the request from a second account is not this process's call to make.
    expect(() => { availability.markQuotaExhausted(OPENAI, FUTURE_RESET_MS) })
      .toThrow(QuotaCoordinationError);

    // The observation still stands here: this process does not retry a
    // provider it just watched run out.
    expect(availability.quotaExhaustion(OPENAI))
      .toEqual({ exhaustedAtMs: NOW_MS, resetsAtMs: FUTURE_RESET_MS, hold: { kind: "usage_limit", stated: true } });
  });

  test("a suppression the account rejected to a newer live row lands on the re-offer", () => {
    const { authority, other } = seeded([]);
    const { availability } = harness([], authority, [subscription("openai_api", SUBJECT)]);
    availability.markQuotaExhausted(OPENAI, FUTURE_RESET_MS);

    // Another process observed the account live after this one read it, so
    // this owner's suppression is decided on a generation that has moved. The
    // terminal failure behind it was observed after that live row in provider
    // time, so the re-offer at the adopted generation is the account's newest
    // fact, not a stale conclusion.
    other.commit({ ...exhaustedRow({ state: "live", resetsAtMs: undefined }), readGeneration: 1 });

    availability.markQuotaExhausted(OPENAI, FUTURE_RESET_MS + 1_000);
    expect(availability.quotaExhaustion(OPENAI))
      .toEqual({ exhaustedAtMs: NOW_MS, resetsAtMs: FUTURE_RESET_MS + 1_000, hold: { kind: "usage_limit", stated: true } });
    expect(rowsFor(other, SUBJECT)).toEqual([expect.objectContaining({
      provider: "openai_api",
      state: "exhausted",
      generation: 3,
    })]);
  });

  test("a terminal ChatGPT frame that did not reach the account blocks the fallback it would license", () => {
    const { authority } = recordingAuthority(new Error("SQLITE_BUSY: database is locked"));
    const { availability } = harness([], authority, [subscription("chatgpt", SUBJECT)]);

    expect(() => { availability.observeChatGptQuotaExhausted(CHATGPT, undefined) })
      .toThrow(QuotaCoordinationError);
    expect(availability.chatGptStanding(CHATGPT)).toMatchObject({ kind: "suppressed" });
  });

  test("a terminal ChatGPT frame the account rejected to a live window lands on the re-offer", () => {
    const { authority, other } = seeded([exhaustedRow({ provider: "chatgpt", window: "primary" })]);
    const { availability } = harness([], authority, [subscription("chatgpt", SUBJECT)]);
    availability.refreshProjection();

    other.commit({ ...exhaustedRow({ provider: "chatgpt", window: "primary", state: "live", resetsAtMs: undefined }), readGeneration: 1 });

    availability.observeChatGptQuotaExhausted(CHATGPT, FUTURE_RESET_MS / 1000 + 60);
    expect(availability.chatGptStanding(CHATGPT)).toMatchObject({ kind: "suppressed" });
    expect(rowsFor(other, SUBJECT)).toEqual([expect.objectContaining({
      provider: "chatgpt",
      window: "primary",
      state: "exhausted",
      generation: 3,
    })]);
  });

  test("an availability read the authority refused stops the request before it is routed", () => {
    const { authority } = recordingAuthority(new Error("SQLITE_BUSY: database is locked"));
    const bound = harness([], authority, [subscription("openai_api", SUBJECT)]);
    const unbound = harness([], authority);

    // The candidates this request would filter cannot be judged at all, and
    // provider I/O on a stale projection spends what other processes meter.
    expect(() => { bound.availability.refreshProjection() }).toThrow(QuotaCoordinationError);
    // A binding that names no account coordinates with nobody, so the same
    // failure costs it nothing.
    expect(() => { unbound.availability.refreshProjection() }).not.toThrow();
  });

  test("a claim failure is a coordination error, not pending state", () => {
    const { authority } = recordingAuthority(new Error("SQLITE_BUSY: database is locked"));
    const { availability } = harness([], authority, [subscription("openai_api", SUBJECT)]);

    expect(() => availability.claimQuotaProbe(OPENAI)).toThrow(QuotaCoordinationError);
    expect(availability.genericQuotaStanding(OPENAI)).toEqual({ kind: "live" });
  });


  test("an explicit zero-minute window is a live observation the other owner recovers from", () => {
    const { authority, other } = seeded([exhaustedRow({ provider: "chatgpt", window: "primary" })]);
    const a = harness([], authority, [subscription("chatgpt", SUBJECT)]);
    const b = harness([], other, [subscription("chatgpt", SUBJECT)]);
    a.availability.refreshProjection();
    b.availability.refreshProjection();
    expect(b.availability.chatGptStanding(CHATGPT)).toMatchObject({ kind: "suppressed" });

    // The backend states the window is zero minutes long: it holds the account
    // back no longer, which every other owner must be able to read.
    a.availability.observeChatGptRateHeaders(CHATGPT, new Headers({
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-used-percent`]: "100",
      [`${CHATGPT_RATE_LIMIT_HEADER_PREFIX}-primary-window-minutes`]: "0",
    }));
    const nextRequest = harness([], other, [subscription("chatgpt", SUBJECT)]).availability;
    nextRequest.refreshProjection();

    expect(a.availability.chatGptStanding(CHATGPT)).toEqual({ kind: "live" });
    expect(nextRequest.chatGptStanding(CHATGPT)).toEqual({ kind: "live" });
    expect(rowsFor(other, SUBJECT)).toEqual([expect.objectContaining({ window: "primary", state: "live", generation: 2 })]);
  });

  test("a response that describes no window states nothing, so the suppression stands", () => {
    const { authority, other } = seeded([exhaustedRow({ provider: "chatgpt", window: "primary" })]);
    const a = harness([], authority, [subscription("chatgpt", SUBJECT)]);
    a.availability.refreshProjection();

    a.availability.observeChatGptRateHeaders(CHATGPT, new Headers({ "content-type": "application/json" }));

    expect(a.availability.chatGptStanding(CHATGPT)).toMatchObject({ kind: "suppressed" });
    expect(rowsFor(other, SUBJECT)).toEqual([expect.objectContaining({ state: "exhausted", generation: 1 })]);
  });


  test("confirmed corruption fails closed: the owner stops using the authority and never rebuilds it", () => {
    const corrupt = new AvailabilityCorruptError({
      message: "corrupt",
      at: "reading the availability authority",
      reason: "database disk image is malformed",
    });
    const { authority, commits } = recordingAuthority(corrupt);
    const { availability } = harness([], authority, [subscription("openai_api", SUBJECT), subscription("google_api", SUBJECT)]);

    expect(() => { availability.markQuotaExhausted(OPENAI, FUTURE_RESET_MS) })
      .toThrow(QuotaCoordinationError);
    // The second suppression finds the authority already given up on.
    expect(() => { availability.markQuotaExhausted(GOOGLE, FUTURE_RESET_MS) })
      .toThrow(QuotaCoordinationError);

    expect(commits).toHaveLength(0);
    expect(availability.quotaExhaustion(OPENAI)?.resetsAtMs).toBe(FUTURE_RESET_MS);
  });

  test("a terminal failure repeated after its safe recheck expired renews the suppression", () => {
    const { authority, other } = seeded([]);
    const h = harness([], authority, [subscription("openai_api", SUBJECT)]);
    h.availability.markQuotaExhausted(OPENAI);

    // The bound passes without the provider stating a reset, and the next
    // request finds the account still out.
    h.advance(SAFE_RECHECK_MS);
    h.availability.markQuotaExhausted(OPENAI);

    // An expired bound holds nobody back, so the repeat is news: it renews the
    // suppression rather than leave every process reading one that expired.
    expect(h.availability.quotaExhaustion(OPENAI))
      .toEqual({ exhaustedAtMs: NOW_MS + SAFE_RECHECK_MS, resetsAtMs: NOW_MS + 2 * SAFE_RECHECK_MS, hold: { kind: "usage_limit", stated: false } });
    expect(rowsFor(other, SUBJECT)).toEqual([expect.objectContaining({
      state: "exhausted",
      generation: 2,
      nextProbeAtMs: NOW_MS + 2 * SAFE_RECHECK_MS,
    })]);
  });

  test("a terminal ChatGPT frame repeated after its safe recheck expired renews the window", () => {
    const { authority, other } = seeded([]);
    const h = harness([], authority, [subscription("chatgpt", SUBJECT)]);
    h.availability.observeChatGptQuotaExhausted(CHATGPT, undefined);

    h.advance(SAFE_RECHECK_MS);
    h.availability.observeChatGptQuotaExhausted(CHATGPT, undefined);

    expect(rowsFor(other, SUBJECT)).toEqual([expect.objectContaining({
      window: "primary",
      state: "exhausted",
      generation: 2,
      nextProbeAtMs: NOW_MS + 2 * SAFE_RECHECK_MS,
    })]);
  });
});

describe("the selection linearization point", () => {
  const SUBJECT = "account-one";
  const OPENAI = subscription("openai_api", SUBJECT);

  test("reloads bound rows only when the authority revision changes", () => {
    const dbFile = tempDbFile();
    const backing = createAvailabilityAuthority({ dbFile });
    let snapshots = 0;
    const counting: AvailabilityAuthority = {
      ...backing,
      snapshotFor: (keys) => {
        snapshots += 1;
        return backing.snapshotFor(keys);
      },
    };
    const { availability } = harness([], counting, [subscription("openai_api", SUBJECT)]);
    availability.refreshProjection();
    expect(snapshots).toBe(1);

    availability.refreshProjection();
    availability.refreshProjection();
    expect(snapshots).toBe(1);

    createAvailabilityAuthority({ dbFile }).commit({
      scope: "account",
      profileId: "default",
      provider: "openai_api",
      candidateKey: accessProviderCandidateKey(OPENAI),
      window: "account",
      state: "exhausted",
      observedAtMs: NOW_MS,
      resetsAtMs: NOW_MS + 3_600_000,
      source: "terminal-quota-error",
      readGeneration: 0,
    });

    const nextRequest = harness([], counting, [subscription("openai_api", SUBJECT)]).availability;
    nextRequest.refreshProjection();
    expect(snapshots).toBe(2);
    expect(nextRequest.quotaExhaustion(OPENAI)?.resetsAtMs).toBe(NOW_MS + 3_600_000);
  });

  test("a refresh reads the accounts this binding spends from and no others", () => {
    const dbFile = tempDbFile();
    const other = createAvailabilityAuthority({ dbFile });
    for (const instanceId of [SUBJECT, "an-unrelated-account"]) {
      other.commit({
        scope: "account",
        profileId: "default",
        provider: "openai_api",
        candidateKey: accessProviderCandidateKey(subscription("openai_api", instanceId)),
        window: "account",
        state: "exhausted",
        observedAtMs: NOW_MS,
        resetsAtMs: NOW_MS + 3_600_000,
        source: "terminal-quota-error",
        readGeneration: 0,
      });
    }
    const backing = createAvailabilityAuthority({ dbFile });
    let asked: readonly AvailabilityKey[] = [];
    const watching: AvailabilityAuthority = {
      ...backing,
      snapshotFor: (keys) => {
        asked = keys;
        return backing.snapshotFor(keys);
      },
    };
    const { availability } = harness([], watching, [subscription("openai_api", SUBJECT)]);

    availability.refreshProjection();

    // The unrelated account is another client's business: this binding neither
    // queries nor decodes its row. Its own account reads both the quota
    // window and the provider's service row.
    expect(asked).toEqual([
      { scope: "account", profileId: "default", provider: "openai_api", candidateKey: accessProviderCandidateKey(OPENAI), window: "account" },
      { scope: "provider", provider: "openai_api", window: "service" },
    ]);
    expect(availability.quotaExhaustion(OPENAI)?.resetsAtMs).toBe(NOW_MS + 3_600_000);
  });
});

describe("availability owner disposal", () => {


  test("disposing the shared owner is idempotent, and a later request builds a fresh one", async () => {
    const first = getSharedProviderAvailability();
    expect(getSharedProviderAvailability()).toBe(first);

    await disposeSharedProviderAvailability();
    await disposeSharedProviderAvailability();

    expect(getSharedProviderAvailability()).not.toBe(first);
    await disposeSharedProviderAvailability();
  });
});
