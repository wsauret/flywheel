import type { Database } from "bun:sqlite"
import { createSqliteEventReadSurface } from "../../infra/sqlite-event-read-surface.js"
import { createSqliteEventInserter } from "../../infra/sqlite-event-store-core.js"
import type { ReplayedSession } from "./schemas.js"
import { orchestrationReplyWaitClosures, REPLY_WAIT_IN_FLIGHT_KIND, replyWaitSource } from "./conversation/reply-wait-cells.js"
import { readConversationSnapshotSync } from "./conversation/conversation-projection.js"
import type { SessionMessageSources } from "./session-message-sources.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "./conversation/queued-background-notifications.js"

/** Foreign wait closure shares the transaction that publishes canonical source membership.
 * Raw committed messages and dispatch identities never change. `identity` recovers a waiting
 * session; only its kind and conversation are read, which a conversion never changes. */
export function closeOrchestrationReplyWaits(db: Database, workflowId: string, excluded: ReadonlySet<string>, sources: SessionMessageSources, identity: (sessionId: string) => ReplayedSession | null): void {
  const reader = createSqliteEventReadSurface(db)
  const inserter = createSqliteEventInserter(db)
  for (const owner of reader.sessionsWithInFlight(REPLY_WAIT_IN_FLIGHT_KIND)) {
    if (excluded.has(owner)) continue
    const rows = reader.readInFlight(owner, REPLY_WAIT_IN_FLIGHT_KIND)
    // Only a wait on this workflow closes, so an owner without one costs no transcript read.
    if (!rows.some(row => replyWaitSource(row)?.addresseeSessionId === workflowId)) continue
    const session = identity(owner)
    if (!session || session.kind === "workflow") continue
    const notices = new Set(reader.readInFlight(owner, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND).map(row => row.key))
    const history = readConversationSnapshotSync(reader, session.conversationId, sources)
    for (const entry of Object.values(history.entriesById)) {
      notices.add(entry.id)
    }
    const writes = orchestrationReplyWaitClosures({ rows, addressee: workflowId, conversationId: session.conversationId, noticeKeys: notices })
    for (const write of writes) inserter.writeInFlight(owner, write)
  }
}
