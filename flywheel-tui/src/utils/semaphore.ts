/**
 * Priority-based concurrency semaphore.
 *
 * Limits concurrent access to a shared resource with priority ordering.
 * Lower priority numbers drain first (0 = focused, 1 = background).
 *
 * Usage:
 *   const sem = new PrioritySemaphore(3)
 *   const release = await sem.acquire(0) // priority 0 (focused)
 *   try {
 *     // ... do work ...
 *   } finally {
 *     release()
 *   }
 *
 * Call `reset()` to reject all pending waiters (e.g. on shutdown).
 */

interface Waiter {
  priority: number
  resolve: (release: () => void) => void
  reject: (reason: unknown) => void
}

export class PrioritySemaphore {
  private running = 0
  private readonly queue: Waiter[] = []

  constructor(private readonly maxConcurrent: number = 3) {}

  /**
   * Acquire a slot. Returns a release function.
   * If no slots available, queues the caller by priority.
   * Priority 0 drains before priority 1 (lower = higher priority).
   */
  acquire(priority: number = 0): Promise<() => void> {
    if (this.running < this.maxConcurrent) {
      this.running++
      return Promise.resolve(this.createRelease())
    }

    return new Promise<() => void>((resolve, reject) => {
      this.queue.push({ priority, resolve, reject })
      // Keep queue sorted by priority (stable: lower priority number first)
      this.queue.sort((a, b) => a.priority - b.priority)
    })
  }

  /**
   * Reject all pending waiters and reset the running count.
   * Active holders are unaffected — their release functions still work
   * but won't drain the (now-empty) queue.
   */
  reset(): void {
    const pending = this.queue.splice(0)
    for (const waiter of pending) {
      waiter.reject(new Error("Semaphore reset"))
    }
    this.running = 0
  }

  /** Number of currently running slots. */
  get activeCount(): number {
    return this.running
  }

  /** Number of waiters in the queue. */
  get waitingCount(): number {
    return this.queue.length
  }

  private createRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      this.running--
      this.drain()
    }
  }

  private drain(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const next = this.queue.shift()!
      this.running++
      next.resolve(this.createRelease())
    }
  }
}
