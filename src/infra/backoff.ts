export interface BackoffOptions {
  /** The first attempt's exponential window (attempt 0). */
  readonly baseMs: number
  /** Ceiling on the exponential window, so the delay never runs away. */
  readonly maxMs: number
  /** Per-attempt exponential growth factor. */
  readonly factor: number
  /** Injectable [0, 1) source; defaults to Math.random. Injected in tests. */
  readonly random?: () => number
}

/** Full-jitter exponential backoff (AWS "Exponential Backoff and Jitter"): the
 *  exponential window doubles per attempt up to maxMs, and the actual delay is a
 *  uniform sample in [0, window]. Full jitter (vs equal/decorrelated) spreads a
 *  reconnect storm across the widest range, which is what we want when many
 *  clients race to re-subscribe after one outage. Pure — randomness is injected
 *  so the schedule is deterministic under test. */
export function computeBackoffMs(attempt: number, options: BackoffOptions): number {
  const window = Math.min(options.maxMs, options.baseMs * options.factor ** attempt)
  return (options.random ?? Math.random)() * window
}