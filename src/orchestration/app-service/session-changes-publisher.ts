import type { StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"
import { changesCursor } from "../../protocol/session-changes-protocol-types.js"
import type { RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import type { SessionPlacements } from "../session/session-metadata-store.js"
import { addSubtreeOwners } from "../session/session-subtree.js"

const log = Log.create({ service: "session-changes-publisher" })

/** The facts that change a review: its files and their evidence, and a link
 *  or a title of a session it holds. */
const CHANGE_SOURCES: ReadonlySet<string> = new Set(["file.changed", "file.reviewed", "file.artifact.recorded", "tool.result.recorded", "session.child.linked", "session.label.updated"])

/** Publish one invalidation per review that a committed batch changes: the
 * review of each session that recorded a change, and the review of every
 * session that launched it, up the tree. Payloads, history, indexes, and
 * runner state are never read; only where sessions sit is. */
export function createSessionChangesPublisher(deps: {
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly publish: (input: RuntimeUiPatchInput) => void
  /** Where sessions sit in the tree. The publisher passes it every stored batch. */
  readonly sessionPlacements: SessionPlacements
}) {
  const unsubscribe = deps.onStored(events => {
    deps.sessionPlacements.observe(events)
    const sessions = new Set<string>()
    for (const event of events) {
      if (CHANGE_SOURCES.has(event.type) || event.aggregateId === `workflow:${event.sessionId}`) sessions.add(event.sessionId)
    }
    if (sessions.size === 0) return
    void (async () => {
      const reviews = new Set<string>()
      for (const sessionId of sessions) await addSubtreeOwners(deps.sessionPlacements, sessionId, reviews)
      for (const sessionId of reviews) deps.publish({ cursor: changesCursor(sessionId), payload: { kind: "changes.changed" } })
    })().catch((error: unknown) => { recordBackgroundFailure(log, "session changes publication", { sessions: sessions.size }, error) })
  })
  return { dispose: unsubscribe }
}
