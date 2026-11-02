import type { FrontendEvent } from "../app-service-types.js"
import { reconnectBackoffMs, type RuntimeConnection } from "./connection.js"
import { lostWithLane } from "./connection-failures.js"
import { isLaneBreak } from "./cursor-intake.js"

/** Keeps a runner attached to every chat session this client shows.
 *
 *  A session open in a tab holds its runner: the tab's lifecycle is the
 *  session's lifecycle, which is the runner's (ARCH-SESSIONS-038). The runtime cannot
 *  know which sessions a client shows, so the client says so: it activates a
 *  session when it opens, and again on every lane, because a restarted
 *  runtime opens every session paused. An activation that fails on its own
 *  asks again with the connection's own backoff; one lost with its lane
 *  waits for the next lane, which asks again. An executor generation
 *  invalidation also reattaches open tabs without waiting for a socket restart.
 *  An answer that the session cannot be activated, because it is not a chat or is gone,
 *  ends the asking; a refusal that names a condition still settling, such as a
 *  runtime whose executor is being replaced, does not. Closing the tab
 *  releases the session, so the runtime can end a runner that no client
 *  shows; it never closes the session itself. Nothing here resumes a turn;
 *  only a message does that.
 *
 *  A client that shows one session and keeps others for a return paces each
 *  lane and its initial opens (`focusReady`): the focused session activates
 *  first, and the others
 *  activate one at a time, each after the one before it answered, once the
 *  focused session's view is ready, the one most recently opened or focused
 *  first. So the session a person sees never waits behind the sessions they
 *  may return to, and the one they most likely return to waits least.
 *
 *  A runner the runtime granted can end while its session is kept, as when
 *  another client closes the session. The keeper does not ask for that
 *  runner again behind the person. It asks again when the person shows the
 *  session: a focus that moves to a kept session whose runner `ended`
 *  activates it, and a focus that moves to a session with a live runner asks
 *  for nothing. */
export interface OpenSessionKeeper {
  open(sessionId: string): void
  close(sessionId: string): void
  /** Names the session a person sees. A paced lane activates it first. A
   *  focus on a session the lane has not activated yet activates it now, and
   *  so does a focus that moves to a session whose granted runner ended. */
  focus(sessionId: string | undefined): void
  dispose(): void
}

export interface OpenSessionKeeperOptions {
  readonly client: Pick<RuntimeConnection, "dispatch" | "subscribe" | "onLane">
  readonly onDiagnostic?: (message: string, detail?: unknown) => void
  readonly random?: () => number
  /** The delay before a retry; tests supply one that fires on their cue. */
  readonly setTimer?: (fire: () => void, milliseconds: number) => () => void
  /** Paces each lane, as described on `OpenSessionKeeper`: answers once the
   *  focused session's view is ready on the lane. Absent, a lane activates
   *  every open session at once. */
  readonly focusReady?: () => Promise<void>
  /** Answers true when the runtime says the session's runner ended, as a
   *  chat's catalog row does when it turns inactive. Absent, a focus never
   *  asks again for a session the lane already activated. */
  readonly ended?: (sessionId: string) => boolean
}

interface Kept {
  attachment?: Promise<void>
  attempt: number
  cancelTimer?: () => void
  /** The attach in flight, so an answer for an older attempt is ignored. */
  generation: number
  /** The round of reattachment that last asked for this session. */
  round: number
  /** True from the runtime's grant of the runner until the next ask. An ask
   *  in flight or refused is not a grant, so a focus does not repeat it. */
  granted: boolean
}

