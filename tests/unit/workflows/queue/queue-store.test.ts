import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { factDescriptors } from "../../../../src/infra/event-registry.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { WorkflowQueueFactSchemas } from "../../../../src/workflows/view/view-facts.js"
import { createWorkflowViewStore, loadQueueSnapshotFromReader, pruneSupersededWorkflowViewFacts, readWorkflowStatees } from "../../../../src/workflows/view/view-store.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import type { WorkflowView, AttemptRow } from "../../../../src/workflows/view/types.js"
import { QueueV9Schema, type WorkflowPlanSchema } from "../../../../src/workflows/view/schemas.js"
import { Schema } from "effect"
import type { WorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { makeQueueStores } from "./_persistence-fixtures.js"
import { initializedWorkflowRoot } from "../../../helpers/workflow-root-fixtures.js"
import { plainAgentTree } from "../../../helpers/workflow-view.js"
import { buildWorkflowControlCommittedFact } from "../../../../src/workflows/vm/session-facts.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"

/** The version each queue fact type is registered at. A fact literal in this
 *  suite carries the registered version rather than a pinned number, so a fact
 *  version bump is a migration concern and not a test edit. */
const registeredQueueFactVersions = new Map(
  factDescriptors(WorkflowQueueFactSchemas).map(({ type, version }) => [type, version]),
)

function queueFactVersion(type: string): number {
  const version = registeredQueueFactVersions.get(type)
  if (version === undefined) throw new Error(`unregistered queue fact type ${type}`)
  return version
}

let tmpDir = ""

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
  tmpDir = ""
})

function makeTmpDir(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "queue-store-test-"))
  return tmpDir
}

function attempt(id: string): AttemptRow {
  return {
    id,
    definitionId: "work",
    briefId: "fly.implement",
    workflowDefinitionId: "wf",
    name: id,
    status: "pending",
    writes: [],
    resumeRevertCount: 0,
  }
}

function planned(after: string, status: "pending" | "conditional" | "skipped"): typeof WorkflowPlanSchema.Type.steps[number] {
  return { id: `${after}:planned:1`, after, definitionId: "verify", contentId: "debug.verify", name: "Verify", status }
}

function createQueue(attempts: AttemptRow[]): WorkflowView {
  return { attempts, tree: plainAgentTree(attempts.map((row) => ({ ...row, status: "pending" }))), cursor: 0, status: "idle", mutationLog: [] }
}

/** `queue` with the status of attempt `id` changed, and the change logged. */
function transitioned(queue: WorkflowView, id: string, status: AttemptRow["status"], provenance: { actor: string; reason: string }): WorkflowView {
  if (!queue.attempts.some((row) => row.id === id)) throw new Error(`Missing attempt ${id}`)
  return {
    ...queue,
    attempts: queue.attempts.map((row) => row.id === id ? { ...row, status } : row),
    mutationLog: [...queue.mutationLog, { timestamp: Date.now(), action: "status-change", attemptIds: [id], ...provenance }],
  }
}

function appendWorkflowFacts(
  store: ReturnType<typeof createSqliteEventStore>,
  sessionId: string,
  facts: readonly WorkflowSessionFact[],
): void {
  if (store.countByAggregate(`workflow:${sessionId}`) === 0) {
    store.append({
      aggregateId: `workflow:${sessionId}`,
      type: "workflow.control.initialized",
      version: initializedWorkflowRoot.version,
      timestamp: 1,
      actor: "flywheel",
      sessionId,
      payload: initializedWorkflowRoot.payload,
    })
  }
  for (const [index, fact] of facts.entries()) {
    store.append({
      aggregateId: `workflow:${sessionId}`,
      ...fact,
      timestamp: index + 2,
      sessionId,
    })
  }
}

