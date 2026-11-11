import { HttpError } from "./http.ts";

export const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 8_000;

/** Timeouts, throttling, server errors, and network failures are worth
 *  another attempt; any other client error will fail the same way again. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
  return error instanceof TypeError;
}

export function backoffMs(attempt: number, random: () => number): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return ceiling - Math.floor((random() * ceiling) / 2);
}

/** Run `operation` up to MAX_ATTEMPTS times, sleeping between attempts. */
export async function withRetry<T>(
  operation: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  random: () => number = Math.random,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error;
      await sleep(backoffMs(attempt, random));
    }
  }
}
