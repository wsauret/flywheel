// Backoff policy for retryable stream errors. Kept separate from the loop so the
// retry math stays unit-testable and the loop body shows only decision flow.

import type { RetryableStreamError } from "./llm/types.js";

export const MAX_STREAM_RETRIES = 5;

const TRANSIENT_RETRY_BASE_MS = 500;
const RATE_LIMIT_MIN_MS = 5_000;
const RATE_LIMIT_MAX_MS = 30_000;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;

export function streamRetryBackoff(attempt: number, err: RetryableStreamError): number {
  switch (err.kind) {
    case "transient":
      return TRANSIENT_RETRY_BASE_MS + Math.random() * TRANSIENT_RETRY_BASE_MS;
    case "rate_limit": {
      const exponential = Math.min(RATE_LIMIT_MIN_MS * 2 ** (attempt - 1), RATE_LIMIT_MAX_MS);
      return exponential + exponential * 0.2 * Math.random();
    }
    case "overload":
    case "unknown": {
      const exponential = Math.min(DEFAULT_RETRY_BASE_MS * 2 ** (attempt - 1), DEFAULT_RETRY_MAX_MS);
      return exponential + Math.random() * DEFAULT_RETRY_BASE_MS * 0.5;
    }
  }
}