describe("queueFactsForState", () => {
  it("publishes one canonical tree at launch, then each changed node, and a whole tree whose structure changed", () => {
    const queue = createQueue([attempt("s1")])
    expect(queueFactsForState(null, queue).map(({ type, version }) => [type, version])).toEqual([["queue.created", 10], ["queue.tree.changed", 4]])
    expect(queueFactsForState(queue, queue)).toEqual([])
    const [first, ...others] = queue.tree.nodes
    if (!first) throw new Error("Expected a tree node")
    const changed: WorkflowView = { ...queue, tree: { nodes: [{ ...first, disposition: "completed" }, ...others] } }
    expect(queueFactsForState(queue, changed).map(({ type, payload }) => [type, payload])).toEqual([["queue.tree.node.changed", { node: { ...first, disposition: "completed" }, currentAgentNodeId: null }]])
    const restructured: WorkflowView = { ...queue, tree: { nodes: others } }
    expect(queueFactsForState(queue, restructured).map(({ type, version }) => [type, version])).toEqual([["queue.tree.changed", 4]])
  })
  it("emits no facts for an unchanged queue regardless of key order", () => {
    // The prior JSON.stringify short-circuit was order-sensitive; the diff is
    // now the single arbiter of change and must yield no facts when current and
    // target are structurally equal even if their object keys are ordered
    // differently.
    const base = transitioned(createQueue([attempt("s1")]), "s1", "running", { actor: "flywheel", reason: "starting" })

    const reordered: WorkflowView = {
      cursor: base.cursor,
      mutationLog: base.mutationLog.map((entry) => ({
        attemptIds: [...entry.attemptIds],
        reason: entry.reason,
        actor: entry.actor,
        action: entry.action,
        timestamp: entry.timestamp,
      })),
      status: base.status,
      attempts: base.attempts.map((row) => ({ ...row })),
      tree: base.tree,
    }

    expect(queueFactsForState(base, reordered)).toEqual([])
  })

  it("emits workflow-owned facts for a real status change", () => {
    const current = createQueue([attempt("s1")])
    const target = transitioned(createQueue([attempt("s1")]), "s1", "running", { actor: "flywheel", reason: "starting" })

    const facts = queueFactsForState(current, target)
    expect(facts.map((fact) => fact.type)).toEqual([
      "queue.mutated",
      "step.status.changed",
    ])
    expect(facts.every((fact) => fact.actor === "flywheel")).toBe(true)
    expect(facts[0]).toMatchObject({ type: "queue.mutated", version: queueFactVersion("queue.mutated") })
  })
})

