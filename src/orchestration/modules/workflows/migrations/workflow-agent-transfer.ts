import type { Database } from "bun:sqlite"
import { observeReleaseMemoryPhase } from "../../../../infra/startup-trace.js"
import type { ImportedWorkflowGeneration } from "./workflow-agent-generation-plan.js"
import { createSqliteEventReadSurface } from "../../../../infra/sqlite-event-read-surface.js"
import { includeLinkedEventOwnership, transferEventOwnership } from "../../../../infra/event-owner-transfer.js"
import { executionHistoryTransferPlan, EXECUTION_HISTORY_FACT_TYPES } from "../../../session/execution-history-transfer.js"
import { transferExecutionCells } from "../../../session/execution-cell-transfer.js"
import { transferPrivateReplies } from "../../../session/private-reply-transfer.js"
import { CorruptEventRowError } from "../../../../infra/event-store-types.js"
import { factTypes } from "../../../../infra/event-registry.js"
import { FileMutationFactSchemas } from "../../../session/file-mutation-facts.js"
import { readConversationSnapshotSync } from "../../../session/conversation/conversation-projection.js"
import { installedChildSessionHistory } from "../../../session/module-session-operations.js"
import type { SessionMessageSources } from "../../../session/session-message-sources.js"

/** Relational ownership changes preserve immutable evidence and its global ordering.
 * The caller holds the conversion transaction. Residual rows retain their bytes. */
export function transferWorkflowAgentHistory(db: Database, workflowId: string, generations: readonly ImportedWorkflowGeneration[], sources: SessionMessageSources): void {
  const conversations = new Map(generations.map(generation => [generation.conversationId, generation.sessionId]))
  const { execution, operations } = executionOwnership(db, workflowId, generations, conversations, sources)
  transferExecutionCells(db, workflowId, conversations, operations)
  for (const generation of generations) {
    db.query("update event set session_id = ? where aggregate_id = ? and session_id = ?")
      .run(generation.sessionId, `conversation:${generation.conversationId}`, workflowId)
    transferEventOwnership(db, execution.get(generation.sessionId) ?? [], generation.sessionId, `session:${generation.sessionId}`)
  }
  transferPrivateReplies(db, workflowId, conversations)
  copyContentClosures(db, workflowId, generations)
}

/** The source positions each generation owns, and the owner of each file operation.
 * Every anchor resolves to a generation, so a workflow without one keeps its whole
 * history as residual and reads none of it. */
