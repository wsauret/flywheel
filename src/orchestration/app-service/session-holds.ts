import type { Rpc } from "effect/unstable/rpc"
import { Log } from "../../infra/log.js"
import { createOrderedLane, type OrderedLane } from "../../infra/ordered-lane.js"

const log = Log.create({ service: "session-holds" })

/** How long the holds of a connection that ended outlive it. A phone's
 *  connection ends each time the person leaves the app, and the person
 *  usually comes back. Field data from 56 phone connections over 7 days
 *  (instant session switch design, Revision 1, 2026-10-03): the median visit
 *  lasted 30 s, and the person came back within 60 s 30% of the time, within
 *  5 min 52%, within 10 min 64%, and within 20 min 77%. Twenty minutes is
 *  also the executor's idle limit for the transcript of a session that no
 *  runner holds (transcript-projection-cache.ts). */
const HOLD_GRACE_MS = 20 * 60 * 1000

/** One client connection, as the RPC server that serves it knows it. Only
 *  its identity is read. */
export type SessionHolder = Rpc.ServerClient

/** The project's part in the grace of the session holds of a connection
 *  that ended. */
export interface SessionHoldGrace {
  /** Holds the project open on behalf of a connection that ended while its
   *  holds wait out their grace, and returns the end of that hold. It
   *  returns nothing once the project closes, because a closing project
   *  waits for no client. */
  readonly holdProject: () => (() => void) | undefined
  /** The project's idle grace, when a harness or the development lane
   *  overrides it. A shorter one bounds the hold grace, so those close their
   *  projects as soon as they ask. Zero turns the project's idle close off,
   *  and leaves the hold grace as it is. */
  readonly projectIdleGraceMs: number | undefined
}

export interface SessionHoldsOptions extends SessionHoldGrace {
  /** Tells the executor that no client shows the session. The executor ends
   *  its runner once its turn is at rest (ARCH-RUNTIME-023). Runs in the session's lane. */
  readonly release: (sessionId: string) => Promise<void>
  /** Tells the executor that no live connection shows the session while its
   *  hold waits out a grace. The executor stops the session's idle engines
   *  and keeps its runner (ARCH-PROVIDERS-006). Runs in the session's lane. */
  readonly hide: (sessionId: string) => Promise<void>
  /** Takes ownership of work that no caller waits on. */
  readonly own: (work: Promise<void>) => void
  /** Arms the grace timer and returns its cancel. A test passes its own. */
  readonly setTimer?: (fire: () => void, delayMs: number) => () => void
}

/** Which client connections show each session of one project (ARCH-RUNTIME-023). A
 *  connection holds a session from its activation until it releases the
 *  session. When the connection ends first, its holds stay for a grace, and
 *  an activation of the session from any connection inside the grace takes
 *  the hold over. The executor is told at once that no live connection shows
 *  the session, and once more when the last holder lets go.
 *  Each session has one lane, so its activations and releases reach the
 *  executor in the order they were asked. */
export interface SessionHolds {
  /** `holder` shows `sessionId`. Holding again is a no-op. */
  hold(holder: SessionHolder, sessionId: string): void
  /** `holder` no longer shows `sessionId`. */
  release(holder: SessionHolder, sessionId: string): void
  /** `holder` ended. Its holds on the sessions that no other connection
   *  shows stay until a connection shows each one again or the grace runs
   *  out, and the executor hides those sessions at once. After `dispose`, it
   *  does nothing. */
  drop(holder: SessionHolder): void
  /** Runs `work` after every runner change already asked for `sessionId`.
   *  A caller reserves its place synchronously, before its first await. */
  serialize(sessionId: string, work: () => Promise<void>): Promise<void>
  /** Ends every grace with no release: the project closes, and its executor
   *  ends every runner. */
  dispose(): void
}

/** The holds of one connection that ended, for the sessions that no
 *  connection has shown again yet. */
interface Grace {
  readonly sessionIds: Set<string>
  readonly end: () => void
}

function systemTimer(fire: () => void, delayMs: number): () => void {
  const timer = setTimeout(fire, delayMs)
  timer.unref?.()
  return () => { clearTimeout(timer) }
}

export function createSessionHolds(options: SessionHoldsOptions): SessionHolds {
  const setTimer = options.setTimer ?? systemTimer
  const bound = options.projectIdleGraceMs
  const graceMs = bound !== undefined && bound > 0 ? Math.min(HOLD_GRACE_MS, bound) : HOLD_GRACE_MS
  const holders = new Map<string, Set<SessionHolder | Grace>>()
  const lanes = new Map<string, OrderedLane>()
  const graces = new Set<Grace>()
  let disposed = false

  function serialize(sessionId: string, work: () => Promise<void>): Promise<void> {
    let lane = lanes.get(sessionId)
    if (!lane) {
      lane = createOrderedLane(() => { lanes.delete(sessionId) })
      lanes.set(sessionId, lane)
    }
    return lane.run(work)
  }

  function letGo(holder: SessionHolder | Grace, sessionId: string): void {
    const current = holders.get(sessionId)
    if (!current?.delete(holder) || current.size > 0) return
    holders.delete(sessionId)
    // A holder that comes back later queues its activation behind this
    // release, and the activation cancels the end the release asked for.
    options.own(serialize(sessionId, () => options.release(sessionId)))
  }

  /** Holds `sessionIds` for a connection that ended, until a connection
   *  shows each one again or the grace runs out. */
  function keepForReturn(sessionIds: Set<string>): Grace {
    const releaseProject = options.holdProject()
    let cancelTimer = (): void => {}
    const grace: Grace = {
      sessionIds,
      end() {
        graces.delete(grace)
        cancelTimer()
        releaseProject?.()
      },
    }
    graces.add(grace)
    cancelTimer = setTimer(() => {
      log.info("session holds released after the reattach grace", { sessions: sessionIds.size })
      for (const sessionId of sessionIds) letGo(grace, sessionId)
      grace.end()
    }, graceMs)
    log.info("session holds kept for a reattach", { sessions: sessionIds.size, graceMs })
    return grace
  }

  return {
    hold(holder, sessionId) {
      const current = holders.get(sessionId)
      if (!current) {
        holders.set(sessionId, new Set([holder]))
        return
      }
      current.add(holder)
      for (const grace of graces) {
        if (!current.delete(grace)) continue
        grace.sessionIds.delete(sessionId)
        if (grace.sessionIds.size > 0) continue
        log.info("session holds taken over by a reattach")
        grace.end()
      }
    },
    release: letGo,
    drop(holder) {
      if (disposed) return
      // A session that another holder keeps needs no grace of its own. That
      // holder can be the connection of the client that came back before
      // this one was seen to end, and its release must reach the executor
      // at once.
      const kept = new Set<string>()
      for (const [sessionId, current] of holders) {
        if (current.delete(holder) && current.size === 0) kept.add(sessionId)
      }
      if (kept.size === 0) return
      const grace = keepForReturn(kept)
      for (const sessionId of kept) {
        holders.set(sessionId, new Set([grace]))
        // An activation inside the grace queues behind this hide and shows
        // the session again.
        options.own(serialize(sessionId, () => options.hide(sessionId)))
      }
    },
    serialize,
    dispose() {
      disposed = true
      for (const grace of graces) grace.end()
    },
  }
}
