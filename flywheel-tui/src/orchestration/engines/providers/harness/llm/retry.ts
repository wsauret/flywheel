/**
 * Retry helper with status-based non-retryable classification.
 *
 * Both Anthropic and OpenAI SDKs expose HTTP status codes on errors.
 * Retries on network errors, 408, 429, 5xx. Fails fast on 400, 401,
 * 403, 404 -- these mean the request itself is wrong.
 */

import { Log } from "../../../../../infra/log.js";
import { ContextLengthExceededError, OutputLengthExceededError, RetryableStreamError } from "./types.js";
import type { StreamEvent } from "./types.js";

const log = Log.create({ service: "llm-retry" });

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export const CLIENT_TIMEOUT_MS = 60_000;

function hasStatus(e: unknown): e is { status: number } {
  return (
    typeof e === "object" &&
    e !== null &&
    "status" in e &&
    typeof (e as { status: unknown }).status === "number"
  );
}

function hasHeaders(e: unknown): e is { headers: { get(name: string): string | null } } {
  return (
    typeof e === "object" &&
    e !== null &&
    "headers" in e &&
    typeof (e as { headers: unknown }).headers === "object" &&
    (e as { headers: unknown }).headers !== null &&
    typeof (e as { headers: { get?: unknown } }).headers.get === "function"
  );
}

export function isNonRetryable(err: unknown): boolean {
  if (err instanceof RetryableStreamError) return false;
  if (err instanceof ContextLengthExceededError) return true;
  if (err instanceof OutputLengthExceededError) return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;

  if (hasStatus(err)) {
    const { status } = err;
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      return true;
    }
  }
  return false;
}

function getRetryAfterMs(err: unknown): number | null {
  if (!hasHeaders(err)) return null;
  const value = err.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1_000;
  }
  return null;
}

interface RetryOptions {
  label?: string
  sleep?: (ms: number) => Promise<void>
}

export async function withRetry<T>(fn: () => Promise<T>, opts?: string | RetryOptions): Promise<T> {
  const label = typeof opts === "string" ? opts : opts?.label ?? "LLM"
  const sleep = (typeof opts === "object" && opts?.sleep) || Bun.sleep

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (isNonRetryable(err) || attempt === MAX_RETRIES - 1) throw err;

      const retryAfter = hasStatus(err) && err.status === 429 ? getRetryAfterMs(err) : null;
      const exponentialDelay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      const jitter = Math.random() * BASE_DELAY_MS * 0.5;
      const delay = retryAfter ?? exponentialDelay + jitter;

      log.warn(`${label} call failed (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${Math.round(delay)}ms`, {
        status: hasStatus(err) ? err.status : undefined,
        retryAfter: retryAfter ? Math.round(retryAfter) : undefined,
      });
      await sleep(delay);
    }
  }
  throw new Error("Unreachable");
}

interface IdleWatchdog {
  readonly timedOut: boolean;
  /** Override the default budget for this arming. Used to give a longer window
   *  for time-to-first-event (server preprocessing) than for in-stream idleness. */
  reset(timeoutMs?: number): void;
  cleanup(): void;
}

export function createIdleWatchdog(defaultTimeoutMs: number, onTimeout: () => void): IdleWatchdog {
  let _timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    get timedOut() { return _timedOut; },
    reset(timeoutMs?: number) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        _timedOut = true;
        onTimeout();
      }, timeoutMs ?? defaultTimeoutMs);
    },
    cleanup() {
      if (timer) clearTimeout(timer);
    },
  };
}

export async function* withRetryStream(
  fn: () => AsyncGenerator<StreamEvent>,
  label: string,
): AsyncGenerator<StreamEvent> {
  yield* await withRetry(async () => {
    const gen = fn();
    const first = await gen.next();
    return (async function* () {
      if (!first.done) {
        yield first.value;
        yield* gen;
      }
    })();
  }, label);
}