describe("WorkflowViewStore", () => {
  it("replays queue creation and attempt status facts from the workflow aggregate", async () => {
    const baseDir = makeTmpDir()
    const sessionId = "queue-replay"
    const current = createQueue([attempt("s1")])
    const target = transitioned(createQueue([attempt("s1")]), "s1", "running", { actor: "flywheel", reason: "starting" })
    expect(queueFactsForState(null, current)[0]).toMatchObject({ type: "queue.created", version: queueFactVersion("queue.created") })

    const stores = makeQueueStores(baseDir, sessionId)
    appendWorkflowFacts(stores.store, sessionId, [
      ...queueFactsForState(null, current),
      ...queueFactsForState(current, target),
    ])
    const projection = createWorkflowViewStore({ sessionId, reader: asAsyncEventReadSurface(stores.store) })
    const loaded = await projection.loadQueue()
    projection.dispose()
    stores.writer.dispose()
    stores.store.close()

    expect(loaded?.attempts.map((item) => item.status)).toEqual(["running"])
    const eventStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    try {
      expect(eventStore.read({ aggregateId: `workflow:${sessionId}` }).map((event) => event.type)).toEqual([
        "workflow.control.initialized",
        "queue.created",
        "queue.tree.changed",
        "queue.mutated",
        "step.status.changed",
      ])
    } finally {
      eventStore.close()
    }
  })

  it("memoizes the decoded queue across unchanged reads", async () => {
    const baseDir = makeTmpDir()
    const sessionId = "queue-live"
    const stores = makeQueueStores(baseDir, sessionId)
    appendWorkflowFacts(stores.store, sessionId, queueFactsForState(null, createQueue([attempt("s1")])))
    let queueHistoryReads = 0
    const direct = asAsyncEventReadSurface(stores.store)
    const reader: AsyncEventStateReadSurface = {
      ...direct,
      readPage: async (...args) => {
        queueHistoryReads += 1
        return direct.readPage(...args)
      },
    }
    const projection = createWorkflowViewStore({ sessionId, reader })
    const first = await projection.loadQueue()
    const readsAfterSeed = queueHistoryReads

    const second = await projection.loadQueue()

    projection.dispose()
    stores.writer.dispose()
    stores.store.close()
    expect(second).toBe(first)
    expect(queueHistoryReads).toBe(readsAfterSeed)
  })

  // A Resume that reruns an item agent and a later phase inserts rows after
  // two anchors in one mutation, which the current version stores row by
  // row. Versions 9 and 10 stored one run at one index, clamped to the rows,
  // and appended it when they stored no index.
  const insertedRow = (id: string) => ({ id, definitionId: "work", contentId: "fly.implement", workflowDefinitionId: "wf", name: id, status: "pending" as const, writes: [], resumeRevertCount: 0 })
  const insertMutation = { timestamp: 1, action: "insert", actor: "retry", reason: "retry attempt" }
  const twoPlaces = createQueue([attempt("s1"), attempt("s2")])
  it.each<[string, (current: WorkflowView) => readonly WorkflowSessionFact[], readonly string[]]>([
    ["the current version, at two places", (current) => queueFactsForState(current, {
      ...current,
      attempts: [attempt("s1"), attempt("a"), attempt("s2"), attempt("b")],
      mutationLog: [{ ...insertMutation, attemptIds: ["a", "b"] }],
    }), ["s1", "a", "s2", "b"]],
    ["version 10 at its index", () => [{ type: "queue.mutated", version: 10, actor: "flywheel", payload: { mutation: { ...insertMutation, attemptIds: ["a", "b"] }, insertedAttempts: [attempt("a"), attempt("b")], insertIndex: 1 } }], ["s1", "a", "b", "s2"]],
    ["version 10 with no index", () => [{ type: "queue.mutated", version: 10, actor: "flywheel", payload: { mutation: { ...insertMutation, attemptIds: ["a", "b"] }, insertedAttempts: [attempt("a"), attempt("b")] } }], ["s1", "s2", "a", "b"]],
    ["version 10 past the end", () => [{ type: "queue.mutated", version: 10, actor: "flywheel", payload: { mutation: { ...insertMutation, attemptIds: ["a"] }, insertedAttempts: [attempt("a")], insertIndex: 9 } }], ["s1", "s2", "a"]],
    ["version 9 at its index", () => [{ type: "queue.mutated", version: 9, actor: "flywheel", payload: { mutation: { ...insertMutation, stepIds: ["a", "b"] }, insertedSteps: [insertedRow("a"), insertedRow("b")], insertIndex: 0 } }], ["a", "b", "s1", "s2"]],
  ])("replays inserted attempts of %s", async (_, mutation, order) => {
    const baseDir = makeTmpDir()
    const sessionId = "queue-insert"
    const stores = makeQueueStores(baseDir, sessionId)
    appendWorkflowFacts(stores.store, sessionId, [...queueFactsForState(null, twoPlaces), ...mutation(twoPlaces)])
    const projection = createWorkflowViewStore({ sessionId, reader: asAsyncEventReadSurface(stores.store) })
    const loaded = await projection.loadQueue()
    projection.dispose()
    stores.writer.dispose()
    stores.store.close()

    expect(loaded?.attempts.map((item) => item.id)).toEqual([...order])
    expect(loaded?.mutationLog.map((entry) => entry.action)).toEqual(["insert"])
  })

  it("reads historical planned entries into conditional and skipped agents", async () => {
    const baseDir = makeTmpDir()
    const sessionId = "queue-plan"
    const stores = makeQueueStores(baseDir, sessionId)
    const reader = asAsyncEventReadSurface(stores.store)
    try {
      const first = initializedWorkflowRoot.payload.control.attempts[0]!
      // A build before 2026-10-16 wrote version 9 rows, which named steps.
      const rows = { steps: [{ id: first.id, definitionId: "work", contentId: "fly.implement", workflowDefinitionId: "wf", name: first.id, status: "pending", writes: [], resumeRevertCount: 0 }], cursor: 0, status: "idle", mutationLog: [] }
      appendWorkflowFacts(stores.store, sessionId, [
        { type: "queue.created", version: 9, actor: "flywheel", payload: { queue: Schema.decodeUnknownSync(QueueV9Schema)(rows) } },
        { type: "queue.plan.changed", version: 2, actor: "flywheel", payload: { plan: { conditionalStepIds: [], steps: [planned(first.id, "conditional")] } } },
        buildWorkflowControlCommittedFact("invalid-terminal-identity", { type: "START" }),
      ])
      expect(() => replayWorkflowControl(stores.store.read({ aggregateId: `workflow:${sessionId}` }))).toThrow()
      expect((await readWorkflowStatees([sessionId], reader)).statuses.get(sessionId)).toBe("idle")
      expect((await loadQueueSnapshotFromReader(reader, sessionId))?.tree.nodes.filter(({ kind }) => kind === "agent")).toEqual([
        expect.objectContaining({ id: first.id, definitionId: "work" }),
        expect.objectContaining({ id: `${first.id}:planned:1`, definitionId: "verify", label: "Verify", disposition: "conditional" }),
      ])
      appendWorkflowFacts(stores.store, sessionId, [
        { type: "queue.plan.changed", version: 2, actor: "flywheel", payload: { plan: { conditionalStepIds: [], steps: [planned(first.id, "skipped")] } } },
      ])
      expect((await loadQueueSnapshotFromReader(reader, sessionId))?.tree.nodes.at(-1)?.disposition).toBe("skipped")
    } finally {
      stores.writer.dispose()
      stores.store.close()
    }
  })
})

