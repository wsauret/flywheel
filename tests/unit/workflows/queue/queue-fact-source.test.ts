import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import type { StoredFact } from "../../../../src/infra/event-store-types.js"
import { asAsyncEventReadSurface, CorruptEventRowError } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventReadSurface } from "../../../../src/infra/sqlite-event-read-surface.js"
import { createSqliteEventInserter } from "../../../../src/infra/sqlite-event-store-core.js"
import { InvariantViolation } from "../../../../src/infra/invariant.js"
import { readWorkflowProjectionBoundary, selectWorkflowFactSource } from "../../../../src/workflows/session-fact-source.js"
import type { WorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { createWorkflowQueueProjection, queueFromProjection } from "../../../../src/workflows/view/view-projection.js"
import { readWorkflowStatees } from "../../../../src/workflows/view/view-store.js"
import { contextFromProjection, createWorkflowContextProjection } from "../../../../src/workflows/context-bundle/context-projection.js"
import { buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { initializedWorkflowRoot, recoveredWorkflowRoot, storedWorkflowFacts } from "../../../helpers/workflow-root-fixtures.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"

const INITIALIZED = "workflow.control.initialized"

function event(sessionId: string, aggregateId: string, type: string, position: number): StoredFact {
  return {
    aggregateId,
    type,
    version: type === INITIALIZED ? initializedWorkflowRoot.version : 1,
    timestamp: position,
    actor: "flywheel",
    sessionId,
    payload: type === INITIALIZED ? initializedWorkflowRoot.payload : {},
    position,
    id: `event-${position}`,
    seq: position - 1,
  }
}

function reader(events: readonly StoredFact[]) {
  return { store: asAsyncEventReadSurface(inMemoryEventReader(events)) }
}

describe("workflow fact source", () => {
  it("rejects a nonempty workflow aggregate without the initialization marker", async () => {
    const { store } = reader([event("wf-1", "workflow:wf-1", "queue.created", 1)])
    await expect(selectWorkflowFactSource(store, "wf-1")).rejects.toThrow("workflow.control.initialized")
  })

  it("keeps a live projection fixed to the workflow aggregate", async () => {
    const legacy = event("wf-1", "session:wf-1", "queue.created", 1)
    legacy.version = 3
    legacy.payload = { queue: { steps: [], cursor: 0, status: "running", mutationLog: [] } }
    const { store } = reader([legacy])
    const projection = createWorkflowQueueProjection(store, "wf-1")

    expect(queueFromProjection(await projection.replay())).toBeNull()
  })


  it("refreshes queue statuses from the named workflows without reading chat facts", async () => {
    const ids = ["current", "non-workflow"]
    const currentQueue = event("current", "workflow:current", "queue.created", 2)
    currentQueue.version = 9
    currentQueue.payload = { queue: { steps: [], cursor: 0, status: "running", mutationLog: [] } }
    const ignoredQueue = event("non-workflow", "session:non-workflow", "queue.created", 3)
    ignoredQueue.version = 9
    ignoredQueue.payload = { queue: { steps: [], cursor: 0, status: "paused", mutationLog: [] } }
    const { store } = reader([
      event("current", "workflow:current", INITIALIZED, 1),
      currentQueue,
      ignoredQueue,
    ])

    const { reader: observed, take } = countStateRequests(store)
    const result = await readWorkflowStatees(ids, observed)

    expect(result.statuses).toEqual(new Map([["current", "running"], ["non-workflow", undefined]]))
    expect(result.errors).toEqual([])
    expect(factsRead(take())).toBe(2)
    expect(await readWorkflowStatees(ids, observed)).toEqual(result)
    expect(factsRead(take())).toBe(0)
  })

  it("selects a recovered SQLite root before decoding a corrupt older initialization", async () => {
    const db = new Database(":memory:")
    try {
      const writer = createSqliteEventInserter(db)
      const roots = writer.insertEventRows(storedWorkflowFacts([
        initializedWorkflowRoot,
        recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 4),
        buildContextInputSeededFact("workflow", "recovered request"),
        { type: "queue.created", version: 9, actor: "flywheel", payload: { queue: { steps: [], cursor: 0, status: "paused", mutationLog: [] } } },
      ]))
      db.run("update event set payload = '{{broken' where type = 'workflow.control.initialized'")
      const store = createSqliteEventReadSurface(db)
      const projectionReader = asAsyncEventReadSurface(store)
      expect(await readWorkflowProjectionBoundary(projectionReader, "workflow:session")).toBe(roots[1]?.position)
      expect(queueFromProjection(await createWorkflowQueueProjection(projectionReader, "session").replay())?.status).toBe("paused")
      expect(contextFromProjection(await createWorkflowContextProjection(projectionReader, "session").replay()).request?.original).toBe("recovered request")
      expect(await readWorkflowStatees(["session"], projectionReader)).toEqual({ statuses: new Map([["session", "paused"]]), errors: [] })
      expect(db.query<{ payload: string }, []>("select payload from event where type = 'workflow.control.initialized'").get()?.payload).toBe("{{broken")
    } finally {
      db.close()
    }
  })

  it.each(["queue.state.changed", "queue.deleted"] as const)("ignores invalid SQLite %s JSON before recovery but reports current-epoch damage", async (type) => {
    const db = new Database(":memory:")
    try {
      const writer = createSqliteEventInserter(db)
      const damagedFact = { type, version: 1, actor: "flywheel", payload: { status: "running", cursor: 0 } } as const
      writer.insertEventRows(storedWorkflowFacts([
        initializedWorkflowRoot,
        damagedFact,
        recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 4),
        { type: "queue.created", version: 9, actor: "flywheel", payload: { queue: { steps: [], cursor: 0, status: "paused", mutationLog: [] } } },
      ]))
      db.run("update event set payload = '{{broken' where type = ?", [type])
      const store = createSqliteEventReadSurface(db)
      const direct = asAsyncEventReadSurface(store)
      const { reader: observed, take } = countStateRequests(direct)
      expect(await readWorkflowStatees(["session"], observed)).toEqual({ statuses: new Map([["session", "paused"]]), errors: [] })
      expect(factsRead(take())).toBe(4)
      expect(db.query<{ payload: string }, [string]>("select payload from event where type = ?").get(type)?.payload).toBe("{{broken")
      writer.insertEventRows(storedWorkflowFacts([damagedFact], 4))
      db.run("update event set payload = '{{current-broken' where seq = 4")
      const result = await readWorkflowStatees(["session"], observed)
      expect(result.statuses.size).toBe(0)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]?.reason).toContain("position 5")
      expect(factsRead(take())).toBe(1)
    } finally {
      db.close()
    }
  })

  it.each(["recreated", "deleted"] as const)("folds the latest SQLite status rows in position order when %s", async (state) => {
    const db = new Database(":memory:")
    try {
      const writer = createSqliteEventInserter(db)
      writer.insertEventRows(storedWorkflowFacts([
        initializedWorkflowRoot,
        { type: "queue.created", version: 9, actor: "flywheel", payload: { queue: { steps: [], cursor: 0, status: "idle", mutationLog: [] } } },
        { type: "queue.state.changed", version: 1, actor: "flywheel", payload: { status: "running", cursor: 0 } },
        { type: "queue.deleted", version: 1, actor: "flywheel", payload: {} },
        { type: "queue.created", version: 9, actor: "flywheel", payload: { queue: { steps: [], cursor: 0, status: "paused", mutationLog: [] } } },
      ]))
      if (state === "deleted") writer.insertEventRows(storedWorkflowFacts([{ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} }], 5))
      expect(await readWorkflowStatees(["session"], asAsyncEventReadSurface(createSqliteEventReadSurface(db)))).toEqual({
        statuses: new Map([["session", state === "recreated" ? "paused" : undefined]]), errors: [],
      })
    } finally {
      db.close()
    }
  })

  it.each(["json", "schema", "version"] as const)("the newest SQLite root fences reads on %s damage", async (damage) => {
    const db = new Database(":memory:")
    try {
      createSqliteEventInserter(db).insertEventRows(storedWorkflowFacts([
        initializedWorkflowRoot,
        recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 2),
      ]))
      if (damage === "version") db.run("update event set version = 99 where type = 'workflow.control.recovered'")
      else db.run("update event set payload = ? where type = 'workflow.control.recovered'", [damage === "json" ? "{{broken" : "{}"])
      const store = createSqliteEventReadSurface(db)
      const projectionReader = asAsyncEventReadSurface(store)
      const error = damage === "json" ? CorruptEventRowError : InvariantViolation
      await expect(readWorkflowProjectionBoundary(projectionReader, "workflow:session")).rejects.toThrow(error)
      await expect(createWorkflowQueueProjection(projectionReader, "session").replay()).rejects.toThrow(error)
      await expect(createWorkflowContextProjection(projectionReader, "session").replay()).rejects.toThrow(error)
      const result = await readWorkflowStatees(["session"], projectionReader)
      expect(result.statuses.size).toBe(0)
      expect(result.errors).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it.each([3, 30])("folds each catch-up of a workflow with %p members from one page and resets at a live recovery root without a root probe", async (members) => {
    const queueCreated = (status: "idle" | "paused"): WorkflowSessionFact => ({ type: "queue.created", version: 9, actor: "flywheel", payload: { queue: { steps: [], cursor: 0, status, mutationLog: [] } } })
    const stateChanged: WorkflowSessionFact = { type: "queue.state.changed", version: 1, actor: "flywheel", payload: { status: "running", cursor: 0 } }
    const events = storedWorkflowFacts([initializedWorkflowRoot, queueCreated("idle"), ...Array.from({ length: members }, () => stateChanged)])
    const counter = countStateRequests(asAsyncEventReadSurface(inMemoryEventReader(events)))
    const queue = createWorkflowQueueProjection(counter.reader, "session")
    const context = createWorkflowContextProjection(counter.reader, "session")
    await queue.replay()
    await context.replay()
    counter.take()

    for (let change = 0; change < 5; change += 1) {
      events.push(...storedWorkflowFacts([stateChanged], events.length))
      await queue.replay()
      await context.replay()
      expect(counter.take().map((request) => request.method)).toEqual(["readPage", "readPage"])
    }

    events.push(...storedWorkflowFacts([recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, events.length + 2), queueCreated("paused")], events.length))
    expect(queueFromProjection(await queue.replay())?.status).toBe("paused")
    expect(counter.take().map((request) => request.method)).toEqual(["readPage"])
  })

  // A Restart appends a recovery root and its replacement companions behind
  // the damaged history it supersedes. 256 fillers push the repair root past
  // the first page of the catch-up, which holds the damaged fact.
  it.each([
    { damage: "a corrupt JSON row before a same-page repair root", fillers: 0, damagedRoot: false, sql: "payload = '{{broken'", error: CorruptEventRowError },
    { damage: "a schema-invalid fact before a later-page repair root", fillers: 256, damagedRoot: false, sql: "payload = '{}'", error: InvariantViolation },
    { damage: "an unsupported fact before a later-page repair root", fillers: 256, damagedRoot: false, sql: "version = 99", error: InvariantViolation },
    { damage: "an invalid root before a later-page repair root", fillers: 256, damagedRoot: true, sql: "payload = '{}'", error: InvariantViolation },
  ])("a held SQLite context projection recovers from $damage like a fresh one, and current-epoch damage still fails", async ({ fillers, damagedRoot, sql, error }) => {
    const db = new Database(":memory:")
    try {
      const writer = createSqliteEventInserter(db)
      const control = initializedWorkflowRoot.payload.control
      writer.insertEventRows(storedWorkflowFacts([initializedWorkflowRoot, buildContextInputSeededFact("workflow", "original request")]))
      const projectionReader = asAsyncEventReadSurface(createSqliteEventReadSurface(db))
      const held = createWorkflowContextProjection(projectionReader, "session")
      expect(contextFromProjection(await held.replay()).request?.original).toBe("original request")

      const damaged = damagedRoot ? recoveredWorkflowRoot(control, 4) : buildContextInputSeededFact("workflow", "damaged request")
      const filler = Array.from({ length: fillers }, () => buildContextInputSeededFact("workflow", "superseded request"))
      writer.insertEventRows(storedWorkflowFacts([
        damaged,
        ...filler,
        recoveredWorkflowRoot(control, fillers + 5),
        buildContextInputSeededFact("workflow", "recovered request"),
      ], 2))
      db.run(`update event set ${sql} where seq = 2`)

      const fresh = createWorkflowContextProjection({ ...projectionReader }, "session")
      expect(contextFromProjection(await fresh.replay()).request?.original).toBe("recovered request")
      expect(contextFromProjection(await held.replay()).request?.original).toBe("recovered request")
      expect(held.getPosition()).toBe(fresh.getPosition())

      writer.insertEventRows(storedWorkflowFacts([buildContextInputSeededFact("workflow", "current request")], fillers + 5))
      db.run(`update event set ${sql} where seq = ${fillers + 5}`)
      await expect(held.replay()).rejects.toThrow(error)
      await expect(createWorkflowContextProjection({ ...projectionReader }, "session").replay()).rejects.toThrow(error)
    } finally {
      db.close()
    }
  })

  it.each(["valid", "invalid"] as const)("a held SQLite queue projection behind a corrupt recovery root reads the newest %s root like a fresh one", async (newest) => {
    const queueCreated = (status: "idle" | "paused"): WorkflowSessionFact => ({ type: "queue.created", version: 9, actor: "flywheel", payload: { queue: { steps: [], cursor: 0, status, mutationLog: [] } } })
    const db = new Database(":memory:")
    try {
      const writer = createSqliteEventInserter(db)
      const control = initializedWorkflowRoot.payload.control
      writer.insertEventRows(storedWorkflowFacts([initializedWorkflowRoot, queueCreated("idle")]))
      const projectionReader = asAsyncEventReadSurface(createSqliteEventReadSurface(db))
      const held = createWorkflowQueueProjection(projectionReader, "session")
      expect(queueFromProjection(await held.replay())?.status).toBe("idle")

      writer.insertEventRows(storedWorkflowFacts([
        recoveredWorkflowRoot(control, 4), queueCreated("paused"),
        ...newest === "valid" ? [recoveredWorkflowRoot(control, 6), queueCreated("paused")] : [],
      ], 2))
      db.run("update event set payload = '{{broken' where seq = 2")

      const fresh = createWorkflowQueueProjection({ ...projectionReader }, "session")
      if (newest === "valid") {
        expect(queueFromProjection(await fresh.replay())?.status).toBe("paused")
        expect(queueFromProjection(await held.replay())?.status).toBe("paused")
        expect(held.getPosition()).toBe(fresh.getPosition())
      } else {
        await expect(fresh.replay()).rejects.toThrow(CorruptEventRowError)
        await expect(held.replay()).rejects.toThrow(CorruptEventRowError)
        expect(queueFromProjection(held.getState())).toBeNull()
      }
    } finally {
      db.close()
    }
  })

  it("retains a SQLite input seed before ordinary initialization and rejects rootless history", async () => {
    const db = new Database(":memory:")
    try {
      const writer = createSqliteEventInserter(db)
      writer.insertEventRows(storedWorkflowFacts([
        buildContextInputSeededFact("workflow", "original request"),
        { ...initializedWorkflowRoot, payload: { control: { ...initializedWorkflowRoot.payload.control, aggregateSeq: 2 } } },
      ]))
      const store = createSqliteEventReadSurface(db)
      const projectionReader = asAsyncEventReadSurface(store)
      expect(await readWorkflowProjectionBoundary(projectionReader, "workflow:session")).toBeUndefined()
      expect(contextFromProjection(await createWorkflowContextProjection(projectionReader, "session").replay()).request?.original).toBe("original request")
      writer.insertEventRows(storedWorkflowFacts([buildContextInputSeededFact("workflow", "rootless")]).map((fact) => ({ ...fact, id: "rootless", aggregateId: "workflow:rootless", sessionId: "rootless" })))
      await expect(readWorkflowProjectionBoundary(projectionReader, "workflow:rootless")).rejects.toThrow(InvariantViolation)
    } finally {
      db.close()
    }
  })
})
