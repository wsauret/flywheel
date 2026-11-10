import { createEffect, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import { createStore, produce, unwrap } from "solid-js/store"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import {
  backgroundIndexState,
  createBackgroundIndexReadings,
  type BackgroundIndexState,
  type HeldBackgroundIndex,
} from "../../protocol/client/background-index.js"

export interface BackgroundIndexView {
  /** Follows the background index of a session that a child viewer shows,
   *  in addition to the foreground session, which is always followed, until
   *  the returned call: the viewer's close. */
  follow(sessionId: string): () => void
  /** The held index of a followed session. */
  state(sessionId: string): BackgroundIndexState
  /** Starts following once the shell's first frame and runtime readiness
   *  passed, so the first read of an index never competes with startup. */
  start(): void
}

interface HeldIndexes {
  [sessionId: string]: HeldBackgroundIndex
}

/** The terminal's follower of the `background` domain: the foreground
 *  session, and each session that an open child viewer shows. Opening or
 *  closing the background modal reads and discards nothing; a session that
 *  no longer is either stops being followed, and the runtime lets its index
 *  go once no client follows it. */
export function createBackgroundIndexFollower(deps: {
  readonly client: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane">
  readonly foregroundId: Accessor<string | undefined>
}): BackgroundIndexView {
  const [held, setHeld] = createStore<HeldIndexes>({})
  const [started, setStarted] = createSignal(false)
  // The open child viewers of each session, as a count: two viewers can show one session.
  const viewed = new Map<string, number>()
  const followed = (sessionId: string): boolean => sessionId === untrack(deps.foregroundId) || viewed.has(sessionId)
  const family = createBackgroundIndexReadings({
    client: deps.client,
    admits: followed,
    views: {
      get: (sessionId) => untrack(() => unwrap(held)[sessionId]),
      set: (sessionId, view) => setHeld(produce((state) => { state[sessionId] = view })),
      delete: (sessionId) => setHeld(produce((state) => { Reflect.deleteProperty(state, sessionId) })),
      keys: () => Object.keys(untrack(() => unwrap(held))),
    },
  })
  onCleanup(family.dispose)

  function sync(): void {
    for (const sessionId of family.sessionIds()) if (!followed(sessionId)) family.retire(sessionId)
    if (!untrack(started)) return
    family.ensure([untrack(deps.foregroundId), ...viewed.keys()].filter((sessionId) => sessionId !== undefined))
  }
  createEffect(on([deps.foregroundId, started], sync))

  return {
    follow(sessionId) {
      viewed.set(sessionId, (viewed.get(sessionId) ?? 0) + 1)
      sync()
      return () => {
        const rest = (viewed.get(sessionId) ?? 1) - 1
        if (rest > 0) viewed.set(sessionId, rest)
        else viewed.delete(sessionId)
        sync()
      }
    },
    state: (sessionId) => backgroundIndexState(held[sessionId]),
    start: () => setStarted(true),
  }
}