describe("readWorkflowStatees", () => {
  it("isolates an uninitialized workflow aggregate from healthy sessions", async () => {
    const baseDir = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    const malformed = queueFactsForState(null, createQueue([attempt("bad-step")]))[0]
    const healthy = queueFactsForState(null, createQueue([attempt("healthy-step")]))[0]
    if (!malformed || !healthy) throw new Error("queue creation facts are required")
    store.append({
      aggregateId: "workflow:malformed",
      type: malformed.type,
      version: malformed.version,
      timestamp: 1,
      actor: malformed.actor,
      sessionId: "malformed",
      payload: malformed.payload,
    })
    store.append({
      aggregateId: "workflow:healthy",
      type: "workflow.control.initialized",
      version: initializedWorkflowRoot.version,
      timestamp: 2,
      actor: "flywheel",
      sessionId: "healthy",
      payload: initializedWorkflowRoot.payload,
    })
    store.append({
      aggregateId: "workflow:healthy",
      type: healthy.type,
      version: healthy.version,
      timestamp: 3,
      actor: healthy.actor,
      sessionId: "healthy",
      payload: healthy.payload,
    })

    try {
      const result = await readWorkflowStatees(["malformed", "healthy"], asAsyncEventReadSurface(store))

      expect(result.statuses).toEqual(new Map([["healthy", "idle"]]))
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatchObject({ sessionId: "malformed" })
      expect(result.errors[0]?.reason).toContain("workflow.control.initialized")
    } finally {
      store.close()
    }
  })

  it.each([2, 20])("advances status refreshes with fixed requests for %s workflows", async (members) => {
    const baseDir = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    const sessionIds = ["running", "deleted", ...Array.from({ length: members - 2 }, (_, index) => `idle-${index}`)]
    for (const sessionId of sessionIds) {
      const queue = createQueue([attempt(`${sessionId}-attempt`)])
      appendWorkflowFacts(store, sessionId, queueFactsForState(null, queue))
      if (sessionId === "running") {
        const changed = { ...queue, status: "running" as const }
        appendWorkflowFacts(store, sessionId, queueFactsForState(queue, changed))
      } else if (sessionId === "deleted") {
        store.append({
          aggregateId: `workflow:${sessionId}`,
          type: "queue.deleted",
          version: 1,
          timestamp: 10,
          actor: "flywheel",
          sessionId,
          payload: {},
        })
      }
    }
    const counter = countStateRequests(asAsyncEventReadSurface(store))

    try {
      const result = await readWorkflowStatees(sessionIds, counter.reader)
      expect(result.statuses.get("running")).toBe("running")
      expect(result.statuses.get("deleted")).toBeUndefined()
      expect(result.errors).toEqual([])
      counter.take()
      await readWorkflowStatees(sessionIds, counter.reader)
      expect(counter.take()).toHaveLength(1)
      appendWorkflowFacts(store, "running", [{ type: "queue.state.changed", version: 2, actor: "flywheel", payload: { status: "paused", cursor: 0, maxAttempts: null } }])
      const changed = await readWorkflowStatees(sessionIds, counter.reader)
      expect(changed.statuses.get("running")).toBe("paused")
      const requests = counter.take()
      expect(requests).toHaveLength(1)
      expect(factsRead(requests)).toBe(1)
    } finally {
      store.close()
    }
  })

  it.each([2, 20])("reads only the named workflow's history with %s other workflows in the store", async (others) => {
    const baseDir = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    for (let index = 0; index < others; index += 1) {
      appendWorkflowFacts(store, `other-${index}`, queueFactsForState(null, createQueue([attempt(`other-${index}-attempt`)])))
    }
    const named = createQueue([attempt("named-attempt")])
    appendWorkflowFacts(store, "named", queueFactsForState(null, named))
    const namedFacts = store.read({ aggregateId: "workflow:named" }).length
    const counter = countStateRequests(asAsyncEventReadSurface(store))

    try {
      const result = await readWorkflowStatees(["named"], counter.reader)
      expect(result.statuses.get("named")).toBe(named.status)
      expect(factsRead(counter.take())).toBe(namedFacts)
      appendWorkflowFacts(store, "other-0", [{ type: "queue.state.changed", version: 2, actor: "flywheel", payload: { status: "paused", cursor: 0, maxAttempts: null } }])
      appendWorkflowFacts(store, "named", [{ type: "queue.state.changed", version: 2, actor: "flywheel", payload: { status: "paused", cursor: 0, maxAttempts: null } }])
      expect((await readWorkflowStatees(["named"], counter.reader)).statuses.get("named")).toBe("paused")
      expect(factsRead(counter.take())).toBe(2)
    } finally {
      store.close()
    }
  })

  it("strictly parses the latest status fact and isolates its error", async () => {
    const baseDir = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    const healthy = createQueue([attempt("healthy-step")])
    appendWorkflowFacts(store, "healthy-status", queueFactsForState(null, healthy))
    appendWorkflowFacts(store, "malformed-status", queueFactsForState(null, createQueue([attempt("malformed-step")])))
    store.append({
      aggregateId: "workflow:malformed-status",
      type: "queue.state.changed",
      version: 2,
      timestamp: 10,
      actor: "flywheel",
      sessionId: "malformed-status",
      payload: { status: "bogus", cursor: 0, maxAttempts: null },
    })

    try {
      const result = await readWorkflowStatees(["malformed-status", "healthy-status"], asAsyncEventReadSurface(store))
      expect(result.statuses).toEqual(new Map([["healthy-status", "idle"]]))
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatchObject({ sessionId: "malformed-status" })
      expect(result.errors[0]?.reason).toContain("queue.state.changed")
    } finally {
      store.close()
    }
  })

  it("isolates a corrupt latest status row from healthy sessions", async () => {
    const baseDir = makeTmpDir()
    const file = resolveEventStoreDbFile(baseDir)
    const store = createSqliteEventStore(file)
    appendWorkflowFacts(store, "corrupt-status", queueFactsForState(null, createQueue([attempt("corrupt-step")])))
    appendWorkflowFacts(store, "healthy-corrupt-peer", queueFactsForState(null, createQueue([attempt("healthy-step")])))
    const db = new Database(file)
    db.run("update event set payload = '{{{not-json' where session_id = ? and type = 'queue.created'", ["corrupt-status"])
    db.close()

    try {
      const result = await readWorkflowStatees(["corrupt-status", "healthy-corrupt-peer"], asAsyncEventReadSurface(store))
      expect(result.statuses).toEqual(new Map([["healthy-corrupt-peer", "idle"]]))
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatchObject({ sessionId: "corrupt-status" })
      expect(result.errors[0]?.reason).toContain("corrupt event row")
    } finally {
      store.close()
    }
  })

  it("rejects a status change without a preceding queue creation", async () => {
    const baseDir = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    appendWorkflowFacts(store, "orphan-status", [])
    store.append({
      aggregateId: "workflow:orphan-status",
      type: "queue.state.changed",
      version: 1,
      timestamp: 2,
      actor: "flywheel",
      sessionId: "orphan-status",
      payload: { status: "running", cursor: 0 },
    })

    try {
      const result = await readWorkflowStatees(["orphan-status"], asAsyncEventReadSurface(store))
      expect(result.statuses).toEqual(new Map())
      expect(result.errors[0]?.reason).toContain("queue.created has not been observed")
    } finally {
      store.close()
    }
  })
})

