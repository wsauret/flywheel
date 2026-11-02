import { describe, expect, test } from "bun:test";
import {
  invokeProviderAttempt,
  normalizeProviderAttemptIterator,
} from "../../../../../src/orchestration/agent-runtime/llm/provider-attempt-boundary.js";
import { isProviderAttributedFailure, ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";

const failures: readonly [Error, ProviderAttemptFailure["failure"]["_tag"]][] = [
  [new Error("socket hang up"), "TransientNetworkFailure"],
  [new Error("SDK operation failed", { cause: Object.assign(new Error("Payment required"), { status: 402 }) }), "QuotaExhaustedFailure"],
  [new Error("SDK operation failed", { cause: Object.assign(new Error("You exceeded your current quota. Add credits."), { status: 429, code: "insufficient_quota" }) }), "QuotaExhaustedFailure"],
  [Object.assign(new Error("You exceeded your current quota. Add credits."), { code: "insufficient_quota" }), "QuotaExhaustedFailure"],
];

const normalizedFailures: readonly [Error, ProviderAttemptFailure["failure"]["_tag"]][] = [
  [Object.assign(new TypeError("The socket connection was closed unexpectedly."), { code: "ECONNRESET" }), "TransientNetworkFailure"],
  [Object.assign(new Error("Rate limit exceeded. Too many requests."), { code: "rate_limit_exceeded" }), "RateLimitFailure"],
  [Object.assign(new Error("Overloaded"), { type: "overloaded_error" }), "OverloadedFailure"],
];
for (const [error, tag] of normalizedFailures) {
  for (const wrapped of [false, true]) {
    const cause: Error = wrapped ? new Error("SDK operation failed", { cause: error }) : error;
    for (const boundary of ["call", "stream"] as const) {
      test(`preserves ${tag} and attribution through ${boundary}: ${cause.message}`, async () => {
        const failure = await (boundary === "call"
          ? invokeProviderAttempt(async () => { throw cause; })
          : normalizeProviderAttemptIterator({ async *[Symbol.asyncIterator]() { throw cause; } }).next()
        ).catch((received: unknown) => received);
        expect(failure).toBeInstanceOf(ProviderAttemptFailure);
        if (!(failure instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome");
        expect(failure.failure._tag).toBe(tag);
        expect(failure.cause).toBe(cause);
        expect(failure.failure.cause).toBe(error);
        expect(isProviderAttributedFailure(failure.failure)).toBe(tag !== "TransientNetworkFailure");
      });
    }
  }
}

describe("invokeProviderAttempt", () => {
  test.each(failures)("normalizes a rejected SDK invocation (%s, %s)", async (cause, tag) => {
    const failure = await invokeProviderAttempt(async () => { throw cause; }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderAttemptFailure);
    if (!(failure instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome");
    expect(failure.failure._tag).toBe(tag);
    expect(failure.cause).toBe(cause);
  });
});

describe("normalizeProviderAttemptIterator", () => {
  test.each(failures)("normalizes iterator.next failures (%s, %s)", async (cause, tag) => {
    const iterator = normalizeProviderAttemptIterator({
      [Symbol.asyncIterator]() {
        return {
          next: () => Promise.reject(cause),
        };
      },
    });

    const failure = await iterator.next().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderAttemptFailure);
    if (!(failure instanceof ProviderAttemptFailure)) throw new Error("Missing provider outcome");
    expect(failure.failure._tag).toBe(tag);
    expect(failure.cause).toBe(cause);
  });

  test("does not catch caller event conversion", async () => {
    const conversionFailure = new Error("invalid provider event");
    const iterator = normalizeProviderAttemptIterator({
      async *[Symbol.asyncIterator]() {
        yield { type: "event" };
      },
    });

    const event = (await iterator.next()).value;
    expect(() => {
      if (event) throw conversionFailure;
    }).toThrow(conversionFailure);
  });

  test("forwards return for cleanup and throw for cancellation without normalization", async () => {
    const cleanup: IteratorReturnResult<undefined> = { value: undefined, done: true };
    const cancellation = new Error("caller cancellation");
    let receivedCancellation: unknown;
    const iterator = normalizeProviderAttemptIterator({
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ value: "event", done: false }),
          return: async () => cleanup,
          throw: async (error?: unknown) => {
            receivedCancellation = error;
            throw error;
          },
        };
      },
    });

    if (!iterator.return || !iterator.throw) throw new Error("iterator cleanup methods are missing");
    await expect(iterator.return()).resolves.toBe(cleanup);
    await expect(iterator.throw(cancellation)).rejects.toBe(cancellation);
    expect(receivedCancellation).toBe(cancellation);
  });
});
