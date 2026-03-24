/**
 * RetryPolicy — exponential backoff retry logic.
 *
 * Used by the Scheduler to retry failed tasks before marking
 * them as permanently failed. Supports configurable backoff,
 * max retries, and jitter.
 */

export interface RetryOptions {
  /** Maximum number of retries (0 = no retries) */
  maxRetries: number;
  /** Base delay between retries in ms. Default: 1000 */
  baseDelayMs?: number;
  /** Maximum delay between retries in ms. Default: 30000 */
  maxDelayMs?: number;
  /** Add random jitter to delay. Default: true */
  jitter?: boolean;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  jitter: true,
};

export class RetryPolicy {
  private readonly options: Required<RetryOptions>;

  constructor(options?: Partial<RetryOptions>) {
    this.options = {
      maxRetries: options?.maxRetries ?? DEFAULT_RETRY_OPTIONS.maxRetries,
      baseDelayMs: options?.baseDelayMs ?? DEFAULT_RETRY_OPTIONS.baseDelayMs!,
      maxDelayMs: options?.maxDelayMs ?? DEFAULT_RETRY_OPTIONS.maxDelayMs!,
      jitter: options?.jitter ?? DEFAULT_RETRY_OPTIONS.jitter!,
    };
  }

  /**
   * Execute a function with retry logic.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.options.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt >= this.options.maxRetries) {
          break;
        }

        const delay = this.calculateDelay(attempt);
        await this.sleep(delay);
      }
    }

    throw lastError;
  }

  /**
   * Calculate delay for a given attempt using exponential backoff.
   */
  calculateDelay(attempt: number): number {
    const exponential = this.options.baseDelayMs * Math.pow(2, attempt);
    const capped = Math.min(exponential, this.options.maxDelayMs);

    if (this.options.jitter) {
      return capped * (0.5 + Math.random() * 0.5);
    }

    return capped;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