describe("stored workflow trees", () => {
  it("reloads canonical trees and writes version 4 for every workflow", async () => {
    const baseDir = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    try {
      const list = { id: "g:phase:1", kind: "phase", form: "list", phaseId: "finds", label: "Hunt", parentId: null, disposition: "completed", list: { id: "g", expanded: true }, join: { reducer: "dedupe@1", state: "settled", slots: 1, completed: 1, failed: 0, pending: 0, missing: 0, selection: { verb: "kept", kept: 1, dropped: 0 } } } as const
      const before: WorkflowView = { ...createQueue([attempt("s1")]), tree: { nodes: [list] } }
      const looped: WorkflowView = { ...createQueue([attempt("s1")]), tree: { nodes: [
        { id: "loop", kind: "repeat", label: "Hunt", parentId: null, disposition: "completed", loop: { iteration: 1, maxIterations: 3, outcome: "dry" } },
        { ...list, id: "loop:round:1:node:1:phase:1", parentId: "loop", list: { id: "loop:round:1:node:1", expanded: true }, round: { number: 1, outcome: "dry" } },
      ] } }
      appendWorkflowFacts(store, "before", queueFactsForState(null, before))
      appendWorkflowFacts(store, "looped", queueFactsForState(null, looped))
      const reader = asAsyncEventReadSurface(store)
      expect(store.read({ aggregateId: "workflow:looped", types: ["queue.tree.changed"] }).map(({ version }) => version)).toEqual([4])
      expect((await loadQueueSnapshotFromReader(reader, "before"))?.tree).toEqual(before.tree)
      expect((await loadQueueSnapshotFromReader(reader, "looped"))?.tree).toEqual(looped.tree)
    } finally {
      store.close()
    }
  })
})

