/**
 * Shared HTTP posting for web search providers: JSON POST with a bounded
 * timeout, retry on transient gateway statuses, and WebSearchError for
 * timeouts. Status semantics stay with each provider; this module only owns
 * the mechanics every provider repeats.
 */

import { WebSearchError } from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const TRANSIENT_STATUS = new Set([502, 503, 504]);
const MAX_TRANSIENT_RETRIES = 2;

interface HttpHeaders {
  [name: string]: string;
}
export interface PostJsonOptions {
  headers: HttpHeaders;
  body: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Transient-retry pause; tests shrink it so retries stay fast. */
  retryDelayMs?: number;
}

export async function postJson(endpoint: string, options: PostJsonOptions): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const retryDelayMs = options.retryDelayMs ?? 500;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
    : AbortSignal.timeout(REQUEST_TIMEOUT_MS);

  let attempt = 0;
  for (;;) {
    attempt += 1;
    let response: Response;
    try {
      response = await fetchImpl(endpoint, { method: "POST", headers: options.headers, body: options.body, signal });
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new WebSearchError(`web search timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }
    if (!TRANSIENT_STATUS.has(response.status) || attempt > MAX_TRANSIENT_RETRIES) return response;
    await Bun.sleep(retryDelayMs * attempt);
  }
}
