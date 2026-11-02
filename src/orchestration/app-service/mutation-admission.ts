/** What a mutation entry point returns once admission is closed: the call never
 *  started, so it owns no session and left nothing to interrupt. */
export const ADMISSION_CLOSED_ERROR = "Flywheel is shutting down"

/** The app-service's one admission gate. Every entry point that starts runtime
 *  work passes through it, so shutdown has a single place to stop accepting work
 *  and a single settlement that covers the calls it already accepted. */
export interface CommandAdmission {
  /** True once shutdown closed admission. Read by the synchronous entry points,
   *  which own no settlement to join. */
  readonly closed: boolean
  /** Admitted calls that have not returned. */
  readonly inFlight: number
  /** Runs `work` as an admitted call, or reports closure with null so the caller
   *  returns its own refusal shape. An admitted call is always joined by
   *  settled(), so work this gate accepted cannot outlive the barrier's join. */
  admit<T>(work: () => Promise<T>): Promise<T> | null
  close(): void
  /** Resolves when admission is closed and every admitted call has returned. */
  settled(): Promise<void>
  /** Told when `inFlight` moves between zero and busy, which is the only
   *  change a replacement blocker report reads. */
  onOccupancyChange(listener: () => void): () => void
}

export function createMutationAdmission(): CommandAdmission {
  let closed = false
  let inFlight = 0
  const settled = new Set<() => void>()
  const occupancy = new Set<() => void>()
  const publishSettlement = (): void => {
    if (!closed || inFlight > 0) return
    for (const resolve of settled) resolve()
    settled.clear()
  }
  const publishOccupancy = (): void => {
    for (const listener of occupancy) listener()
  }
  return {
    get closed() { return closed },
    get inFlight() { return inFlight },
    admit<T>(work: () => Promise<T>): Promise<T> | null {
      if (closed) return null
      inFlight += 1
      if (inFlight === 1) publishOccupancy()
      return (async () => {
        try {
          return await work()
        } finally {
          inFlight -= 1
          if (inFlight === 0) publishOccupancy()
          publishSettlement()
        }
      })()
    },
    close() {
      closed = true
      publishSettlement()
    },
    settled() {
      if (closed && inFlight === 0) return Promise.resolve()
      return new Promise<void>((resolve) => { settled.add(resolve) })
    },
    onOccupancyChange(listener) {
      occupancy.add(listener)
      return () => { occupancy.delete(listener) }
    },
  }
}
