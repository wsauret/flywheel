import { expect, test } from "bun:test";
import { withRetry } from "../src/lib/retry";

test("withRetry retries until the operation resolves", async () => {
  let calls = 0;
  const delays: number[] = [];
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) throw new Error("flaky");
    return "done";
  }, { attempts: 5, baseDelayMs: 100, sleep: async (ms) => { delays.push(ms); } });
  expect(result).toBe("done");
  expect(calls).toBe(3);
  expect(delays.length).toBe(2);
});

test("a non-retryable error is thrown at once", async () => {
  let calls = 0;
  const run = withRetry(async () => { calls++; throw new Error("fatal"); }, { attempts: 5, baseDelayMs: 1, isRetryable: () => false });
  await expect(run).rejects.toThrow("fatal");
  expect(calls).toBe(1);
});