describe("pruneSupersededWorkflowViewFacts", () => {
  it("drops superseded replace-only rows without changing the rebuilt view", async () => {
    const baseDir = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    try {
      const sessionId = "prunable"
      const q0 = createQueue([attempt("s1"), attempt("s2")])
      appendWorkflowFacts(store, sessionId, queueFactsForState(null, q0))
      const revisions: WorkflowView[] = []
      let current = q0
      const advance = (revise: (queue: WorkflowView) => WorkflowView): void => {
        const target = revise(current)
        appendWorkflowFacts(store, sessionId, queueFactsForState(current, target))
        revisions.push(target)
        current = target
      }
      /** `queue` with each attempt's resume state from `resume`, by attempt index. */
      const resumed = (queue: WorkflowView, resume: readonly ({ readonly resumeRevertCount: number; readonly lastConversationId?: string } | undefined)[]): WorkflowView =>
        ({ ...queue, attempts: queue.attempts.map((row, index) => ({ ...row, ...resume[index] })) })
      advance((queue) => ({ ...queue, status: "running" }))
      advance((queue) => resumed({ ...queue, status: "paused" }, [{ resumeRevertCount: 1, lastConversationId: "conv-1" }]))
      advance((queue) => ({ ...resumed({ ...queue, status: "running" }, [{ resumeRevertCount: 2, lastConversationId: "conv-2" }, { resumeRevertCount: 1 }]), followUpConversationId: "follow-1" }))
      advance((queue) => ({ ...queue, followUpConversationId: "follow-2" }))
      appendWorkflowFacts(store, sessionId, [
        { type: "queue.plan.changed", version: 2, actor: "flywheel", payload: { plan: { conditionalStepIds: ["s2"], steps: [] } } },
        { type: "queue.plan.changed", version: 2, actor: "flywheel", payload: { plan: { conditionalStepIds: [], steps: [planned("s2", "skipped")] } } },
      ])
      const phase = { id: "p", kind: "phase", form: "single", phaseId: "build", label: "build", parentId: null } as const
      advance((queue) => ({ ...queue, tree: { nodes: [{ ...phase, disposition: "running" }] } }))
      // An unchanged tree writes no fact; a new structure replaces the last
      // tree, and a changed node replaces that node's last change.
      advance((queue) => ({ ...queue, status: "paused" }))
      advance((queue) => ({ ...queue, tree: { nodes: [{ ...phase, disposition: "failed" }] } }))
      advance((queue) => ({ ...queue, tree: { nodes: [{ ...phase, disposition: "completed" }] } }))
      expect(store.read({ aggregateId: `workflow:${sessionId}`, types: ["queue.tree.changed"] })).toHaveLength(2)
      expect(store.read({ aggregateId: `workflow:${sessionId}`, types: ["queue.tree.node.changed"] })).toHaveLength(2)

      const projectionReader = asAsyncEventReadSurface(store)
      const before = await loadQueueSnapshotFromReader(projectionReader, sessionId)
      const resumeStateRows = store.read({ aggregateId: `workflow:${sessionId}`, types: ["step.resume_state.recorded"] }).length

      const pruned = await pruneSupersededWorkflowViewFacts(projectionReader, asAsyncEventWriter(store), sessionId)

      // Four queue.state.changed revisions keep one, two follow-up revisions
      // keep one, two plan revisions keep one, two tree revisions keep one,
      // two changes of node p keep the newest, and s1's two revert revisions
      // keep the newest while s2's single row survives: per-key pruning must
      // not cost another attempt its live value.
      expect(pruned).toBe(8)
      expect(store.read({ aggregateId: `workflow:${sessionId}`, types: ["queue.plan.changed"] })).toHaveLength(1)
      expect(store.read({ aggregateId: `workflow:${sessionId}`, types: ["queue.tree.changed"] }).map(({ payload }) => payload)).toEqual([{ tree: { nodes: [{ ...phase, disposition: "running" }] } }])
      expect(store.read({ aggregateId: `workflow:${sessionId}`, types: ["queue.tree.node.changed"] }).map(({ payload }) => payload)).toEqual([{ node: { ...phase, disposition: "completed" }, currentAgentNodeId: null }])
      expect(store.read({ aggregateId: `workflow:${sessionId}`, types: ["queue.state.changed"] })).toHaveLength(1)
      expect(store.read({ aggregateId: `workflow:${sessionId}`, types: ["follow_up.resume_state.recorded"] })).toHaveLength(1)
      const reverts = store.read({ aggregateId: `workflow:${sessionId}`, types: ["step.resume_revert.recorded"] }).map((event) => event.payload)
      expect(reverts).toEqual([{ attemptId: "s1", count: 2 }, { attemptId: "s2", count: 1 }])
      // History stays: the efficiency projection reads every resume-state
      // row to map each historical conversation to its attempt.
      expect(store.read({ aggregateId: `workflow:${sessionId}`, types: ["step.resume_state.recorded"] })).toHaveLength(resumeStateRows)

      expect(await loadQueueSnapshotFromReader(projectionReader, sessionId)).toEqual(before)
      // Idempotent: a second sweep finds nothing.
      expect(await pruneSupersededWorkflowViewFacts(projectionReader, asAsyncEventWriter(store), sessionId)).toBe(0)
    } finally {
      store.close()
    }
  })

  it("is a no-op for a session with no workflow aggregate", async () => {
    const baseDir = makeTmpDir()
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    try {
      expect(await pruneSupersededWorkflowViewFacts(asAsyncEventReadSurface(store), asAsyncEventWriter(store), "plain-chat")).toBe(0)
    } finally {
      store.close()
    }
  })
})
