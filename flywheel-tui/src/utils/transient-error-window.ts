/**
 * Transient error rate tracker.
 *
 * Tracks errors within a sliding time window. When the error count exceeds
 * a threshold within the window, signals that the process should shut down.
 *
 * Usage:
 *   const window = new TransientErrorWindow({ maxErrors: 50, windowMs: 60_000 })
 *   if (!window.recordError()) {
 *     // threshold exceeded — trigger shutdown
 *   }
 */

export interface TransientErrorWindowOptions {
  /** Maximum errors allowed within the window before triggering shutdown. Default: 50. */
  maxErrors?: number
  /** Time window in milliseconds. Default: 60_000 (1 minute). */
  windowMs?: number
}

export class TransientErrorWindow {
  private readonly maxErrors: number
  private readonly windowMs: number
  private timestamps: number[] = []

  constructor(opts: TransientErrorWindowOptions = {}) {
    this.maxErrors = opts.maxErrors ?? 50
    this.windowMs = opts.windowMs ?? 60_000
  }

  /**
   * Record an error occurrence.
   * @returns `true` if within threshold (error survived), `false` if threshold exceeded (trigger shutdown).
   */
  recordError(): boolean {
    const now = Date.now()
    // Prune timestamps outside the window
    const cutoff = now - this.windowMs
    this.timestamps = this.timestamps.filter((t) => t > cutoff)
    this.timestamps.push(now)
    return this.timestamps.length <= this.maxErrors
  }

  /** Current error count within the active window. */
  get count(): number {
    const cutoff = Date.now() - this.windowMs
    this.timestamps = this.timestamps.filter((t) => t > cutoff)
    return this.timestamps.length
  }
}
