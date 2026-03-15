/**
 * Generic retry utility with exponential/fixed/linear backoff, jitter, and injection points.
 *
 * The `onRetry` callback is a pure injection point — callers wire in event emission
 * or logging; this module has no event bus dependency.
 */

export type BackoffStrategy = "exponential" | "fixed" | "linear";

export interface RetryOptions {
  /** Maximum number of retry attempts (not counting the initial call). */
  maxRetries: number;
  /** Backoff strategy. Default: "exponential". */
  backoff?: BackoffStrategy;
  /** Multiplier for exponential backoff. Default: 2. */
  multiplier?: number;
  /** Base delay between retries in milliseconds. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay cap in milliseconds. Default: 120_000 (2 min). */
  maxDelayMs?: number;
  /** Whether to apply jitter (±25% random). Default: true. */
  jitter?: boolean;
  /** Predicate to decide if an error is retryable. Default: always true. */
  isRetryable?: (error: unknown) => boolean;
  /** Called before each retry. Pure callback — inject event emission here. */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

/**
 * Result of a retry operation.
 */
export interface RetryResult<T> {
  /** Whether the operation succeeded. */
  success: boolean;
  /** Result value if successful. */
  value?: T;
  /** Last error if failed. */
  error?: unknown;
  /** Total number of attempts made. */
  attempts: number;
  /** Total time spent in milliseconds. */
  totalTime: number;
}

/**
 * Calculate delay for a given attempt.
 */
export function calculateDelay(
  attempt: number,
  opts: {
    backoff: BackoffStrategy;
    multiplier: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitter: boolean;
  },
): number {
  let delay: number;
  switch (opts.backoff) {
    case "exponential":
      delay = opts.baseDelayMs * Math.pow(opts.multiplier, attempt - 1);
      break;
    case "linear":
      delay = opts.baseDelayMs * attempt;
      break;
    case "fixed":
    default:
      delay = opts.baseDelayMs;
      break;
  }

  // Cap at maxDelayMs before jitter
  delay = Math.min(delay, opts.maxDelayMs);

  // Apply ±25% jitter
  if (opts.jitter) {
    const jitterFactor = 0.75 + Math.random() * 0.5; // [0.75, 1.25]
    delay = Math.floor(delay * jitterFactor);
  }

  // Final cap after jitter
  return Math.min(delay, opts.maxDelayMs);
}

/**
 * Retry an async operation with configurable backoff and jitter.
 *
 * Returns a `RetryResult<T>` that always resolves (never throws).
 * Callers must check `result.success` to determine if the operation succeeded.
 *
 * @param fn - The async operation to retry.
 * @param options - Retry configuration.
 * @returns A RetryResult indicating success/failure, value, error, attempts, and totalTime.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<RetryResult<T>> {
  const {
    maxRetries,
    backoff = "exponential",
    multiplier = 2,
    baseDelayMs = 1000,
    maxDelayMs = 120_000,
    jitter = true,
    isRetryable = () => true,
    onRetry,
  } = options;

  let lastError: unknown;
  let attempts = 0;
  const startTime = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1;
    try {
      const value = await fn();
      return {
        success: true,
        value,
        attempts,
        totalTime: Date.now() - startTime,
      };
    } catch (error) {
      lastError = error;

      // If we've used all retries or the error is non-retryable, stop
      if (attempt >= maxRetries || !isRetryable(error)) {
        break;
      }

      const delayMs = calculateDelay(attempt + 1, {
        backoff,
        multiplier,
        baseDelayMs,
        maxDelayMs,
        jitter,
      });

      onRetry?.(attempt + 1, error, delayMs);

      await sleep(delayMs);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts,
    totalTime: Date.now() - startTime,
  };
}

/**
 * Create a retryable version of a function.
 *
 * Wraps any async function so that calling the returned function
 * automatically retries according to the given options.
 */
export function withRetry<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  options: RetryOptions = { maxRetries: 3 },
): (...args: Parameters<T>) => Promise<RetryResult<Awaited<ReturnType<T>>>> {
  return async (...args: Parameters<T>) => {
    return retry(
      () => fn(...args) as Promise<Awaited<ReturnType<T>>>,
      options,
    );
  };
}

/**
 * Retry with a condition function — polls until condition is met.
 *
 * Unlike `retry()`, this does not require `fn` to throw. Instead, it
 * checks `condition(result)` after each successful call and retries
 * (with a fixed polling interval) if the condition is not met.
 *
 * Returns the last value even on failure (for partial results).
 */
export async function retryUntil<T>(
  fn: () => Promise<T>,
  condition: (result: T) => boolean,
  options: RetryOptions & { pollingInterval?: number } = { maxRetries: 3 },
): Promise<RetryResult<T>> {
  const { pollingInterval = 1000, ...retryOptions } = options;

  let lastValue: T | undefined;

  const result = await retry<T>(
    async () => {
      const value = await fn();
      lastValue = value;
      if (!condition(value)) {
        throw new Error("Condition not met");
      }
      return value;
    },
    {
      ...retryOptions,
      backoff: "fixed",
      baseDelayMs: pollingInterval,
    },
  );

  // If failed but we have a last value, include it
  if (!result.success && lastValue !== undefined) {
    return {
      ...result,
      value: lastValue,
    };
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
