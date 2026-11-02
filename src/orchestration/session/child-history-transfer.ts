import type { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import { createSqliteEventReadSurface } from "../../infra/sqlite-event-read-surface.js"
import { createSqliteEventInserter } from "../../infra/sqlite-event-store-core.js"
import { recoverSessionMetadata } from "./session-metadata-projection.js"
import { buildSessionChildLinkedFact, buildSessionChildUnlinkedFact, buildSessionOwnershipAdoptedFact } from "./session-metadata-facts.js"
import { buildSessionMetadataAppend } from "./session-metadata-store.js"
import { installedChildSessionHistory } from "./module-session-operations.js"

/** Rebinds a live child only when its recorded parent conversation proves one member. */
export function transferNestedChildren(db: Database, source: string, conversations: ReadonlyMap<string, string>, excluded: ReadonlySet<string>, timestamp: number): void {
  // A child moves only to a member conversation, so without one no child can move.
  if (conversations.size === 0) return
  const reader = createSqliteEventReadSurface(db)
  const inserter = createSqliteEventInserter(db)
  // Only a creation or an adoption can name a launch parent. The text match is
  // a superset of every payload version, so recovery stays the exact test and
  // a workspace with many sessions does not recover each one per workflow.
  const named = db.query<{ id: string }, [string]>(`
    select distinct session_id as id from event
    where type in ('session.created', 'session.ownership.adopted') and instr(payload, ?) > 0
  `).all(JSON.stringify(source))
  for (const { id } of named) {
    if (excluded.has(id)) continue
    const child = recoverSessionMetadata(reader, id)
    if (!child || child.kind === "chat" || child.kind === "workflow" || child.launchedFrom?.parentSessionId !== source) continue
    const conversationId = child.launchedFrom.conversationId
    const parent = conversationId ? conversations.get(conversationId) : undefined
    if (!parent || !conversationId) continue
    const now = new Date(timestamp).toISOString()
    const events = [
      buildSessionMetadataAppend(id, buildSessionOwnershipAdoptedFact(parent, conversationId, child.launchedFrom.toolUseId, now), timestamp),
      buildSessionMetadataAppend(parent, buildSessionChildLinkedFact(id, now), timestamp),
      buildSessionMetadataAppend(source, buildSessionChildUnlinkedFact(id, now), timestamp),
    ]
    const history = installedChildSessionHistory()
    for (const run of history.loadRuns(reader.read({ aggregateId: `session:${id}`, types: history.factTypes }))) {
      if (run.parentSessionId === source) events.push(history.prepareOwnershipRecovery(id, {
        childRunId: run.childRunId, parentSessionId: parent, parentConversationId: conversationId,
      }))
    }
    inserter.insertEventRows(events.map(event => ({ ...event, id: randomUUID() })))
  }
}
