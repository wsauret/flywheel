/** A bounded set of permits that sessions share fairly. Each instance owns its
 *  own allowance, so two owners never consume each other's capacity. */
export interface SessionFairAdmission {
  /** Waits for a permit in session-fair order and resolves with its release.
   *  An abort removes a request that has not started and rejects with the
   *  signal's reason. Each release frees its permit once; a repeated call
   *  does nothing, so overlapping cleanup paths cannot create capacity. */
  acquire(sessionId: string, signal?: AbortSignal): Promise<() => void>
  /** Occupies one permit at once, past capacity if need be, for work that
   *  already runs and so must never wait in the queue. Queued requests wait
   *  until enough such permits are released. */
  take(): () => void
}

interface Waiting {
  readonly resolve: (release: () => void) => void
  readonly reject: (reason: unknown) => void
  readonly cleanup: () => void
}

/** Queues FIFO within a session and rotates sessions after each admission,
 *  so one session with many queued requests cannot starve another. */
export function createSessionFairAdmission(capacity: number): SessionFairAdmission {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Session-fair admission capacity must be a positive integer")
  const sessions = new Map<string, Waiting[]>()
  const order: string[] = []
  let active = 0

  const makeRelease = (): (() => void) => {
    let held = true
    return () => {
      if (!held) return
      held = false
      active--
      drain()
    }
  }

  const drain = (): void => {
    while (active < capacity && order.length > 0) {
      const sessionId = order.shift()
      if (sessionId === undefined) break
      const queue = sessions.get(sessionId)
      const waiting = queue?.shift()
      if (!waiting || !queue) continue
      if (queue.length > 0) order.push(sessionId)
      else sessions.delete(sessionId)
      waiting.cleanup()
      active++
      waiting.resolve(makeRelease())
    }
  }

  return {
    acquire(sessionId, signal) {
      if (signal?.aborted) return Promise.reject(signal.reason)
      return new Promise((resolve, reject) => {
        const cancel = (): void => {
          const queue = sessions.get(sessionId)
          const index = queue?.indexOf(waiting) ?? -1
          if (!queue || index < 0) return
          queue.splice(index, 1)
          if (queue.length === 0) {
            sessions.delete(sessionId)
            const position = order.indexOf(sessionId)
            if (position >= 0) order.splice(position, 1)
          }
          waiting.cleanup()
          waiting.reject(signal?.reason)
        }
        const waiting: Waiting = { resolve, reject, cleanup: () => signal?.removeEventListener("abort", cancel) }
        const queue = sessions.get(sessionId)
        if (queue) queue.push(waiting)
        else {
          sessions.set(sessionId, [waiting])
          order.push(sessionId)
        }
        signal?.addEventListener("abort", cancel, { once: true })
        drain()
      })
    },
    take() {
      active++
      return makeRelease()
    },
  }
}
