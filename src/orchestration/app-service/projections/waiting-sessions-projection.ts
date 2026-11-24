import { isSessionHistoryFailure, type AsyncEventReadSurface, type StoredFact } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { createBackgroundLane } from "../../../infra/ordered-lane.js"
import { AGENT_INPUT_FACT_TYPES } from "../../session/agent-input/agent-input-facts.js"
import { loadPendingInputOpenedAt, loadSessionsWithPendingInput } from "../../session/agent-input/agent-input-projection.js"
import { waitingSessionsCursor, type RuntimeWaitingSessionsSnapshotResult, type WaitingSession } from "../../../protocol/session/question-protocol-types.js"
import type { RuntimePosition, RuntimeUiPatchInput } from "../../../protocol/runtime/runtime-ui-protocol-types.js"
import type { RuntimeReadAnchor } from "./runtime-ui-patch-sequencer.js"

const log = Log.create({ service: "waiting-sessions-projection" })

export interface WaitingSessionsProjection {
  /** Every session of the project that waits on a question, closed ones
   *  included, with the time its docked question opened, and the position
   *  of the waiting-sessions cursor that the answer covers. The first call
   *  reads the baseline, which publishes nothing, so a question that already
   *  waited pages no one. */
  snapshot(): Promise<RuntimeWaitingSessionsSnapshotResult>
  dispose(): void
}

export interface WaitingSessionsProjectionDeps {
  readonly reader: AsyncEventReadSurface
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly bus: {
    publish(input: RuntimeUiPatchInput): void
    snapshotPosition(anchor: RuntimeReadAnchor): RuntimePosition
  }
}

const EVENT_TYPES = new Set<string>(AGENT_INPUT_FACT_TYPES)

/** The one owner of the set of project sessions with a pending question
 *  (ARCH-PROTOCOL-068). It lives with the account's project control, so it
 *  answers while the project's executor is paused, and it folds the same
 *  agent-input facts with the same reducer as the question dock.
 *
 *  Nothing is read at construction. The first request reads the baseline,
 *  off the lane that advances the set, so no read waits for the scan. Each
 *  committed question fact after the baseline rereads only its own session
 *  through that session's held fold and publishes the whole set when the
 *  session joined or left it, or its docked question changed. A session whose question history cannot be
 *  folded stays out of the set and is recorded once. */
export function createWaitingSessionsProjection(deps: WaitingSessionsProjectionDeps): WaitingSessionsProjection {
  let waiting: Map<string, number> | undefined
  let baseline: Promise<Map<string, number>> | undefined
  // Sessions whose question facts were committed while the baseline read
  // ran. Each is read again once the baseline lands, so a fact on either
  // side of the baseline's ceiling reaches the set exactly once.
  const touchedDuringBaseline = new Set<string>()
  const reportedUnreadable = new Set<string>()
  const lane = createBackgroundLane(log, "waiting-sessions")
  let disposed = false

  // `cause` is a kind, never an error message: the message of a corrupt row
  // quotes the stored payload.
  function reportUnreadable(sessionIds: Iterable<string>, cause: string): void {
    const fresh = [...sessionIds].filter((sessionId) => !reportedUnreadable.has(sessionId))
    if (fresh.length === 0) return
    for (const sessionId of fresh) reportedUnreadable.add(sessionId)
    log.warn("question history unreadable; sessions left out of the waiting set", { count: fresh.length, sessionIds: fresh, cause })
  }

  async function openedAt(sessionId: string): Promise<number | undefined> {
    try {
      return await loadPendingInputOpenedAt(deps.reader, sessionId)
    } catch (error) {
      // A read that the store did not serve says nothing about the session.
      if (!isSessionHistoryFailure(error)) throw error
      reportUnreadable([sessionId], error instanceof Error ? error.name : typeof error)
      return undefined
    }
  }

  // An advance that failed left the set behind the stored facts. The next
  // request reads the baseline again, which covers every fact it missed.
  function forget(held: Map<string, number>): void {
    if (waiting !== held) return
    waiting = undefined
    baseline = undefined
  }

  async function advanceOrForget(held: Map<string, number>, sessionIds: Iterable<string>): Promise<void> {
    try {
      await advance(held, sessionIds)
    } catch (error) {
      forget(held)
      throw error
    }
  }

  async function advance(held: Map<string, number>, sessionIds: Iterable<string>): Promise<void> {
    let changed = false
    for (const sessionId of sessionIds) {
      const now = await openedAt(sessionId)
      if (now === held.get(sessionId)) continue
      if (now === undefined) held.delete(sessionId)
      else held.set(sessionId, now)
      changed = true
    }
    if (changed && !disposed) deps.bus.publish({ cursor: waitingSessionsCursor(), payload: { kind: "waitingSessions.changed", sessions: listed(held) } })
  }

  function load(): Promise<Map<string, number>> {
    baseline ??= (async () => {
      const result = await loadSessionsWithPendingInput(deps.reader)
      if (result.unreadable.size > 0) reportUnreadable(result.unreadable, "baseline read")
      const held = new Map(result.waiting)
      const touched = [...touchedDuringBaseline]
      touchedDuringBaseline.clear()
      waiting = held
      if (touched.length > 0) await lane.run(() => advanceOrForget(held, touched))
      return held
    })().catch((error: unknown) => {
      // The next request reads the baseline again, and that read covers
      // every fact that this one would have.
      waiting = undefined
      baseline = undefined
      touchedDuringBaseline.clear()
      throw error
    })
    return baseline
  }

  const unsubscribeStored = deps.onStored((events) => {
    if (disposed) return
    const touched = new Set<string>()
    for (const event of events) if (EVENT_TYPES.has(event.type)) touched.add(event.sessionId)
    if (touched.size === 0) return
    const held = waiting
    if (held) lane.runInBackground("waiting sessions push", () => advanceOrForget(held, touched))
    else if (baseline) for (const sessionId of touched) touchedDuringBaseline.add(sessionId)
  })

  return {
    // A read answers with every question fact stored before it. Its
    // position is taken first, so a patch that the read already covers is
    // one that a client applies again, never one that it misses.
    async snapshot() {
      const snapshotPosition = deps.bus.snapshotPosition({ kind: "cursor", cursor: waitingSessionsCursor() })
      for (;;) {
        const held = await load()
        await lane.settled()
        // A failed advance forgot the set while this read waited: read again.
        if (waiting === held) return { sessions: listed(held), snapshotPosition }
      }
    },
    dispose() {
      disposed = true
      unsubscribeStored()
    },
  }
}

function listed(held: ReadonlyMap<string, number>): WaitingSession[] {
  return [...held].map(([sessionId, openedAt]) => ({ sessionId, openedAt }))
}
