import type { StatusView } from "../status-protocol-types.js"

/** An active time at `now`: the time worked before the open episode, plus
 *  the open episode up to `now` while one runs. An interrupt or a wait for a
 *  person opens no episode, so it adds no time. Every active time that a
 *  client shows reads this: a session, a subagent, a workflow run, a phase,
 *  and a workflow agent. `now` can be a display clock that ticks once a
 *  second, so an episode that began after its last tick counts as no time
 *  yet, never as less than none. */
export function activeTimeMs(recordedMs: number, openedAt: number | null | undefined, now: number): number {
  return recordedMs + (openedAt === null || openedAt === undefined ? 0 : Math.max(0, now - openedAt))
}

/** The time a session worked: the active time its status accumulated, plus
 *  the running episode up to `now`, so every client's header and card read
 *  the same figure. */
export function sessionActiveMs(status: Pick<StatusView, "accumulatedActiveMs" | "streamingStartedAt"> | undefined, now: number): number {
  return status === undefined ? 0 : activeTimeMs(status.accumulatedActiveMs, status.streamingStartedAt, now)
}

/** The time a header shows for a session: the duration its row recorded
 *  once no runner holds it, which outlasts the runner's status, and its
 *  active time otherwise. */
export function sessionHeaderElapsedMs(row: { readonly lifecycleState?: string; readonly durationMs?: number } | undefined, activeMs: number): number {
  return row?.lifecycleState === "inactive" ? row.durationMs ?? activeMs : activeMs
}