function executionOwnership(db: Database, workflowId: string, generations: readonly ImportedWorkflowGeneration[], conversations: ReadonlyMap<string, string>, sources: SessionMessageSources) {
  const operations = new Map<string, string | null>()
  if (generations.length === 0) return { execution: new Map<string, readonly number[]>(), operations }
  const parentTools = new Map<string, string>()
  const reader = createSqliteEventReadSurface(db)
  const toolOwners = new Map<string, string | null>()
  for (const generation of generations) {
    const snapshot = readConversationSnapshotSync(reader, generation.conversationId, sources)
    observeReleaseMemoryPhase("conversion.generation.read")
    for (const entry of Object.values(snapshot.entriesById)) {
      if (entry.kind !== "message" || entry.message.kind !== "assistant" || !Array.isArray(entry.message.content)) continue
      for (const part of entry.message.content) {
        if (part.type !== "tool_use") continue
        const previous = toolOwners.get(part.id)
        toolOwners.set(part.id, previous === undefined || previous === generation.sessionId ? generation.sessionId : null)
      }
    }
  }
  for (const generation of generations) {
    if (generation.membership.kind === "historical-follow-up") continue
    const attemptId = generation.membership.attemptId
    const siblings = generations.filter(other => other.membership.kind !== "historical-follow-up" && other.membership.attemptId === attemptId)
    if (siblings.length === 1) parentTools.set(attemptId, generation.sessionId)
  }
  const executionPlan = new Map([...executionHistoryTransferPlan(reader, workflowId, conversations, parentTools)].map(([owner, positions]) => [owner, [...positions]]))
  const history = installedChildSessionHistory()
  const historical = reader.readTolerant({ aggregateId: `session:${workflowId}`, types: history.factTypes })
  const runs = new Map<string, string>()
  for (const row of historical) {
    if (row instanceof CorruptEventRowError) continue
    try {
      for (const run of history.loadRuns([row])) {
        const tool = run.parentToolUseId
        const owner = tool ? toolOwners.get(tool) : undefined
        if (owner) runs.set(run.childRunId, owner)
      }
    } catch { /* boundary: an incomplete or unreadable run supplies no ownership anchor. */ }
  }
  const transferableTypes = [...EXECUTION_HISTORY_FACT_TYPES, ...history.factTypes]
  for (const row of reader.readTolerant({ aggregateId: `session:${workflowId}`, types: transferableTypes })) {
    if (row instanceof CorruptEventRowError) continue
    const run = typeof row.payload.childRunId === "string" ? runs.get(row.payload.childRunId) : undefined
    const tool = typeof row.payload.toolUseId === "string" ? toolOwners.get(row.payload.toolUseId) : undefined
    const parent = typeof row.payload.parentToolUseId === "string" ? runs.get(row.payload.parentToolUseId) ?? toolOwners.get(row.payload.parentToolUseId) : undefined
    const owner = run ?? tool ?? parent
    if (!owner) continue
    const positions = executionPlan.get(owner)
    if (positions) positions.push(row.position)
    else executionPlan.set(owner, [row.position])
  }
  const execution = includeLinkedEventOwnership(db, `session:${workflowId}`, executionPlan, transferableTypes)
  const fileTypes = factTypes(FileMutationFactSchemas)
  const owners = new Map([...execution].flatMap(([owner, positions]) => positions.map(position => [position, owner] as const)))
  for (const event of reader.readTolerant({ aggregateId: `session:${workflowId}`, types: fileTypes })) {
    if (event instanceof CorruptEventRowError || typeof event.payload.operationId !== "string") continue
    const owner = owners.get(event.position)
    if (!owner) continue
    const previous = operations.get(event.payload.operationId)
    operations.set(event.payload.operationId, previous === undefined || previous === owner ? owner : null)
  }
  return { execution, operations }
}

const CONTENT_HASH = /[a-f0-9]{64}/g

/** Each generation receives the closure of the source content that its moved rows reach, and
 * the source scope keeps every row for residual facts. A reference is any source hash that the
 * raw bytes of a moved row or of a reached node contain, so damaged and unknown payloads keep
 * their indirect children without a decode. Copying the whole scope instead costs every
 * generation the bytes of all its siblings. */
function copyContentClosures(db: Database, workflowId: string, generations: readonly ImportedWorkflowGeneration[]): void {
  const available = new Set(db.query<{ sha256: string }, [string]>("select sha256 from tool_content where session_id = ?").all(workflowId).map(row => row.sha256))
  if (available.size === 0) return
  const events = db.query<{ payload: string }, [string]>("select payload from event where session_id = ?")
  const cells = db.query<{ payload: string }, [string]>("select payload from in_flight where session_id = ?")
  const node = db.query<{ content: string }, [string, string]>("select content from tool_content where session_id = ? and sha256 = ? and session_content_node = 1")
  const copy = db.query<unknown, [string, string, string]>(`insert into tool_content (session_id, sha256, content, bytes, session_content_node)
    select ?, sha256, content, bytes, session_content_node from tool_content where session_id = ? and sha256 = ?`)
  for (const generation of generations) {
    const pending = [...events.all(generation.sessionId), ...cells.all(generation.sessionId)].map(row => row.payload)
    const closure = new Set<string>()
    for (let text = pending.pop(); text !== undefined; text = pending.pop()) {
      for (const [hash] of text.matchAll(CONTENT_HASH)) {
        if (!available.has(hash) || closure.has(hash)) continue
        closure.add(hash)
        const children = node.get(workflowId, hash)
        if (children) pending.push(children.content)
      }
    }
    for (const hash of closure) copy.run(generation.sessionId, workflowId, hash)
  }
}
