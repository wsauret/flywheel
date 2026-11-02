import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import type { StartupDirectories } from "../../src/infra/directory-authorities.js"
import { createSqliteEventStore } from "../../src/infra/sqlite-event-store.js"
import { prepareWorkspaceState } from "../../src/orchestration/workspace-state.js"

export const tolerantWorkspaceSessions = {
  legacyV1: "legacy-v1",
  legacyV2: "legacy-v2",
  retiredField: "retired-field",
  identityOnly: "identity-only",
  malformedTree: "malformed-tree",
  malformedDecorations: "malformed-decorations",
  invalidJson: "invalid-json",
  newerVersion: "newer-version",
  tombstone: "tombstone",
  strictWorkflow: "strict-workflow",
} as const

const NOW = "2023-11-14T22:13:20.000Z"

/** Create one isolated historical workspace and run its normal startup preparation. */
export function createTolerantReprojectionWorkspace(directories: StartupDirectories): { readonly dbFile: string; readonly beforeBytes: ReadonlyMap<string, string[]> } {
  mkdirSync(directories.projectRoot, { recursive: true })
  const initial = prepareWorkspaceState(directories)
  initial.generation.release()
  const store = createSqliteEventStore(initial.dbFile)
  const append = (sessionId: string, type: string, version: number, payload: Record<string, unknown>, aggregateId = `session:${sessionId}`) => {
    store.append({ aggregateId, sessionId, type, version, actor: type.startsWith("workflow.") ? "workflow" : "flywheel", timestamp: Date.now(), payload })
  }
  const current = (sessionId: string, extra: Record<string, unknown> = {}) => ({
    kind: "chat", command: "chat", conversationId: `${sessionId}-conversation`, label: sessionId, name: sessionId,
    lastUpdated: NOW, lifecycleState: "inactive", executionCwd: directories.executionCwd, ...extra,
  })
  try {
    append(tolerantWorkspaceSessions.legacyV1, "session.created", 1, { kind: "chat", command: "chat", conversationId: "legacy-v1-conversation", label: "legacy-v1", lifecycleState: "inactive" })
    append(tolerantWorkspaceSessions.legacyV2, "session.created", 2, { kind: "chat", command: "chat", conversationId: "legacy-v2-conversation", label: "legacy-v2", lifecycleState: "inactive" })
    append(tolerantWorkspaceSessions.retiredField, "session.created", 3, current(tolerantWorkspaceSessions.retiredField, { temporary: true }))
    append(tolerantWorkspaceSessions.identityOnly, "session.created", 3, { kind: "chat", command: "chat", conversationId: "identity-only-conversation", label: "identity-only", lastUpdated: NOW, lifecycleState: "inactive" })
    for (const id of [tolerantWorkspaceSessions.malformedTree, tolerantWorkspaceSessions.malformedDecorations]) append(id, "session.created", 3, current(id))
    append(tolerantWorkspaceSessions.invalidJson, "session.created", 3, current(tolerantWorkspaceSessions.invalidJson))
    append(tolerantWorkspaceSessions.newerVersion, "session.created", 5, { shape: "newer-binary", opaque: [1, 2, 3] })
    append(tolerantWorkspaceSessions.tombstone, "session.created", 3, current(tolerantWorkspaceSessions.tombstone))
    append(tolerantWorkspaceSessions.tombstone, "session.deleted", 1, { lastUpdated: NOW })
    append(tolerantWorkspaceSessions.strictWorkflow, "session.created", 3, { kind: "workflow", command: "workflow", workflowDefinitionId: "strict", label: "strict", name: "strict", lastUpdated: NOW, lifecycleState: "inactive", executionCwd: directories.executionCwd })

    for (const id of [tolerantWorkspaceSessions.legacyV1, tolerantWorkspaceSessions.legacyV2, tolerantWorkspaceSessions.retiredField, tolerantWorkspaceSessions.identityOnly, tolerantWorkspaceSessions.malformedTree, tolerantWorkspaceSessions.malformedDecorations]) {
      const conversationId = `${id}-conversation`
      append(id, "chat.tree.created", 1, { conversationId, createdAt: NOW }, `conversation:${conversationId}`)
      append(id, "chat.entries.appended", 1, { conversationId, entries: [{ kind: "message", id: `${id}-entry`, parentId: null, timestamp: NOW, message: { kind: "user", content: `readable-${id}` } }] }, `conversation:${conversationId}`)
    }
    append(tolerantWorkspaceSessions.malformedTree, "chat.entries.appended", 1, { conversationId: "malformed-tree-conversation", entries: [{ kind: "message", id: "malformed-tree-orphan", parentId: "malformed-tree-entry", timestamp: NOW, message: { kind: "toolResult", toolUseId: "missing-tool", content: [{ type: "text", text: "orphan" }] } }] }, "conversation:malformed-tree-conversation")
    append(tolerantWorkspaceSessions.malformedDecorations, "tool.result.recorded", 1, {})
  } finally {
    store.close()
  }

  const db = new Database(initial.dbFile)
  db.query("UPDATE event SET payload = ? WHERE session_id = ? AND type = 'session.created'").run("{{invalid-json", tolerantWorkspaceSessions.invalidJson)
  db.close()

  const beforeBytes = readSessionPayloadBytes(initial.dbFile)
  const prepared = prepareWorkspaceState(directories)
  prepared.generation.release()
  const strictStore = createSqliteEventStore(prepared.dbFile)
  strictStore.append({ aggregateId: `workflow:${tolerantWorkspaceSessions.strictWorkflow}`, sessionId: tolerantWorkspaceSessions.strictWorkflow, type: "workflow.control.committed", version: 2, actor: "workflow", timestamp: Date.now(), payload: { malformed: true } })
  strictStore.close()
  return { dbFile: prepared.dbFile, beforeBytes }
}

export function readSessionPayloadBytes(dbFile: string): ReadonlyMap<string, string[]> {
  const db = new Database(dbFile, { readonly: true })
  try {
    const rows = db.query<{ sessionId: string; bytes: string }, []>("SELECT session_id AS sessionId, hex(payload) AS bytes FROM event ORDER BY position").all()
    const result = new Map<string, string[]>()
    for (const row of rows) result.set(row.sessionId, [...(result.get(row.sessionId) ?? []), row.bytes])
    return result
  } finally {
    db.close()
  }
}