const defaultSetTimer: NonNullable<OpenSessionKeeperOptions["setTimer"]> = (fire, milliseconds) => {
  const timer = setTimeout(fire, milliseconds)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createOpenSessionKeeper(options: OpenSessionKeeperOptions): OpenSessionKeeper {
  /** Least recently opened or focused first. */
  const kept = new Map<string, Kept>()
  const random = options.random ?? Math.random
  const setTimer = options.setTimer ?? defaultSetTimer
  let disposed = false
  let focused: string | undefined
  /** The last session a focus named. A focus on no session keeps it, so a
   *  moment when the shown session's root is still unknown is not a move. */
  let lastFocused: string | undefined
  /** Counts the reattachments, so a paced walk that a newer one replaced stops. */
  let round = 0
  let walking: number | undefined

  /** Asks for the session's runner, and answers once the runtime answered
   *  the first ask; a retry after a failure does not delay that answer. */
  function attach(sessionId: string): Promise<void> {
    const entry = kept.get(sessionId)
    if (!entry || disposed) return Promise.resolve()
    entry.cancelTimer?.()
    entry.cancelTimer = undefined
    entry.round = round
    entry.granted = false
    const generation = ++entry.generation
    entry.attachment = options.client.dispatch({ type: "session.activate", sessionId }).then(
      (result) => {
        if (kept.get(sessionId) !== entry || entry.generation !== generation) return
        if (result.ok) {
          entry.attempt = 0
          entry.granted = true
          return
        }
        // The runtime answered: this session takes no runner. Asking again
        // would get the same answer.
        options.onDiagnostic?.("session keeper: activation refused", { sessionId, error: result.error })
      },
      (cause: unknown) => {
        // An activation lost with its lane failed nothing: the next lane
        // asks again.
        if (kept.get(sessionId) !== entry || entry.generation !== generation || disposed || lostWithLane(cause)) return
        options.onDiagnostic?.("session keeper: activation failed; retrying", { sessionId, attempt: entry.attempt, cause })
        const delay = reconnectBackoffMs(entry.attempt, random)
        entry.attempt += 1
        entry.cancelTimer = setTimer(() => {
          entry.cancelTimer = undefined
          void attach(sessionId)
        }, delay)
      },
    )
    return entry.attachment
  }

  function walk(): void {
    const current = round
    const { focusReady } = options
    if (focusReady === undefined || walking === current) return
    walking = current
    void (async () => {
      // Opening the tabs and naming their focus are one synchronous publication.
      await Promise.resolve()
      for (;;) {
        if (disposed || round !== current) return
        const shown = focused
        await (shown === undefined ? undefined : kept.get(shown)?.attachment)
        await focusReady()
        if (disposed || round !== current) return
        if (focused !== shown) continue
        const next = Array.from(kept.keys()).toReversed().find((id) => kept.get(id)?.round !== current)
        if (next === undefined) {
          walking = undefined
          return
        }
        await attach(next)
      }
    })()
  }
  function attachAll(): void {
    ++round
    for (const entry of kept.values()) entry.attempt = 0
    if (options.focusReady === undefined) {
      for (const sessionId of kept.keys()) void attach(sessionId)
      return
    }
    if (focused !== undefined && kept.has(focused)) void attach(focused)
    walk()
  }
  // An invalidation other than a lane break, such as an executor generation
  // change, reattaches at once; a lane break waits for its next lane.
  const unsubscribe = options.client.subscribe((event: FrontendEvent) => {
    if (event.type === "patch" && event.patch.cursor.scope === "workspace" && event.patch.cursor.domain === "runtime"
      && event.patch.payload.kind === "runtime.invalidate" && !isLaneBreak(event.patch)) attachAll()
  })
  // A fresh lane may be a fresh runtime, where every session opened paused.
  const stopLanes = options.client.onLane(attachAll)

  return {
    open(sessionId) {
      if (disposed || kept.has(sessionId)) return
      kept.set(sessionId, { attempt: 0, generation: 0, round: -1, granted: false })
      if (options.focusReady === undefined || sessionId === focused) void attach(sessionId)
      walk()
    },
    focus(sessionId) {
      focused = sessionId
      if (sessionId === undefined) return
      const moved = sessionId !== lastFocused
      lastFocused = sessionId
      const entry = kept.get(sessionId)
      if (entry === undefined) return
      kept.delete(sessionId)
      kept.set(sessionId, entry)
      const ended = moved && entry.granted && options.ended?.(sessionId) === true
      if (entry.round !== round || ended) void attach(sessionId)
    },
    close(sessionId) {
      const entry = kept.get(sessionId)
      if (!entry) return
      entry.cancelTimer?.()
      kept.delete(sessionId)
      // A release lost with a broken lane needs no retry: the runtime drops
      // every hold of a connection that ends.
      void options.client.dispatch({ type: "session.release", sessionId }).catch((cause: unknown) => {
        if (!lostWithLane(cause)) options.onDiagnostic?.("session keeper: release failed", { sessionId, cause })
      })
    },
    dispose() {
      disposed = true
      stopLanes()
      unsubscribe()
      for (const entry of kept.values()) entry.cancelTimer?.()
      kept.clear()
    },
  }
}
