import { randomUUID } from "node:crypto"
import type { StatusView } from "../../protocol/status-protocol-types.js"
import type { RuntimeUiPatch } from "../../protocol/runtime-ui-protocol-types.js"
import type { RuntimeUiBus } from "./runtime-ui-bus.js"

/** Relates one executor generation's output to the account's public publications.
 * A read never establishes delivery for another client. Unpublished output instead
 * requires each client to adopt an authoritative tail read begun after its barrier.
 *
 * `reset` is called exactly when every client is told to re-read (an executor
 * generation change or a repaired output gap). From then on a session's first
 * private publication is its new baseline: every client reads after that
 * invalidation, so nothing before it can be missing from what they hold, and
 * turning it into a second invalidation would only make each client read twice. */
export function createPublicOutputSettlement(bus: RuntimeUiBus) {
  const coverage = new Map<string, { privatePosition: number; publicPosition: number }>()
  let generation = randomUUID()
  // Before the first reset the account may have attached after publications it
  // never saw, so an uncovered session proves nothing about its predecessors.
  let invalidatedEveryClient = false
  return {
    get generation() { return generation },
    reset() {
      coverage.clear()
      generation = randomUUID()
      invalidatedEveryClient = true
    },
    // A removal arrives in order, so it loses nothing: the session's next
    // publication after it has only predecessors this account already forwarded.
    remove(sessionId: string) { coverage.delete(sessionId) },
    publish(patch: RuntimeUiPatch) {
      const { cursor, payload } = patch
      if (cursor.scope !== "session" || cursor.domain !== "output") return bus.publish({ cursor, payload })
      const prior = coverage.get(cursor.sessionId)
      // A missing predecessor would hide a loss in a contiguous public chain,
      // so it becomes an invalidation. A private invalidation already says as
      // much and keeps its own reason: a rebase moves block coordinates, which
      // an overflow does not, and clients recover the two differently.
      const lost = prior === undefined ? !invalidatedEveryClient && patch.prevPosition > 0 : patch.prevPosition > prior.privatePosition
      const published = bus.publish({
        cursor,
        payload: lost && payload.kind !== "runtime.invalidate" ? { kind: "runtime.invalidate", reason: "overflow" } : payload,
      })
      // Output patches state changes, so the public bus never declines one. A
      // declined one would leave coverage behind the chain without a sign.
      if (!published) throw new Error(`the public bus declined an output patch for session ${cursor.sessionId}`)
      coverage.set(cursor.sessionId, { privatePosition: patch.position, publicPosition: published.position })
      return published
    },
    status(sessionId: string, view: StatusView | null): StatusView | null {
      if (view === null || typeof view.settledOutputPosition !== "number") return view
      const required = view.settledOutputPosition
      const published = coverage.get(sessionId)
      return {
        ...view,
        settledOutputPosition: required === 0 ? 0
          : published && published.privatePosition >= required ? published.publicPosition
          : { recovery: `${generation}:${sessionId}:${required}` },
      }
    },
  }
}
