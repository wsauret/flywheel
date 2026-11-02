import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { asAsyncEventReadSurface, type EventStoreAppend } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventReadSurface } from "../../../../src/infra/sqlite-event-read-surface.js"
import { createSqliteEventInserter } from "../../../../src/infra/sqlite-event-store-core.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { skillLoadedFact } from "../../../../src/workflows/skill-facts.js"
import { readWorkflowActivity, readWorkflowControlStatuses } from "../../../../src/workflows/vm/control-status.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { buildWorkflowControlRecoveredFact } from "../../../../src/workflows/vm/session-facts.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"
import { createMemoryStore, initialFacts, recordProposal, testHost } from "./host-test-support.js"

test("control status advances through real proposals and workflow-owned module facts, not queue bodies", async () => {
  const store = createMemoryStore(initialFacts())
  const counter = countStateRequests(asAsyncEventReadSurface(store))
  const status = async () => (await readWorkflowControlStatuses(counter.reader, ["session"])).get("session")
  expect(await status()).toBe("ready")
  await recordProposal(store, { type: "START" })
  expect(await status()).toBe("ready")
  const writer = createSessionFactWriter({ owner: { kind: "workflow", workflowId: "session" }, writer: store })
  try {
    counter.take()
    const recorded = await writer.record(skillLoadedFact({ name: "implementation" }))
    if (!recorded) throw new Error("Expected recorded workflow fact")
    expect(recorded.aggregateId).toBe("workflow:session")
    expect(await status()).toBe("ready")
    expect(factsRead(counter.take())).toBe(1)
    expect((await readWorkflowActivity(counter.reader, ["session"])).get("session")).toEqual({ status: "ready", lastUpdated: recorded.timestamp })
    expect(factsRead(counter.take())).toBe(0)
    await recordProposal(store, { type: "PAUSE", reason: "person" })
    expect(await status()).toBe("paused")
    await recordProposal(store, { type: "RESUME", readers: {} })
    expect(await status()).toBe("ready")
    counter.take()
    expect(await status()).toBe("ready")
    expect(factsRead(counter.take())).toBe(0)
    await store.append({ aggregateId: "workflow:session", sessionId: "session", type: "queue.tree.changed", version: 999, actor: "flywheel", timestamp: 10, payload: {} })
    expect(await status()).toBe("ready")
  } finally {
    writer.dispose()
  }
})

test("the completed host's strict control status is read-only after later module companions", async () => {
  const store = createMemoryStore(initialFacts())
  const reader = asAsyncEventReadSurface(store)
  const status = async () => (await readWorkflowControlStatuses(reader, ["session"])).get("session")
  expect(await status()).toBe("ready")
  const host = testHost(store, {
    attemptRunner: {
      run: async (input) => ({ kind: "success", attemptId: input.attemptId, conversationId: "conversation-1", handoff: { summary: "done" }, reassessment: null }),
    },
  })
  expect((await host.run()).kind).toBe("completed")
  expect(await status()).toBe("completed")
  const writer = createSessionFactWriter({ owner: { kind: "workflow", workflowId: "session" }, writer: store })
  try {
    await writer.record(skillLoadedFact({ name: "implementation" }))
    expect(await status()).toBe("completed")
  } finally {
    writer.dispose()
  }
})

