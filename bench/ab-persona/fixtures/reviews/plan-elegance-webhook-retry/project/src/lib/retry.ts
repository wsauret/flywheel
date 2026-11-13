export interface RetryOptions {
  /** Total tries, including the first. */
  readonly attempts: number;
  /** Delay before the second try; each later delay doubles, with up to 20% random jitter. */
  readonly baseDelayMs: number;
  /** Errors for which this returns false are thrown at once. Every error is retried when it is absent. */
  readonly isRetryable?: (error: unknown) => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Runs `operation` until it resolves or the tries run out, then throws the last error. */
export async function withRetry<T>(operation: () => Promise<T>, options: RetryOptions): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
  let lastError: unknown;
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (options.isRetryable !== undefined && !options.isRetryable(error)) throw error;
      if (attempt + 1 < options.attempts) {
        const delay = options.baseDelayMs * 2 ** attempt;
        await sleep(delay + Math.random() * delay * 0.2);
      }
    }
  }
  throw lastError;
}
