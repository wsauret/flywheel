import { describe, expect, test } from "bun:test";
import type { SubscriptionSpendConsentRevision } from "../../../../src/infra/auth/subscription-spend-consent-store.js";
import { createSubscriptionSpendConsentCaptureCache } from "../../../../src/orchestration/subscription-spend-consent/capture-cache.js";

interface Capture {
  readonly decision: "accepted" | "declined"
  readonly authorizations: ReadonlyMap<string, string>
}

const accepted = Object.freeze<Capture>({ decision: "accepted", authorizations: new Map([["paid", "allowed"]]) });
const declined = Object.freeze<Capture>({ decision: "declined", authorizations: new Map() });
const content = (digest: string): SubscriptionSpendConsentRevision => ({ kind: "content", digest });
const accounts = Object.freeze({});

function revisionSequence(...revisions: readonly (SubscriptionSpendConsentRevision | Error)[]): () => SubscriptionSpendConsentRevision {
  let index = 0;
  return () => {
    const revision = revisions[Math.min(index, revisions.length - 1)];
    index += 1;
    if (revision instanceof Error) throw revision;
    if (revision === undefined) throw new Error("revision sequence is empty");
    return revision;
  };
}

describe("subscription spend consent capture cache", () => {
  test("reuses an unchanged capture without repeating the locked operation", async () => {
    const cache = createSubscriptionSpendConsentCaptureCache<Capture>();
    let captures = 0;
    const result = async () => cache.capture({
      profileDirectory: "/profiles/work",
      accountGeneration: () => accounts,
      readRevision: () => content("accepted"),
      lockedCapture: async () => { captures += 1; return accepted; },
    });

    expect(await result()).toBe(accepted);
    expect(await result()).toBe(accepted);
    expect(captures).toBe(1);
  });

  test("coalesces concurrent captures with identical initial authority", async () => {
    const cache = createSubscriptionSpendConsentCaptureCache<Capture>();
    let captures = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = () => cache.capture({
      profileDirectory: "/profiles/work",
      accountGeneration: () => accounts,
      readRevision: () => content("accepted"),
      lockedCapture: async () => { captures += 1; await gate; return accepted; },
    });
    const first = request();
    const second = request();
    release();
    expect(await Promise.all([first, second])).toEqual([accepted, accepted]);
    expect(captures).toBe(1);
  });

  test("does not coalesce captures with different authority or account generations", async () => {
    const cache = createSubscriptionSpendConsentCaptureCache<Capture>();
    let captures = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const request = (digest: string, generation = accounts) => cache.capture({
      profileDirectory: "/profiles/work",
      accountGeneration: () => generation,
      readRevision: () => content(digest),
      lockedCapture: async () => { captures += 1; await gate; return accepted; },
    });
    const pending = [request("a"), request("b"), request("b", {})];
    release();
    await Promise.all(pending);
    expect(captures).toBe(3);
  });

  test("clears a failed in-flight capture so a matching caller can retry", async () => {
    const cache = createSubscriptionSpendConsentCaptureCache<Capture>();
    let captures = 0;
    const request = () => cache.capture({
      profileDirectory: "/profiles/work",
      accountGeneration: () => accounts,
      readRevision: () => content("accepted"),
      lockedCapture: async () => { captures += 1; if (captures === 1) throw new Error("capture failed"); return accepted; },
    });
    await expect(request()).rejects.toThrow("capture failed");
    expect(await request()).toBe(accepted);
    expect(captures).toBe(2);
  });

  test("observes a cross-owner revoke on the next capture", async () => {
    const cache = createSubscriptionSpendConsentCaptureCache<Capture>();
    let current = accepted;
    let digest = "accepted";
    let captures = 0;
    const result = async () => cache.capture({
      profileDirectory: "/profiles/work",
      accountGeneration: () => accounts,
      readRevision: () => content(digest),
      lockedCapture: async () => { captures += 1; return current; },
    });

    expect(await result()).toBe(accepted);
    digest = "revoked";
    current = declined;
    const revoked = await result();
    expect(revoked.decision).toBe("declined");
    expect(revoked.authorizations.size).toBe(0);
    expect(captures).toBe(2);
  });

  test("does not cache a miss when the authority revision changes during capture", async () => {
    const cache = createSubscriptionSpendConsentCaptureCache<Capture>();
    let captures = 0;
    const readRevision = revisionSequence(content("before"), content("after"), content("after"), content("after"));
    const result = async () => cache.capture({
      profileDirectory: "/profiles/work",
      accountGeneration: () => accounts,
      readRevision,
      lockedCapture: async () => { captures += 1; return accepted; },
    });

    await result();
    await result();
    expect(captures).toBe(2);
  });

  test("missing or failed revision reads never return a prior accepted capture", async () => {
    const cache = createSubscriptionSpendConsentCaptureCache<Capture>();
    let current = accepted;
    let captures = 0;
    const capture = (readRevision: () => SubscriptionSpendConsentRevision) => cache.capture({
      profileDirectory: "/profiles/work",
      accountGeneration: () => accounts,
      readRevision,
      lockedCapture: async () => { captures += 1; return current; },
    });

    await capture(() => content("accepted"));
    current = declined;
    expect(await capture(() => ({ kind: "missing" }))).toBe(declined);
    expect(captures).toBe(2);
    current = accepted;
    await capture(() => content("accepted-again"));
    current = declined;
    expect(capture(revisionSequence(new Error("revision failed")))).rejects.toThrow("revision failed");
    expect(captures).toBe(3);
  });

  test("supports explicit profile-directory invalidation", async () => {
    const cache = createSubscriptionSpendConsentCaptureCache<Capture>();
    let captures = 0;
    const result = async () => cache.capture({
      profileDirectory: "/profiles/work",
      accountGeneration: () => accounts,
      readRevision: () => content("accepted"),
      lockedCapture: async () => { captures += 1; return accepted; },
    });

    await result();
    cache.invalidate("/profiles/work");
    await result();
    expect(captures).toBe(2);
  });
});