test("invalid control and run-only aggregates remain unknown", async () => {
  const store = createMemoryStore(initialFacts())
  const reader = asAsyncEventReadSurface(store)
  const status = async () => (await readWorkflowControlStatuses(reader, ["session", "historical"])).get("session")
  expect(await status()).toBe("ready")
  const control = replayWorkflowControl(store.events)
  await store.append({ aggregateId: "workflow:session", sessionId: "session", type: "workflow.unrecognized", version: 1, actor: "flywheel", timestamp: 10, payload: {} })
  expect(await status()).toBeUndefined()
  const seq = store.aggregateSeq("workflow:session") + 1
  const root = buildWorkflowControlRecoveredFact({
    supersededThroughSeq: seq - 1, degradationReasons: [{ kind: "invalid_suffix", seq: seq - 1 }],
    runtimeIdentity: { version: "test", buildId: "test" },
    identities: { workflow: { source: "recovered", value: "host-test" }, step: null, attempt: null, conversation: null },
    control: { ...control, status: "paused", frontier: [], aggregateSeq: seq + 1 },
  })
  await store.append({ ...root, aggregateId: "workflow:session", sessionId: "session", timestamp: 10 })
  expect(await status()).toBe("paused")
  await store.append({ aggregateId: "workflow:historical", sessionId: "historical", type: "workflow.run.cut.updated", version: 1, actor: "flywheel", timestamp: 10, payload: { cut: null } })
  expect((await readWorkflowControlStatuses(reader, ["historical"])).get("historical")).toBeUndefined()

  // A warm advancing fold that meets an unknown workflow fact leaves only its
  // own workflow unknown, beside a healthy one in the same request.
  const started = createMemoryStore(initialFacts())
  await recordProposal(started, { type: "START" })
  for (const fact of initialFacts()) await started.append({ ...fact, aggregateId: "workflow:healthy", sessionId: "healthy" })
  const startedReader = asAsyncEventReadSurface(started)
  const statuses = () => readWorkflowControlStatuses(startedReader, ["session", "healthy"])
  expect([...(await statuses()).values()]).toEqual(["ready", "ready"])
  await started.append({ aggregateId: "workflow:session", sessionId: "session", type: "workflow.future_fact", version: 1, actor: "flywheel", timestamp: 11, payload: {} })
  const later = await statuses()
  expect(later.get("session")).toBeUndefined()
  expect(later.get("healthy")).toBe("ready")
})

test("a commit during the stale reseed yields status and activity of one state", async () => {
  const store = createMemoryStore(initialFacts())
  const recoveredRoot = async (status: "paused" | "ready", timestamp: number) => {
    const control = replayWorkflowControl(store.events)
    const seq = store.aggregateSeq("workflow:session") + 1
    const root = buildWorkflowControlRecoveredFact({
      supersededThroughSeq: seq - 1, degradationReasons: [{ kind: "invalid_suffix", seq: seq - 1 }],
      runtimeIdentity: { version: "test", buildId: "test" },
      identities: { workflow: { source: "recovered", value: "host-test" }, step: null, attempt: null, conversation: null },
      control: { ...control, status, frontier: [], aggregateSeq: seq + 1 },
    })
    await store.append({ ...root, aggregateId: "workflow:session", sessionId: "session", timestamp })
  }
  const local = asAsyncEventReadSurface(store)
  // Once armed, the first page read after the reseed's slice commits a later
  // root, so a reader that replays again for activity would see it.
  let armed = false
  let seeded = false
  const reader = {
    ...local,
    readSlice: (...args: Parameters<typeof local.readSlice>) => {
      seeded = armed
      return local.readSlice(...args)
    },
    readPage: async (...args: Parameters<typeof local.readPage>) => {
      const page = await local.readPage(...args)
      if (seeded) {
        armed = false
        seeded = false
        await recoveredRoot("ready", 99)
      }
      return page
    },
  }
  const activity = async () => (await readWorkflowActivity(reader, ["session"])).get("session")
  expect((await activity())?.status).toBe("ready")
  // A replacement root makes the warm fold stale, so the next read seeds it again.
  await recoveredRoot("paused", 10)
  armed = true
  expect(await activity()).toEqual({ status: "paused", lastUpdated: 10 })
  expect(armed).toBe(false)
  expect(await activity()).toEqual({ status: "ready", lastUpdated: 99 })
})

