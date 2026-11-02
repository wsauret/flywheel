import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, type EventStore } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { isWorkflowResumeCandidate } from "../../../../src/orchestration/session/resumable.js"
import { loadQueueSnapshotFromReader } from "../../../../src/workflows/view/view-store.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import type { WorkflowView } from "../../../../src/workflows/view/types.js"
import { publishTestWorkflow } from "./_session-manager-fixtures.js"
import { workflowSessionActions } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { workflowRunReader } from "../../../../src/orchestration/module-catalog.js"

const dirs: string[] = []
const stores: EventStore[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-resumable-summary-"))
  dirs.push(dir)
  return dir
}

function queueWithStatus(queue: WorkflowView, status: WorkflowView["status"]): WorkflowView {
  return {
    ...queue,
    cursor: status === "completed" ? queue.attempts.length : 0,
    status,
    attempts: queue.attempts.map((attempt) => ({ ...attempt, status: status === "completed" ? "completed" : "pending" })),
  }
}

async function seedQueue(store: EventStore, sessionId: string, status: WorkflowView["status"]): Promise<void> {
  const current = await loadQueueSnapshotFromReader(asAsyncEventReadSurface(store), sessionId)
  if (!current) throw new Error("published workflow requires a queue")
  const aggregateId = `workflow:${sessionId}`
  store.appendBatch(queueFactsForState(current, queueWithStatus(current, status)).map((fact) => ({
    aggregateId,
    ...fact,
    timestamp: Date.now(),
    sessionId,
  })))
}

afterEach(() => {
  // Stores first: an open database file keeps its directory undeletable on
  // Windows, so removing before closing fails the teardown.
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("workflow resumable summaries", () => {
  it("excludes completed workflows from resume affordances", () => {
    expect(isWorkflowResumeCandidate({
      kind: "workflow",
      lifecycleState: "inactive",
      workflowState: "completed",
    })).toBe(false)
  })

  it("uses fresh workflow control for run resume affordances, not session catalog rows", async () => {
    const baseDir = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    stores.push(store)
    const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
    const completedId = await publishTestWorkflow(manager, { workflowDefinitionId: "completed", name: "Completed" })
    await seedQueue(store, completedId, "completed")

    const pausedId = await publishTestWorkflow(manager, { workflowDefinitionId: "paused", name: "Paused" })
    await seedQueue(store, pausedId, "paused")

    const summaries = (await manager.listForIds([completedId, pausedId])).sessions
    expect(summaries).toEqual([])
    const reader = asAsyncEventReadSurface(store)
    expect(await workflowRunReader(reader).read(pausedId)).not.toBeNull()
    const completed = await loadQueueSnapshotFromReader(reader, completedId)
    const paused = await loadQueueSnapshotFromReader(reader, pausedId)
    expect(completed?.status).toBe("completed")
    expect(paused?.status).toBe("paused")
    expect(workflowSessionActions("inactive", completed?.status)).not.toContain("workflow.resume")
    expect(workflowSessionActions("inactive", paused?.status)).toContain("workflow.resume")
  })
})
