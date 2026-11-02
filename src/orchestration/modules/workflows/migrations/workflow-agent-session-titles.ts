import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { admitPrivateDatabaseFiles } from "../../../../infra/private-path.js"
import { Log } from "../../../../infra/log.js"
import { errorMessage } from "../../../../infra/error-message.js"
import { applySqliteDurabilityPragmas } from "../../../../infra/sqlite-durability.js"
import { createSqliteEventReadSurface } from "../../../../infra/sqlite-event-read-surface.js"
import { createSqliteEventInserter } from "../../../../infra/sqlite-event-store-core.js"
import { loadQueueFromEvents } from "../../../../workflows/view/view-projection.js"
import { checkedThrough, headPosition, recordChecked, recordMigration } from "../../../migrations/engine.js"
import { recoverSessionMetadata } from "../../../session/session-metadata-projection.js"
import { buildSessionMetadataAppend } from "../../../session/session-metadata-store.js"
import { workflowAgentSessionTitle } from "../agent-title.js"

const MIGRATION_ID = "workflow-agent-session-titles"
const log = Log.create({ service: "workflow-agent-session-titles" })

/** Gives each workflow agent session that a build before 2026-10-18 created
 *  its human title. Those builds labeled the session with its attempt id,
 *  such as `review:node:1:item:1:phase:1:attempt:1`, which every client then
 *  showed as its title. A session whose label is still its attempt id takes
 *  the title its creation now writes: its phase and its item key or agent
 *  id. A session the person renamed keeps its name, and a session whose run
 *  plan is unreadable keeps its label with a warning. The pass reads only
 *  sessions created after its watermark, so a second open changes nothing.
 *  Remove this conversion after 2027-10-18. */
export function titleWorkflowAgentSessions(dbFile: string) {
  if (!existsSync(dbFile)) return { titled: 0 }
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  try {
    applySqliteDurabilityPragmas(db, 5000)
    const checked = checkedThrough(db, MIGRATION_ID)
    if (headPosition(db) <= checked) return { titled: 0 }
    const reader = createSqliteEventReadSurface(db)
    const readPlan = (workflowId: string) => {
      try { return { plan: loadQueueFromEvents(reader.read({ aggregateId: `workflow:${workflowId}` })), error: undefined } } catch (cause) { return { plan: null, error: errorMessage(cause) } }
    }
    const plans = new Map<string, ReturnType<typeof loadQueueFromEvents>>()
    const plan = (workflowId: string) => {
      if (!plans.has(workflowId)) {
        const read = readPlan(workflowId)
        if (read.plan === null) log.warn("workflow plan unreadable; its agent sessions keep their labels", { workflowId, ...(read.error === undefined ? {} : { error: read.error }) })
        plans.set(workflowId, read.plan)
      }
      return plans.get(workflowId) ?? null
    }
    db.exec("BEGIN IMMEDIATE")
    try {
      const titles = candidates(db, checked).flatMap((sessionId) => {
        const session = recoverSessionMetadata(reader, sessionId)
        if (session?.kind !== "workflow-agent" || session.workflowMembership.kind !== "attempt" || session.label !== session.workflowMembership.attemptId) return []
        const title = workflowAgentSessionTitle(plan(session.workflowMembership.workflowId), session.label)
        return title === undefined ? [] : [{ sessionId, title }]
      })
      const lastUpdated = new Date().toISOString()
      createSqliteEventInserter(db).insertEventRows(titles.map(({ sessionId, title }) => ({
        ...buildSessionMetadataAppend(sessionId, { type: "session.label.updated", version: 1, actor: "flywheel", payload: { label: title, shortLabel: title, name: title, lastUpdated } }),
        id: randomUUID(),
      })))
      if (titles.length > 0) recordMigration(db, { migrationId: MIGRATION_ID, factTypes: ["session.label.updated"], repaired: titles.length })
      recordChecked(db, MIGRATION_ID)
      db.exec("COMMIT")
      return { titled: titles.length }
    } catch (cause) { db.exec("ROLLBACK"); throw cause }
  } finally {
    db.close()
  }
}

function candidates(db: Database, after: number): string[] {
  return db.query<{ session_id: string }, [number]>(`
    select distinct session_id from event where type = 'session.created' and position > ?
    and json_valid(payload) and json_extract(payload, '$.kind') = 'workflow-agent'
  `).all(after).map(row => row.session_id)
}
