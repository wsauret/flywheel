import { describe, it, expect } from "bun:test";
import { retry, calculateDelay, withRetry, retryUntil } from "../src/utils/retry";
import type { RetryResult } from "../src/utils/retry";

// ---------------------------------------------------------------------------
// calculateDelay
// ---------------------------------------------------------------------------

describe("calculateDelay", () => {
  const baseOpts = {
    backoff: "exponential" as const,
    multiplier: 2,
    baseDelayMs: 1000,
    maxDelayMs: 120_000,
    jitter: false,
  };

  it("exponential backoff: attempt 1 = base delay", () => {
    const delay = calculateDelay(1, baseOpts);
    expect(delay).toBe(1000);
  });

  it("exponential backoff: attempt 2 = base * multiplier", () => {
    const delay = calculateDelay(2, baseOpts);
    expect(delay).toBe(2000);
  });

  it("exponential backoff: attempt 3 = base * multiplier^2", () => {
    const delay = calculateDelay(3, baseOpts);
    expect(delay).toBe(4000);
  });

  it("exponential backoff with multiplier 3", () => {
    const delay = calculateDelay(3, { ...baseOpts, multiplier: 3 });
    expect(delay).toBe(9000); // 1000 * 3^2
  });

  it("fixed backoff: always returns base delay", () => {
    const fixedOpts = { ...baseOpts, backoff: "fixed" as const };
    expect(calculateDelay(1, fixedOpts)).toBe(1000);
    expect(calculateDelay(5, fixedOpts)).toBe(1000);
    expect(calculateDelay(10, fixedOpts)).toBe(1000);
  });

  it("linear backoff: delay = baseDelayMs * attempt", () => {
    const linearOpts = { ...baseOpts, backoff: "linear" as const };
    expect(calculateDelay(1, linearOpts)).toBe(1000); // 1000 * 1
    expect(calculateDelay(2, linearOpts)).toBe(2000); // 1000 * 2
    expect(calculateDelay(3, linearOpts)).toBe(3000); // 1000 * 3
  });

  it("caps at maxDelayMs", () => {
    const delay = calculateDelay(20, baseOpts); // 1000 * 2^19 = huge
    expect(delay).toBe(120_000);
  });

  it("caps at 120s for rate-limit scenario", () => {
    const delay = calculateDelay(10, {
      ...baseOpts,
      baseDelayMs: 5000,
      maxDelayMs: 120_000,
    });
    expect(delay).toBeLessThanOrEqual(120_000);
  });

  it("jitter stays within ±25% bounds", () => {
    const jitterOpts = { ...baseOpts, jitter: true };
    const results = new Set<number>();
    for (let i = 0; i < 100; i++) {
      results.add(calculateDelay(1, jitterOpts));
    }
    // All values should be in [750, 1250] (±25% of 1000)
    for (const val of results) {
      expect(val).toBeGreaterThanOrEqual(750);
      expect(val).toBeLessThanOrEqual(1250);
    }
    // Should have some variance (not all the same)
    expect(results.size).toBeGreaterThan(1);
  });

  it("jitter does not exceed maxDelayMs", () => {
    const delay = calculateDelay(20, { ...baseOpts, jitter: true });
    expect(delay).toBeLessThanOrEqual(120_000);
  });
});

// ---------------------------------------------------------------------------
// retry<T>() — returns RetryResult<T>
// ---------------------------------------------------------------------------

