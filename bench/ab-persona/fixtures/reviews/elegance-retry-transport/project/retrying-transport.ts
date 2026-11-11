import type { HttpRequest, HttpResponse, Transport } from "./transport.ts";

export interface RetryPolicy {
  /** Total tries, the first one included. */
  maxAttempts: number;
  /** Bound of the first backoff wait; each later bound doubles. */
  baseDelayMs: number;
  /** Upper bound on any single wait, including one a server asks for with Retry-After. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 10_000 };

/** Time and randomness. Tests pass their own so they run without real waits. */
export interface RetryClock {
  sleep(ms: number): Promise<void>;
  random(): number;
  now(): number;
}

const systemClock: RetryClock = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  now: Date.now,
};

/** Methods that are safe to send twice: GET only reads, and every PUT in the
 *  ingest API replaces a resource by its id. POST creates, so it never retries. */
const IDEMPOTENT_METHODS: ReadonlySet<HttpRequest["method"]> = new Set(["GET", "PUT"]);

/** Statuses that say "try again later" rather than "this request is wrong". */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * A Transport that retries transient failures of idempotent requests: network
 * failures and the statuses in RETRYABLE_STATUSES. Waits use capped
 * exponential backoff with full jitter, so many stations that fail together
 * do not retry together. When the response carries Retry-After, the wait is
 * what the server asks for, capped at maxDelayMs. After the last attempt the
 * caller gets the last response or network error unchanged.
 */
export class RetryingTransport implements Transport {
  constructor(
    private readonly inner: Transport,
    private readonly policy: RetryPolicy = DEFAULT_RETRY_POLICY,
    private readonly clock: RetryClock = systemClock,
  ) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    if (!IDEMPOTENT_METHODS.has(request.method)) return this.inner.send(request);
    for (let attempt = 1; ; attempt++) {
      const isLast = attempt >= this.policy.maxAttempts;
      let response: HttpResponse;
      try {
        response = await this.inner.send(request);
      } catch (error) {
        if (isLast) throw error;
        await this.clock.sleep(this.backoffMs(attempt));
        continue;
      }
      if (isLast || !RETRYABLE_STATUSES.has(response.status)) return response;
      await this.clock.sleep(this.retryAfterMs(response) ?? this.backoffMs(attempt));
    }
  }

  /** Full jitter: a random wait between zero and the capped exponential bound. */
  private backoffMs(attempt: number): number {
    const bound = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** (attempt - 1));
    return Math.floor(this.clock.random() * bound);
  }

  /** Retry-After holds either a number of seconds or an HTTP date (RFC 9110).
   *  A value that is neither is ignored, and backoff applies. */
  private retryAfterMs(response: HttpResponse): number | undefined {
    const value = response.headers["retry-after"]?.trim();
    if (value === undefined || value === "") return undefined;
    const waitMs = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - this.clock.now();
    if (Number.isNaN(waitMs)) return undefined;
    return Math.min(this.policy.maxDelayMs, Math.max(0, waitMs));
  }
}
