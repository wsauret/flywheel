import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { admitPrivateDatabaseFiles } from "../../../../infra/private-path.js"
import { applySqliteDurabilityPragmas } from "../../../../infra/sqlite-durability.js"
import { createSqliteEventReadSurface } from "../../../../infra/sqlite-event-read-surface.js"
import { createSqliteEventInserter } from "../../../../infra/sqlite-event-store-core.js"
import type { EventStoreAppend } from "../../../../infra/event-store-types.js"
import { checkedThrough, headPosition, recordChecked, recordMigration } from "../../../migrations/engine.js"
import { recoverSessionMetadata } from "../../../session/session-metadata-projection.js"
import { buildSessionChildLinkedFact, buildSessionChildUnlinkedFact, buildSessionCreatedFact, recoverWorkflowCreationRequest } from "../../../session/session-metadata-facts.js"
import { buildSessionMetadataAppend } from "../../../session/session-metadata-store.js"
import { parseWorkflowRunFact } from "../../../../workflows/run-facts.js"
import { workflowConversionDeletionTargets } from "./adopt-workflow-children.js"
import { workflowAgentGenerationPlan } from "./workflow-agent-generation-plan.js"
import { transferWorkflowAgentHistory } from "./workflow-agent-transfer.js"
import { sessionMessageSourcesSync, type SessionMessageSources } from "../../../session/session-message-sources.js"
import { closeOrchestrationReplyWaits } from "../../../session/message-owner-transfer.js"
import type { ReplayedSession } from "../../../session/schemas.js"
import { transferNestedChildren } from "../../../session/child-history-transfer.js"
import { retainAmbiguousPrivateInput } from "../../../session/private-reply-transfer.js"
import { observeReleaseMemoryPhase } from "../../../../infra/startup-trace.js"

const MIGRATION_ID = "workflow-agent-session-ownership"

function candidates(db: Database, after: number): string[] {
  return db.query<{ session_id: string }, [number]>(`
    select distinct session_id from event where type = 'session.created' and position > ?
    and json_valid(payload) and json_extract(payload, '$.kind') = 'workflow'
  `).all(after).map(row => row.session_id)
}

/** Shared-owner admission is read-only and incremental. */
export function workflowAgentSessionsNeedConversion(dbFile: string): boolean {
  if (!existsSync(dbFile)) return false
  const db = new Database(dbFile, { readonly: true })
  try {
    if (!db.query("select 1 from sqlite_master where type='table' and name='event'").get()) return false
    const reader = createSqliteEventReadSurface(db)
    const excluded = workflowConversionDeletionTargets(reader)
    return candidates(db, checkedThrough(db, MIGRATION_ID)).some(id =>
      !excluded.has(id) && recoverSessionMetadata(reader, id)?.kind === "workflow")
  } finally { db.close() }
}

/** Each workflow, including foreign references and disposition, commits or rolls back together.
 * Remove this conversion after 2027-10-17. */
export function convertWorkflowAgentSessions(dbFile: string) {
  if (!existsSync(dbFile)) return { converted: 0 }
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  let converted = 0
  observeReleaseMemoryPhase("conversion.begin")
  try {
    applySqliteDurabilityPragmas(db, 5000)
    const checked = checkedThrough(db, MIGRATION_ID)
    if (headPosition(db) <= checked) return { converted }
    const reader = createSqliteEventReadSurface(db)
    const readSources = sessionMessageSourcesSync(reader)
    const identities = new Map<string, ReplayedSession | null>()
    // The pass changes no session's kind or conversation, so it recovers each identity once,
    // and a chat that launched many workflows is not read again for every one of them.
    const identity = (sessionId: string): ReplayedSession | null => {
      if (!identities.has(sessionId)) identities.set(sessionId, recoverSessionMetadata(reader, sessionId))
      return identities.get(sessionId) ?? null
    }
    // SAFETY: SQLite returns one row for this connection's wal_autocheckpoint setting.
    const autoCheckpoint = db.query<{ wal_autocheckpoint: number }, []>("PRAGMA wal_autocheckpoint").get()!.wal_autocheckpoint
    // Automatic checkpoints repeatedly flush the same pages between workflows. Defer them to
    // connection close without merging the per-workflow failure boundaries.
    db.exec("PRAGMA wal_autocheckpoint = 0")
    try {
      for (const workflowId of candidates(db, checked)) {
        db.exec("BEGIN IMMEDIATE")
        try {
          if (convertWorkflow(db, workflowId, readSources, identity)) converted += 1
          db.exec("COMMIT")
        } catch (cause) { db.exec("ROLLBACK"); throw cause }
        observeReleaseMemoryPhase("conversion.workflow")
      }
      recordChecked(db, MIGRATION_ID)
    } finally { db.exec(`PRAGMA wal_autocheckpoint = ${autoCheckpoint}`) }
    return { converted }
  } finally {
    observeReleaseMemoryPhase("conversion.end")
    db.close()
  }
}