test("raw corruption is isolated to its workflow and remains unreadable across replacement roots", async () => {
  const db = new Database(":memory:")
  try {
    const inserter = createSqliteEventInserter(db)
    inserter.insertEventRows(initialFacts().map((fact, index) => ({ ...fact, id: `initial-${index}` })))
    const control = replayWorkflowControl(createSqliteEventReadSurface(db).read({ aggregateId: "workflow:session" }))
    const seq = control.aggregateSeq
    const root = buildWorkflowControlRecoveredFact({
      supersededThroughSeq: seq - 1, degradationReasons: [{ kind: "invalid_suffix", seq: 1 }],
      runtimeIdentity: { version: "test", buildId: "test" },
      identities: { workflow: { source: "recovered", value: "host-test" }, step: null, attempt: null, conversation: null },
      control: { ...control, status: "paused", frontier: [], aggregateSeq: seq + 1 },
    })
    inserter.insertEventRows([
      { ...root, aggregateId: "workflow:session", sessionId: "session", timestamp: 10, id: "replacement" },
      ...initialFacts().map((fact, index) => ({ ...fact, aggregateId: "workflow:healthy", sessionId: "healthy", id: `healthy-${index}` })),
      { aggregateId: "session:outside", sessionId: "outside", timestamp: 10, id: "outside", type: "skill.loaded", version: 1, actor: "agent", payload: {} },
    ])
    db.run("update event set payload = '{{bad' where id in ('initial-1', 'outside')")
    const reader = asAsyncEventReadSurface(createSqliteEventReadSurface(db))
    const statuses = await readWorkflowControlStatuses(reader, ["session", "healthy"])
    expect(statuses.get("session")).toBeUndefined()
    expect(statuses.get("healthy")).toBe("ready")
    // A damaged row that reaches a warm fold through the shared batch read
    // makes only its own workflow unknown.
    inserter.insertEventRows([{ aggregateId: "workflow:healthy", sessionId: "healthy", timestamp: 11, id: "late", type: "skill.loaded", version: 1, actor: "agent", payload: {} }])
    db.run("update event set payload = '{{bad' where id = 'late'")
    const later = await readWorkflowControlStatuses(reader, ["session", "healthy"])
    expect(later.get("session")).toBeUndefined()
    expect(later.get("healthy")).toBeUndefined()
  } finally {
    db.close()
  }
})

test("a failed state request leaves admission unknown and a later read retries", async () => {
  const local = asAsyncEventReadSurface(createMemoryStore(initialFacts()))
  let refused = true
  const reader = {
    ...local,
    readSlice: (...args: Parameters<typeof local.readSlice>) => {
      if (refused) {
        refused = false
        return Promise.reject(new Error("State request refused"))
      }
      return local.readSlice(...args)
    },
  }
  expect((await readWorkflowControlStatuses(reader, ["session"])).get("session")).toBeUndefined()
  expect((await readWorkflowControlStatuses(reader, ["session"])).get("session")).toBe("ready")
})

test.each([20, 70])("warm status reads of %i workflows cost one page read per call, however many the held bound evicts", async (count) => {
  const db = new Database(":memory:")
  try {
    const inserter = createSqliteEventInserter(db)
    const ids = Array.from({ length: count }, (_, index) => `workflow-${index}`)
    const factsOf = (id: string, facts: readonly EventStoreAppend[], tag: string) => facts.map((fact, index) => ({ ...fact, aggregateId: `workflow:${id}`, sessionId: id, id: `${id}-${tag}-${index}` }))
    // A started run, so that its fold advances through later proposals.
    const history = createMemoryStore(initialFacts())
    await recordProposal(history, { type: "START" })
    const started = history.events.length
    inserter.insertEventRows(ids.flatMap((id) => factsOf(id, history.events, "started")))
    const counter = countStateRequests(asAsyncEventReadSurface(createSqliteEventReadSurface(db)))
    const statuses = () => readWorkflowControlStatuses(counter.reader, ids)
    expect([...(await statuses()).values()].every((status) => status === "ready")).toBe(true)
    counter.take()
    for (let call = 0; call < 2; call++) {
      expect([...(await statuses()).values()].every((status) => status === "ready")).toBe(true)
      expect(counter.take().map((request) => request.method)).toEqual(["readPage"])
    }
    await recordProposal(history, { type: "PAUSE", reason: "person" })
    inserter.insertEventRows(factsOf("workflow-3", history.events.slice(started), "paused"))
    const after = await statuses()
    expect(counter.take().map((request) => request.method)).toEqual(["readPage"])
    expect(after.get("workflow-3")).toBe("paused")
    expect(ids.filter((id) => after.get(id) !== "ready")).toEqual(["workflow-3"])
  } finally {
    db.close()
  }
})

test.each([2, 20])("the first status read pays for the named workflow only, beside %i unrelated workflows", async (others) => {
  const store = createMemoryStore(initialFacts())
  for (let index = 0; index < others; index++) {
    for (const fact of initialFacts()) await store.append({ ...fact, aggregateId: `workflow:other-${index}`, sessionId: `other-${index}` })
  }
  const counter = countStateRequests(asAsyncEventReadSurface(store))
  expect((await readWorkflowControlStatuses(counter.reader, ["session"])).get("session")).toBe("ready")
  expect(factsRead(counter.take())).toBe(initialFacts().length)
})
