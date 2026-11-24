import { existsSync } from "node:fs"

/** A file whose existence defers the first signal of any end of one launch,
 *  at most `boundMs`. A payload states it when a signal at the wrong moment
 *  damages state that outlives the payload: the Claude engine holds a lock
 *  file while it refreshes a login token, and a CLI ended during the refresh
 *  clears the login. The hold travels with the launch to every process that
 *  can end its container (the launcher, the container's supervisor, and the
 *  guardian), and `emptyContainers` is the one place that honors it, through
 *  `waitForStopHolds`, so no ending path can skip it. The grace between TERM
 *  and KILL starts after the hold. */
export interface StopHold {
  /** An absolute path. The hold stands while a file exists there. */
  readonly path: string
  readonly boundMs: number
}

/** A container as a stop hold sees it: the hold it declared, if any, and
 *  whether it is still owned. */
interface HoldingContainer {
  readonly stopHold?: StopHold
  populated(): boolean
}

/** Waits while any populated container's stop hold stands, each one at most
 *  its own bound, and answers how long it waited: 0 when no hold stood, so
 *  the time a check takes is never reported as a hold. */
export async function waitForStopHolds(
  containers: readonly HoldingContainer[],
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<number> {
  const startedAt = Date.now()
  const holding = (): boolean => containers.some((container) => {
    const hold = container.stopHold
    return hold !== undefined && Date.now() - startedAt < hold.boundMs && existsSync(hold.path) && container.populated()
  })
  if (!holding()) return 0
  do await sleep(pollMs)
  while (holding())
  return Date.now() - startedAt
}
