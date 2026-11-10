import { Log } from "../../infra/log.js"
import { createOrderedLane, type OrderedLane } from "../../infra/ordered-lane.js"
import type { SessionHolder } from "./session-holds.js"

const log = Log.create({ service: "background-follows" })

/** One client connection, or `undefined` for an in-process caller, which
 *  names no connection and follows until the project closes. */
type Follower = SessionHolder | undefined

/** Which client connections follow the background index of each session
 *  (ARCH-PROTOCOL-069). A connection's `sessionBackgroundWork` read follows
 *  the session until its `background.release` or its end, and when the last
 *  follower leaves, the executor lets the index go. Each session has one
 *  lane, so its reads and its releases reach the executor in the order they
 *  were asked, and a release never overtakes a later read. */
export interface BackgroundFollows {
  /** Runs `read` for `follower`, which follows `sessionId` from this call on. */
  read<T>(follower: Follower, sessionId: string, read: () => Promise<T>): Promise<T>
  /** `follower` no longer follows `sessionId`. */
  release(follower: Follower, sessionId: string): void
  /** `follower` ended: it follows no session any more. */
  drop(follower: Follower): void
}

export function createBackgroundFollows(deps: {
  /** Tells the executor that no client follows the session's index. */
  readonly release: (sessionId: string) => Promise<void>
  /** Takes ownership of work that no caller waits on. */
  readonly own: (work: Promise<void>) => void
}): BackgroundFollows {
  const followers = new Map<string, Set<Follower>>()
  const lanes = new Map<string, OrderedLane>()

  function lane(sessionId: string): OrderedLane {
    let current = lanes.get(sessionId)
    if (!current) {
      current = createOrderedLane(() => { lanes.delete(sessionId) })
      lanes.set(sessionId, current)
    }
    return current
  }

  function letGo(follower: Follower, sessionId: string): void {
    const current = followers.get(sessionId)
    if (!current?.delete(follower) || current.size > 0) return
    followers.delete(sessionId)
    log.debug("background index unfollowed", { sessionId })
    deps.own(lane(sessionId).run(() => deps.release(sessionId)))
  }

  return {
    read(follower, sessionId, read) {
      const current = followers.get(sessionId)
      if (current) current.add(follower)
      else followers.set(sessionId, new Set([follower]))
      return lane(sessionId).run(read)
    },
    release: letGo,
    drop(follower) {
      // A Map visits each entry once even when the loop deletes the one it
      // is on, so a session let go here is never skipped or revisited.
      for (const [sessionId, current] of followers) if (current.has(follower)) letGo(follower, sessionId)
    },
  }
}