/** `readSources` folds the agent sessions that each earlier conversion committed, and the
 * ones this conversion inserts before it reads its transcripts. */
function convertWorkflow(db: Database, workflowId: string, readSources: () => SessionMessageSources, identity: (sessionId: string) => ReplayedSession | null): boolean {
  const reader = createSqliteEventReadSurface(db)
  const excluded = workflowConversionDeletionTargets(reader)
  if (excluded.has(workflowId)) return false
  const source = recoverSessionMetadata(reader, workflowId)
  if (source?.kind !== "workflow") return false
  const binding = source.launchedFrom
  const parent = binding && identity(binding.parentSessionId)
  if (!binding?.toolUseId || parent?.kind !== "chat" || excluded.has(binding.parentSessionId)) {
    throw new Error(`Workflow ${workflowId} has no admitted launching chat after adoption`)
  }
  const timestamp = Date.now()
  const plan = workflowAgentGenerationPlan(reader, workflowId)
  const original = reader.read({ aggregateId: `session:${workflowId}`, types: ["session.created"] })[0]
  const seed = reader.read({ aggregateId: `workflow:${workflowId}`, types: ["context.input.seeded"] })[0]
  const request = typeof seed?.payload.userRequest === "string" ? seed.payload.userRequest
    : original ? recoverWorkflowCreationRequest({ type: original.type, version: original.version, actor: original.actor, payload: original.payload }) : null
  const settings = {
    workflowDefinitionId: source.workflowDefinitionId, label: source.label, lastUpdated: source.lastUpdated,
    createdAt: source.createdAt ?? new Date(original?.timestamp ?? timestamp).toISOString(),
    roleAssignments: source.roleAssignments ?? { defaults: {}, overrides: {} },
    historicalResidualAggregateId: `session:${workflowId}`,
    ...(source.name !== undefined ? { name: source.name } : {}),
    ...(source.shortLabel !== undefined ? { shortLabel: source.shortLabel } : {}),
    ...(source.userNamed ? { userNamed: true as const } : {}),
    ...(source.executionCwd !== undefined ? { executionCwd: source.executionCwd } : {}),
    ...(source.authProfileId !== undefined ? { authProfileId: source.authProfileId } : {}),
  }
  const events: EventStoreAppend[] = [{
    aggregateId: `workflow:${workflowId}`, sessionId: workflowId, timestamp,
    ...parseWorkflowRunFact({ type: "workflow.run.registered", version: 1, actor: "flywheel", payload: {
      settings, request, launchedFrom: { ...binding, conversationId: parent.conversationId },
    } }),
  }]
  for (const generation of plan.generations) {
    events.push(buildSessionMetadataAppend(generation.sessionId, buildSessionCreatedFact({
      kind: "workflow-agent", command: "workflow-agent", conversationId: generation.conversationId,
      workflowMembership: generation.membership, importedResources: { workflowId, conversationId: generation.conversationId },
      launchedFrom: { parentSessionId: binding.parentSessionId, conversationId: parent.conversationId, toolUseId: binding.toolUseId },
      label: source.label, lifecycleState: "inactive", createdAt: settings.createdAt, lastUpdated: source.lastUpdated,
    }), timestamp))
    events.push(buildSessionMetadataAppend(binding.parentSessionId, buildSessionChildLinkedFact(generation.sessionId, source.lastUpdated), timestamp))
  }
  const inserter = createSqliteEventInserter(db)
  inserter.insertEventRows(events.map(event => ({ ...event, id: randomUUID() })))
  transferWorkflowAgentHistory(db, workflowId, plan.generations, readSources())
  retainAmbiguousPrivateInput(db, workflowId, binding.parentSessionId, parent.conversationId)
  transferNestedChildren(db, workflowId, new Map(plan.generations.map(generation => [generation.conversationId, generation.sessionId])), excluded, timestamp)
  closeOrchestrationReplyWaits(db, workflowId, excluded, readSources(), identity)
  inserter.insertEventRows([
    { ...buildSessionMetadataAppend(binding.parentSessionId, buildSessionChildUnlinkedFact(workflowId, source.lastUpdated), timestamp), id: randomUUID() },
    { id: randomUUID(), aggregateId: `session:${workflowId}`, sessionId: workflowId, timestamp,
      type: "session.representation.retired", version: 1, actor: "flywheel",
      payload: { migrationId: MIGRATION_ID, aggregateId: `workflow:${workflowId}`, recovery: [
        ...plan.gaps.map(position => ({ kind: "unreadable-control", position })),
        ...plan.conversationGaps.map(position => ({ kind: "unreadable-conversation", position })),
      ] } },
  ])
  recordMigration(db, { migrationId: MIGRATION_ID, factTypes: ["session.created", "session.representation.retired"], repaired: 1 })
  return true
}
