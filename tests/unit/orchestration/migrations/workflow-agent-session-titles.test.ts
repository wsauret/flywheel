import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js"
import { recoverSessionMetadata } from "../../../../src/orchestration/session/session-metadata-projection.js"
import { titleWorkflowAgentSessions } from "../../../../src/orchestration/modules/workflows/migrations/workflow-agent-session-titles.js"
import { cleanupTmpRoot, makeDepsWithStore, makeTmpDir, publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"

afterEach(cleanupTmpRoot)

/** A workflow agent session that a build before 2026-10-18 created, which
 *  carries its attempt id as its label. Remove with the pass after 2027-10-18. */
async function legacyAgentSession() {
  const projectRoot = makeTmpDir()
  const { deps, store } = makeDepsWithStore(projectRoot)
  const manager = createSessionManager(deps)
  const workflowId = await publishTestWorkflow(manager)
  const sessionId = await startTestWorkflowMember(manager, store, workflowId)
  const session = await recoverSessionMetadata(asAsyncEventReadSurface(store), sessionId)
  if (session?.kind !== "workflow-agent" || session.workflowMembership.kind !== "attempt") throw new Error("Expected a workflow agent session")
  const { attemptId } = session.workflowMembership
  store.append(buildSessionMetadataAppend(sessionId, {
    type: "session.label.updated", version: 1, actor: "flywheel",
    payload: { label: attemptId, shortLabel: attemptId, name: attemptId, lastUpdated: new Date(0).toISOString() },
  }))
  store.close()
  return { dbFile: resolveEventStoreDbFile(projectRoot), workflowId, sessionId, attemptId, projectRoot }
}

async function labelOf(projectRoot: string, sessionId: string) {
  const { store } = makeDepsWithStore(projectRoot)
  try { return (await recoverSessionMetadata(asAsyncEventReadSurface(store), sessionId))?.label } finally { store.close() }
}

describe("titleWorkflowAgentSessions", () => {
  it("does not skip a legacy creation that lands before the write transaction", async () => {
    const legacy = await legacyAgentSession()
    const writer = new Database(legacy.dbFile)
    const exec = Database.prototype.exec
    let inserted = false
    const hook = spyOn(Database.prototype, "exec").mockImplementation(function(this: Database, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && !inserted) {
        inserted = true
        writer.run(`
          insert into event (id, aggregate_id, seq, session_id, timestamp, type, version, actor, payload)
          select 'late-creation', 'session:late', 1, 'late', timestamp, type, version, actor,
            json_set(payload, '$.id', 'late', '$.label', ?, '$.shortLabel', ?, '$.name', ?)
          from event where type = 'session.created' and session_id = ?
        `, [legacy.attemptId, legacy.attemptId, legacy.attemptId, legacy.sessionId])
      }
      return exec.call(this, sql)
    })
    try {
      const first = titleWorkflowAgentSessions(legacy.dbFile)
      hook.mockRestore()
      expect(inserted).toBe(true)
      const second = titleWorkflowAgentSessions(legacy.dbFile)
      expect(first.titled + second.titled).toBe(2)
      expect(await labelOf(legacy.projectRoot, "late")).toBe("fixture-step")
    } finally { hook.mockRestore(); writer.close() }
  })
  it("titles an agent session labeled with its attempt id by its phase, and changes nothing on a second open", async () => {
    const legacy = await legacyAgentSession()
    expect(await labelOf(legacy.projectRoot, legacy.sessionId)).toBe(legacy.attemptId)

    expect(titleWorkflowAgentSessions(legacy.dbFile)).toEqual({ titled: 1 })
    expect(await labelOf(legacy.projectRoot, legacy.sessionId)).toBe("fixture-step")
    expect(titleWorkflowAgentSessions(legacy.dbFile)).toEqual({ titled: 0 })
  })

  it("keeps the label of a session whose run plan is unreadable", async () => {
    const legacy = await legacyAgentSession()
    const db = new Database(legacy.dbFile)
    try { db.run("update event set payload = '{' where aggregate_id = ?", [`workflow:${legacy.workflowId}`]) } finally { db.close() }

    expect(titleWorkflowAgentSessions(legacy.dbFile)).toEqual({ titled: 0 })
    expect(await labelOf(legacy.projectRoot, legacy.sessionId)).toBe(legacy.attemptId)
  })

  it("keeps a name that the person gave the session", async () => {
    const projectRoot = makeTmpDir()
    const { deps, store } = makeDepsWithStore(projectRoot)
    const manager = createSessionManager(deps)
    const workflowId = await publishTestWorkflow(manager)
    const sessionId = await startTestWorkflowMember(manager, store, workflowId)
    store.append(buildSessionMetadataAppend(sessionId, {
      type: "session.label.updated", version: 1, actor: "flywheel",
      payload: { label: "Mine", shortLabel: "Mine", name: "Mine", lastUpdated: new Date(0).toISOString(), userNamed: true },
    }))
    store.close()

    expect(titleWorkflowAgentSessions(resolveEventStoreDbFile(projectRoot))).toEqual({ titled: 0 })
    expect(await labelOf(projectRoot, sessionId)).toBe("Mine")
  })
})
