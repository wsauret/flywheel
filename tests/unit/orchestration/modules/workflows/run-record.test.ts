import { describe, expect, it } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface } from "../../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { createWorkflowPlacements, createWorkflowRunReader } from "../../../../../src/orchestration/modules/workflows/run-record.js"
import { workflowAdoption } from "../../../../../src/orchestration/modules/workflows/run-facts.js"
import { buildSessionMetadataAppend } from "../../../../../src/orchestration/session/session-metadata-store.js"
import { countStateRequests } from "../../../../helpers/state-requests.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { entriesVisited } from "../../../../helpers/entries-visited.js"
import { commitWorkflowEvent, publishWorkerAttempt } from "../../workflow-host/_workflow-host-fixtures.js"

const temporary = temporaryDirectories()

describe("workflow run reader", () => {
  it("validates a workflow's control once and advances it by each later fact, never rereading its history", async () => {
    const dir = temporary("flywheel-workflow-run-reader-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    try {
      const base = asAsyncEventReadSurface(store)
      const { manager, workflow } = await publishWorkerAttempt({ projectRoot: dir, reader: base, writer: asAsyncEventWriter(store), workflowId: "wf", attemptId: "a", conversationId: "conv-a" })
      let wholeReads = 0
      let factsRead = 0
      const reader: AsyncEventStateReadSurface = {
        ...base,
        readSlice: async (query, tolerant) => {
          const slice = await base.readSlice(query, tolerant)
          if (query.aggregateId === "workflow:wf" && query.types === undefined) {
            if (query.afterPosition === undefined && query.fromSeq === undefined) wholeReads++
            factsRead += slice.facts.length
          }
          return slice
        },
        readPage: async (query, upper, after, tolerant, content) => {
          const page = await base.readPage(query, upper, after, tolerant, content)
          if (query.aggregateId === "workflow:wf") {
            if (query.types === undefined && after === 0 && query.afterPosition === undefined) wholeReads++
            factsRead += page.facts.length
          }
          return page
        },
      }
      const runs = createWorkflowRunReader(reader)
      expect((await runs.readAttempt("wf", "a"))?.state._tag).toBe("running")
      expect((await createWorkflowRunReader(reader).readAttempt("wf", "a"))?.state._tag).toBe("running")
      expect(wholeReads).toBe(1)
      const historyRead = factsRead
      const seqBefore = await base.aggregateSeq("workflow:wf")

      await commitWorkflowEvent({ manager, projectionReader: base }, "wf", workflow, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: "a", conversationId: "conv-a", handoff: { summary: "done" }, reassessment: null } })
      expect((await runs.readAttempt("wf", "a"))?.state._tag).toBe("completed")
      // Every agent's start commits to this aggregate after every earlier
      // start: the reader folds only the facts the commit added, so a start
      // costs the same at any position in the run.
      expect(wholeReads).toBe(1)
      expect(factsRead - historyRead).toBe(await base.aggregateSeq("workflow:wf") - seqBefore)
    } finally {
      store.close()
    }
  })

  it("serves a workflow's parent without a durable read until a placement fact commits, and sees an adoption after skipped batches", async () => {
    const dir = temporary("flywheel-workflow-placements-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    try {
      const base = asAsyncEventReadSurface(store)
      const { manager, workflow } = await publishWorkerAttempt({ projectRoot: dir, reader: base, writer: asAsyncEventWriter(store), workflowId: "wf", attemptId: "a", conversationId: "conv-a" })
      const { reader, take } = countStateRequests(base)
      const placements = createWorkflowPlacements(reader)
      const parent = await placements.parent("wf")
      expect(parent).toBeDefined()
      take()
      // Each agent step commits control to the workflow's aggregate; none of it moves the workflow.
      const position = await base.capturePosition()
      await commitWorkflowEvent({ manager, projectionReader: base }, "wf", workflow, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: "a", conversationId: "conv-a", handoff: { summary: "done" }, reassessment: null } })
      const committed = (await base.readSlice({ aggregateId: "workflow:wf", afterPosition: position })).facts.flatMap((fact) => fact instanceof Error ? [] : [fact])
      expect(committed.length).toBeGreaterThan(0)
      take()
      placements.observe(committed)
      expect(await placements.parent("wf")).toBe(parent)
      expect(take()).toEqual([])
      const adoption = store.append({ ...workflowAdoption({ parentSessionId: "other-chat", conversationId: "other-conversation", toolUseId: "adopt" }, "2026-01-02T00:00:00.000Z"), aggregateId: "workflow:wf", sessionId: "wf", timestamp: 11 })
      placements.observe([adoption])
      expect(await placements.parent("wf")).toBe("other-chat")
      expect(take().length).toBeGreaterThan(0)
    } finally {
      store.close()
    }
  })

  it("folds a placement change through the same entries whatever the workflow count", async () => {
    // Every registration, adoption, and deletion folds into the held
    // placements: a fold that copied every run made each move cost every
    // workflow of the project.
    const visitsPerChange = async (workflows: number) => {
      const dir = temporary("flywheel-workflow-placement-cost-")
      const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
      try {
        const base = asAsyncEventReadSurface(store)
        await publishWorkerAttempt({ projectRoot: dir, reader: base, writer: asAsyncEventWriter(store), workflowId: "wf-0", attemptId: "a", conversationId: "conv-0" })
        const [registration] = (await base.readSlice({ aggregateId: "workflow:wf-0", types: ["workflow.run.registered"] })).facts
        if (!registration || registration instanceof Error) throw new Error("the published workflow has no registration")
        const { type, version, actor, payload } = registration
        for (let index = 1; index < workflows; index++) store.append({ type, version, actor, payload, aggregateId: `workflow:wf-${index}`, sessionId: `wf-${index}`, timestamp: 10 })
        const placements = createWorkflowPlacements(base)
        expect(await placements.parent("wf-0")).toBeDefined()
        return await entriesVisited(async () => {
          placements.observe([store.append({ ...workflowAdoption({ parentSessionId: "other-chat", conversationId: "other-conversation", toolUseId: "adopt" }, "2026-01-02T00:00:00.000Z"), aggregateId: "workflow:wf-0", sessionId: "wf-0", timestamp: 11 })])
          expect(await placements.parent("wf-0")).toBe("other-chat")
        })
      } finally {
        store.close()
      }
    }
    expect(await visitsPerChange(40)).toBe(await visitsPerChange(4))
  })

  it("sees an adoption that another process committed once it observes a later batch", async () => {
    const dir = temporary("flywheel-workflow-foreign-placement-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    // A headless run shares the project's store through its own connection,
    // whose commits this connection never announces.
    const other = createSqliteEventStore(resolveEventStoreDbFile(dir))
    try {
      const base = asAsyncEventReadSurface(store)
      await publishWorkerAttempt({ projectRoot: dir, reader: base, writer: asAsyncEventWriter(store), workflowId: "wf", attemptId: "a", conversationId: "conv-a" })
      const placements = createWorkflowPlacements(base)
      const parent = await placements.parent("wf")
      if (parent === undefined) throw new Error("the published workflow has no parent")
      other.append({ ...workflowAdoption({ parentSessionId: "other-chat", conversationId: "other-conversation", toolUseId: "adopt" }, "2026-01-02T00:00:00.000Z"), aggregateId: "workflow:wf", sessionId: "wf", timestamp: 11 })
      placements.observe([store.append(buildSessionMetadataAppend(parent, { type: "session.label.updated", version: 1, actor: "flywheel", payload: { label: "after", shortLabel: "after", name: "after", lastUpdated: "2026-01-03T00:00:00.000Z" } }))])
      expect(await placements.parent("wf")).toBe("other-chat")
    } finally {
      other.close()
      store.close()
    }
  })
})