describe("retry", () => {
  it("returns RetryResult with success on first attempt", async () => {
    const result = await retry(() => Promise.resolve(42), {
      maxRetries: 3,
      baseDelayMs: 1,
      jitter: false,
    });
    expect(result.success).toBe(true);
    expect(result.value).toBe(42);
    expect(result.attempts).toBe(1);
    expect(result.totalTime).toBeGreaterThanOrEqual(0);
  });

  it("retries on failure and eventually succeeds", async () => {
    let calls = 0;
    const result = await retry(
      () => {
        calls++;
        if (calls < 3) throw new Error("fail");
        return Promise.resolve("ok");
      },
      { maxRetries: 5, baseDelayMs: 1, jitter: false },
    );
    expect(result.success).toBe(true);
    expect(result.value).toBe("ok");
    expect(result.attempts).toBe(3);
    expect(calls).toBe(3);
  });

  it("returns failure result after maxRetries exhausted", async () => {
    let calls = 0;
    const result = await retry(
      () => {
        calls++;
        return Promise.reject(new Error("always fails"));
      },
      { maxRetries: 3, baseDelayMs: 1, jitter: false },
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("always fails");
    expect(result.attempts).toBe(4); // initial + 3 retries
    expect(calls).toBe(4);
  });

  it("returns failure immediately for non-retryable errors", async () => {
    let calls = 0;
    const result = await retry(
      () => {
        calls++;
        return Promise.reject(new Error("fatal"));
      },
      {
        maxRetries: 5,
        baseDelayMs: 1,
        jitter: false,
        isRetryable: () => false,
      },
    );
    expect(result.success).toBe(false);
    expect((result.error as Error).message).toBe("fatal");
    expect(result.attempts).toBe(1); // no retries
    expect(calls).toBe(1);
  });

  it("isRetryable predicate controls which errors are retried", async () => {
    let calls = 0;
    const result = await retry(
      () => {
        calls++;
        if (calls === 1) throw new Error("transient");
        if (calls === 2) throw new Error("fatal-error");
        return Promise.resolve("ok");
      },
      {
        maxRetries: 5,
        baseDelayMs: 1,
        jitter: false,
        isRetryable: (err) =>
          err instanceof Error && !err.message.includes("fatal"),
      },
    );
    expect(result.success).toBe(false);
    expect((result.error as Error).message).toBe("fatal-error");
    expect(calls).toBe(2); // first retried, second rejected
  });

  it("onRetry callback is called before each retry", async () => {
    const retryInfo: Array<{ attempt: number; error: unknown; delayMs: number }> = [];
    let calls = 0;

    await retry(
      () => {
        calls++;
        if (calls <= 2) throw new Error(`fail-${calls}`);
        return Promise.resolve("ok");
      },
      {
        maxRetries: 5,
        baseDelayMs: 1,
        jitter: false,
        onRetry: (attempt, error, delayMs) => {
          retryInfo.push({ attempt, error, delayMs });
        },
      },
    );

    expect(retryInfo).toHaveLength(2);
    expect(retryInfo[0]!.attempt).toBe(1);
    expect(retryInfo[1]!.attempt).toBe(2);
    expect((retryInfo[0]!.error as Error).message).toBe("fail-1");
    expect((retryInfo[1]!.error as Error).message).toBe("fail-2");
  });

  it("onRetry callback is an injection point — no global event bus import", async () => {
    // Verify that onRetry is purely a callback, not coupled to event bus
    const events: string[] = [];
    let calls = 0;

    // Simulate injecting event emission
    await retry(
      () => {
        calls++;
        if (calls <= 1) throw new Error("retry-me");
        return Promise.resolve("done");
      },
      {
        maxRetries: 2,
        baseDelayMs: 1,
        jitter: false,
        onRetry: (attempt, error) => {
          // Caller injects their own side-effects
          events.push(`worker:retrying attempt=${attempt} error=${(error as Error).message}`);
        },
      },
    );

    expect(events).toEqual(["worker:retrying attempt=1 error=retry-me"]);
  });

  it("exponential backoff with explicit multiplier", async () => {
    const delays: number[] = [];
    let calls = 0;

    await retry(
      () => {
        calls++;
        throw new Error("fail");
      },
      {
        maxRetries: 4,
        backoff: "exponential",
        multiplier: 2,
        baseDelayMs: 100,
        maxDelayMs: 120_000,
        jitter: false,
        onRetry: (_attempt, _error, delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    // delays should be: 100, 200, 400, 800
    expect(delays).toEqual([100, 200, 400, 800]);
  });

  it("respects maxDelayMs cap during retries", async () => {
    const delays: number[] = [];
    let calls = 0;

    await retry(
      () => {
        calls++;
        throw new Error("fail");
      },
      {
        maxRetries: 3,
        backoff: "exponential",
        multiplier: 10,
        baseDelayMs: 1, // use tiny delays so test doesn't wait
        maxDelayMs: 5,
        jitter: false,
        onRetry: (_attempt, _error, delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    // 1, 10->5, 100->5
    expect(delays).toEqual([1, 5, 5]);
  });

  it("fixed backoff strategy", async () => {
    const delays: number[] = [];
    let calls = 0;

    await retry(
      () => {
        calls++;
        throw new Error("fail");
      },
      {
        maxRetries: 3,
        backoff: "fixed",
        baseDelayMs: 50,
        jitter: false,
        onRetry: (_attempt, _error, delayMs) => {
          delays.push(delayMs);
        },
      },
    );

    expect(delays).toEqual([50, 50, 50]);
  });

  it("RetryResult includes attempts and totalTime", async () => {
    const result = await retry(() => Promise.resolve("fast"), {
      maxRetries: 3,
      baseDelayMs: 1,
      jitter: false,
    });
    expect(result.success).toBe(true);
    expect(result.attempts).toBe(1);
    expect(typeof result.totalTime).toBe("number");
    expect(result.totalTime).toBeGreaterThanOrEqual(0);
  });

  it("RetryResult on failure includes error and attempts", async () => {
    const result = await retry(
      () => Promise.reject(new Error("boom")),
      { maxRetries: 2, baseDelayMs: 1, jitter: false },
    );
    expect(result.success).toBe(false);
    expect(result.value).toBeUndefined();
    expect((result.error as Error).message).toBe("boom");
    expect(result.attempts).toBe(3); // 1 initial + 2 retries
    expect(result.totalTime).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// withRetry()
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  it("wraps a function and returns a retryable version", async () => {
    let calls = 0;
    const fn = async (x: number) => {
      calls++;
      if (calls < 2) throw new Error("fail");
      return x * 2;
    };

    const retryableFn = withRetry(fn as (...args: unknown[]) => Promise<unknown>, {
      maxRetries: 3,
      baseDelayMs: 1,
      jitter: false,
    });

    const result = await retryableFn(21);
    expect(result.success).toBe(true);
    expect(result.value).toBe(42);
    expect(result.attempts).toBe(2);
  });

  it("returns failure result when all retries exhausted", async () => {
    const fn = async () => {
      throw new Error("always fails");
    };

    const retryableFn = withRetry(fn as (...args: unknown[]) => Promise<unknown>, {
      maxRetries: 2,
      baseDelayMs: 1,
      jitter: false,
    });

    const result = await retryableFn();
    expect(result.success).toBe(false);
    expect((result.error as Error).message).toBe("always fails");
  });
});

// ---------------------------------------------------------------------------
// retryUntil()
// ---------------------------------------------------------------------------

describe("retryUntil", () => {
  it("polls with fixed interval until condition is met", async () => {
    let calls = 0;
    const result = await retryUntil(
      async () => {
        calls++;
        return calls;
      },
      (value) => value >= 3,
      { maxRetries: 5, pollingInterval: 1, jitter: false },
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe(3);
    expect(calls).toBe(3);
  });

  it("returns last value even on failure (partial results)", async () => {
    let calls = 0;
    const result = await retryUntil(
      async () => {
        calls++;
        return { progress: calls * 10 };
      },
      (value) => value.progress >= 100, // never met within retries
      { maxRetries: 3, pollingInterval: 1, jitter: false },
    );

    expect(result.success).toBe(false);
    // Should have the last value despite failure
    expect(result.value).toBeDefined();
    expect(result.value!.progress).toBe(40); // 4 attempts (initial + 3 retries)
  });

  it("succeeds on first attempt if condition is immediately met", async () => {
    const result = await retryUntil(
      async () => 42,
      (value) => value === 42,
      { maxRetries: 3, pollingInterval: 1, jitter: false },
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe(42);
    expect(result.attempts).toBe(1);
  });
});
