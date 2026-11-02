import { describe, expect, test } from "bun:test";
import { accessProviderCandidateKey } from "../../../../../src/infra/llm/access-provider.js";
import { createProviderAvailability } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability.js";
import { subscription, availabilityFixtures } from "./_provider-availability-harness.js";

const { tempDbFile, createAuthority: createAvailabilityAuthority } = availabilityFixtures();

const CANDIDATE = subscription("openai_api", "account-one");
const KEY = { scope: "account", profileId: "default", provider: "openai_api", candidateKey: accessProviderCandidateKey(CANDIDATE), window: "account" } as const;

function seedPending(nowMs: number, leaseMs: number) {
  const dbFile = tempDbFile();
  const claimant = createAvailabilityAuthority({ dbFile });
  claimant.commit({ ...KEY, state: "exhausted", observedAtMs: 1, nextProbeAtMs: 2, source: "test", readGeneration: 0 });
  claimant.claimProbe({ ...KEY, nowMs, leaseMs });
  return { claimant, authority: createAvailabilityAuthority({ dbFile }) };
}

describe("provider availability revision wait", () => {
  test("reloads immediately when the authority revision already changed", async () => {
    const nowMs = 1_000;
    let sleeps = 0;
    let snapshots = 0;
    const { claimant, authority: backing } = seedPending(nowMs, 1_000);
    const authority = { ...backing, snapshotFor: (keys: Parameters<typeof backing.snapshotFor>[0]) => {
      snapshots += 1;
      return backing.snapshotFor(keys);
    } };
    const availability = createProviderAvailability({ authority, now: () => nowMs, sleep: async () => { sleeps += 1 } }).forCandidates("default", [CANDIDATE]);
    availability.refreshProjection();
    const pending = availability.genericQuotaStanding(CANDIDATE);
    if (pending.kind !== "recheck_pending") throw new Error("expected pending");
    claimant.commit({ ...KEY, state: "live", observedAtMs: 3, source: "test", readGeneration: 1, fence: 1 });

    await availability.waitForChange(pending, new AbortController().signal);

    expect(sleeps).toBe(0);
    expect(snapshots).toBe(2);
    expect(availability.genericQuotaStanding(CANDIDATE)).toEqual({ kind: "live" });
  });

  test("checks at 250ms intervals and reloads bound keys at the deadline", async () => {
    let nowMs = 1_000;
    const sleeps: number[] = [];
    let snapshots = 0;
    const { authority: backing } = seedPending(nowMs, 600);
    const authority = { ...backing, snapshotFor: (keys: Parameters<typeof backing.snapshotFor>[0]) => {
      snapshots += 1;
      return backing.snapshotFor(keys);
    } };
    const availability = createProviderAvailability({
      authority,
      now: () => nowMs,
      sleep: async (ms) => { sleeps.push(ms); nowMs += ms },
    }).forCandidates("default", [CANDIDATE]);
    availability.refreshProjection();
    const pending = availability.genericQuotaStanding(CANDIDATE);
    if (pending.kind !== "recheck_pending") throw new Error("expected pending");

    await availability.waitForChange(pending, new AbortController().signal);

    expect(sleeps).toEqual([250, 250, 100]);
    expect(snapshots).toBe(2);
    expect(availability.genericQuotaStanding(CANDIDATE)).toEqual({ kind: "probe_due" });
  });

  test("aborts without releasing the peer lease", async () => {
    let releases = 0;
    let sleepSignal: AbortSignal | undefined;
    const { authority: backing } = seedPending(1_000, 1_000);
    const authority = { ...backing, releaseProbe: (...args: Parameters<typeof backing.releaseProbe>) => {
      releases += 1;
      return backing.releaseProbe(...args);
    } };
    const availability = createProviderAvailability({
      authority,
      now: () => 1_000,
      sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => {
        sleepSignal = signal;
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    }).forCandidates("default", [CANDIDATE]);
    availability.refreshProjection();
    const pending = availability.genericQuotaStanding(CANDIDATE);
    if (pending.kind !== "recheck_pending") throw new Error("expected pending");
    const abort = new AbortController();

    const waiting = availability.waitForChange(pending, abort.signal);
    abort.abort(new DOMException("stopped", "AbortError"));

    await expect(waiting).rejects.toHaveProperty("name", "AbortError");
    expect(releases).toBe(0);
    expect(sleepSignal?.aborted).toBe(true);
  });

  test("coalesces concurrent waiters while one abort detaches independently", async () => {
    let nowMs = 1_000;
    let revisionReads = 0;
    let sleeps = 0;
    let sleepSignal: AbortSignal | undefined;
    const gate = Promise.withResolvers<void>();
    const { authority: backing } = seedPending(nowMs, 500);
    const authority = {
      ...backing,
      revision: () => { revisionReads += 1; return backing.revision(); },
    };
    const owner = createProviderAvailability({
      authority,
      now: () => nowMs,
      sleep: async (ms, signal) => { sleepSignal = signal; sleeps += 1; await gate.promise; nowMs += ms; },
    });
    const first = owner.forCandidates("default", [CANDIDATE]);
    const second = owner.forCandidates("default", [CANDIDATE]);
    first.refreshProjection();
    second.refreshProjection();
    const standing = first.genericQuotaStanding(CANDIDATE);
    if (standing.kind !== "recheck_pending") throw new Error("expected pending");
    const abort = new AbortController();
    const detached = first.waitForChange(standing, abort.signal);
    const retained = second.waitForChange(standing, new AbortController().signal);
    abort.abort(new DOMException("stopped", "AbortError"));
    await expect(detached).rejects.toHaveProperty("name", "AbortError");
    expect(sleeps).toBe(1);
    expect(revisionReads).toBe(1);
    expect(sleepSignal?.aborted).toBe(false);
    gate.resolve();
    await retained;
    expect(sleeps).toBe(2);
    expect(revisionReads).toBe(3);
  });

  test("does not start polling for an already aborted waiter", async () => {
    let revisionReads = 0;
    const { authority: backing } = seedPending(1_000, 500);
    const owner = createProviderAvailability({
      authority: { ...backing, revision: () => { revisionReads += 1; return backing.revision(); } },
      now: () => 1_000,
      sleep: () => new Promise<void>(() => {}),
    });
    const availability = owner.forCandidates("default", [CANDIDATE]);
    availability.refreshProjection();
    const pending = availability.genericQuotaStanding(CANDIDATE);
    if (pending.kind !== "recheck_pending") throw new Error("expected pending");
    const abort = new AbortController();
    abort.abort();
    await expect(availability.waitForChange(pending, abort.signal)).rejects.toHaveProperty("name", "AbortError");
    expect(revisionReads).toBe(0);
    await owner.dispose();
  });

  test("disposal cancels and joins every wait before closing the authority", async () => {
    let closed = false;
    let closes = 0;
    let readsAfterClose = 0;
    let revisionReads = 0;
    let snapshots = 0;
    const sleeps: AbortSignal[] = [];
    const gate = Promise.withResolvers<void>();
    const { claimant, authority: backing } = seedPending(1_000, 500);
    const owner = createProviderAvailability({
      authority: {
        ...backing,
        revision: () => {
          revisionReads += 1;
          if (closed) readsAfterClose += 1;
          return backing.revision();
        },
        snapshotFor: (keys) => {
          snapshots += 1;
          if (closed) readsAfterClose += 1;
          return backing.snapshotFor(keys);
        },
        dispose: async () => { closes += 1; closed = true; await backing.dispose(); },
      },
      now: () => 1_000,
      sleep: async (_ms, signal) => { sleeps.push(signal); await gate.promise; },
    });
    const availability = owner.forCandidates("default", [CANDIDATE]);
    availability.refreshProjection();
    const pending = availability.genericQuotaStanding(CANDIDATE);
    if (pending.kind !== "recheck_pending") throw new Error("expected pending");
    const waits = [pending, { ...pending, untilMs: pending.untilMs + 1 }].map((standing) =>
      availability.waitForChange(standing, new AbortController().signal).then(() => undefined, (error: unknown) => error),
    );
    let disposed = false;
    let disposedAgain = false;
    const disposal = owner.dispose().then(() => { disposed = true; });
    const repeated = owner.dispose().then(() => { disposedAgain = true; });
    try {
      expect(sleeps).toHaveLength(2);
      expect(sleeps.every((signal) => signal.aborted)).toBe(true);
      await Promise.resolve();
      expect(disposed).toBe(false);
      expect(disposedAgain).toBe(false);
      expect(closed).toBe(false);
      await expect(availability.waitForChange(pending, new AbortController().signal)).rejects.toHaveProperty("name", "QuotaCoordination");
    } finally {
      gate.resolve();
      await Promise.all([disposal, repeated, ...waits]);
    }
    expect(closes).toBe(1);
    expect(readsAfterClose).toBe(0);
    expect(revisionReads).toBe(2);
    expect(snapshots).toBe(1);
    expect((await Promise.all(waits)).every((error) => error instanceof Error)).toBe(true);
    expect(claimant.snapshotFor([KEY]).rows[0]?.leaseExpiresAtMs).toBe(1_500);
    await claimant.dispose();
  });

  test("a new waiter joins only after the abandoned poll settles", async () => {
    const gate = Promise.withResolvers<void>();
    const sleeps: AbortSignal[] = [];
    const { claimant, authority } = seedPending(1_000, 500);
    const owner = createProviderAvailability({
      authority,
      now: () => 1_000,
      sleep: async (_ms, signal) => { sleeps.push(signal); await gate.promise; },
    });
    const availability = owner.forCandidates("default", [CANDIDATE]);
    availability.refreshProjection();
    const pending = availability.genericQuotaStanding(CANDIDATE);
    if (pending.kind !== "recheck_pending") throw new Error("expected pending");
    const abort = new AbortController();
    const first = availability.waitForChange(pending, abort.signal);
    abort.abort();
    await expect(first).rejects.toHaveProperty("name", "AbortError");
    expect(sleeps[0]?.aborted).toBe(true);
    let resumed = false;
    const second = availability.waitForChange(pending, new AbortController().signal).then(() => { resumed = true; });
    await Promise.resolve();
    expect(sleeps).toHaveLength(1);
    expect(resumed).toBe(false);
    claimant.commit({ ...KEY, state: "live", observedAtMs: 3, source: "test", readGeneration: 1, fence: 1 });
    gate.resolve();
    await second;
    expect(availability.genericQuotaStanding(CANDIDATE)).toEqual({ kind: "live" });
    expect(sleeps).toHaveLength(1);
    await owner.dispose();
    await claimant.dispose();
  });
});
