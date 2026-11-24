import { createSignal, getOwner, onCleanup } from "solid-js"
import type { AttachedRuntimeClient, RuntimeClient } from "../../protocol/app-service-types.js"
import { isLaneBreak } from "../../protocol/client/cursor-intake.js"
import { createHeldSessionDetails } from "../../protocol/client/held-session-details.js"
import { isGlobalRuntimeInvalidation } from "../../protocol/runtime-invalidation.js"
import type { RuntimeSessionDetailView } from "../../protocol/session-detail-protocol-types.js"

/** The held detail a surface reads, counted per surface that holds it. */
export interface SessionDetailCache {
  retain(sessionId: string): { release(): void }
  /** Whether a held session's read has answered, and why its last read failed. */
  state(sessionId: string): { readonly loaded: boolean; readonly error?: string } | undefined
  view(sessionId: string): RuntimeSessionDetailView | undefined
}

/** The terminal's binding of the shared held detail (`createHeldSessionDetails`),
 *  the one session-detail cache every client uses. It holds each session one
 *  surface or more shows, while one does, and holds no parent chain: a
 *  listed chat reads its row from the catalog (C5). A detail read makes the
 *  runtime hold the session's detail for this connection, so the last
 *  release tells the runtime through `releases`, which bypasses any limit
 *  that `reads` puts on snapshot reads. The release names the detail alone:
 *  a tab this connection shows keeps its runner. */
export function createSessionDetailCache(
  reads: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">,
  releases: Pick<RuntimeClient, "dispatch">,
): SessionDetailCache {
  // One signal for each held session, created with its first hold and
  // dropped with its last release, so a change to one session wakes only
  // that session's readers. A reader of a session that is not held tracks
  // `holdsChanged`, which fires when a session becomes held.
  const changed = new Map<string, { readonly track: () => void; readonly notify: () => void }>()
  const [holdsChanged, setHoldsChanged] = createSignal(undefined, { equals: false })
  const track = (sessionId: string): void => { (changed.get(sessionId)?.track ?? holdsChanged)() }
  const notify = (sessionId: string): void => { changed.get(sessionId)?.notify() }
  const held = createHeldSessionDetails({
    client: { query: reads.query, dispatch: releases.dispatch },
    onChange: notify,
  })
  const holds = new Map<string, number>()
  // Each new lane reads every held session again. A break reads nothing,
  // because the next lane's read answers for it.
  const stopLanes = reads.onLane(() => held.refresh())
  const unsubscribe = reads.subscribe((event) => {
    if (event.type !== "patch") return
    if (isGlobalRuntimeInvalidation(event.patch) && !isLaneBreak(event.patch)) held.refresh()
    else held.accept(event.patch)
  })
  if (getOwner()) onCleanup(() => { stopLanes(); unsubscribe(); held.dispose(); changed.clear() })
  return {
    retain(sessionId) {
      const count = holds.get(sessionId) ?? 0
      holds.set(sessionId, count + 1)
      if (count === 0) {
        const [readChanged, setChanged] = createSignal(undefined, { equals: false })
        changed.set(sessionId, { track: readChanged, notify: () => setChanged(undefined) })
        setHoldsChanged(undefined)
        void held.holdSession(sessionId)
      }
      let released = false
      return { release() {
        if (released) return
        released = true
        const remaining = (holds.get(sessionId) ?? 1) - 1
        if (remaining > 0) { holds.set(sessionId, remaining); return }
        holds.delete(sessionId)
        // Drop the signal before it fires. Outside a batch, Solid re-runs a
        // reader inside the notify, and that reader must then track
        // `holdsChanged`, or a later hold of this id never wakes it.
        const entry = changed.get(sessionId)
        changed.delete(sessionId)
        // The shared owner notifies a forgotten detail's signal, so remove the signal first to keep one wakeup.
        held.forget(sessionId)
        entry?.notify()
      } }
    },
    state: (sessionId) => { track(sessionId); return held.state(sessionId) },
    view: (sessionId) => { track(sessionId); return held.view(sessionId) },
  }
}
