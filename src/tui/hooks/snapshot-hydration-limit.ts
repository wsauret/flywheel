import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"

/** Per-session cache hydration (status, budget, queue, question snapshots) can
 *  fan out to every catalog row at startup - dozens of RPCs at once. The worker
 *  transport runs unary calls at WORKER_RPC_CONCURRENCY (16), so an unbounded
 *  burst occupies every slot and interactive calls (model assignments, output
 *  windows, dispatch) queue behind seconds of background work. Capping
 *  hydration below the transport bound keeps slots free for interactive RPCs;
 *  hydration itself only stretches out, it never starves. */
const HYDRATION_CONCURRENCY = 12

type SnapshotHydrationClient = Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">

/** Wrap the snapshot loaders the per-session caches hydrate through with one
 *  shared FIFO concurrency gate. `subscribe` and `onLane` (the live patch
 *  lane) pass through untouched. */
export function withSnapshotHydrationLimit(
  appService: SnapshotHydrationClient,
  concurrency: number = HYDRATION_CONCURRENCY,
): SnapshotHydrationClient {
  const acquire = createConcurrencyGate(concurrency)
  return {
    subscribe: appService.subscribe,
    onLane: appService.onLane,
    query: (query) => acquire(() => appService.query(query)),
  }
}

function createConcurrencyGate(permits: number): <A>(run: () => Promise<A>) => Promise<A> {
  let active = 0
  const waiters: Array<() => void> = []
  return async (run) => {
    if (active >= permits) await new Promise<void>((resolve) => { waiters.push(resolve) })
    active++
    try {
      return await run()
    } finally {
      active--
      waiters.shift()?.()
    }
  }
}
