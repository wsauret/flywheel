import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { Schema } from "effect"
import { asAsyncEventReadSurface, type AsyncEventWriter, type AsyncGuardedEventWriter, type EventReader, type GuardedEventStoreAppend, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventReadSurface } from "../../../../src/infra/sqlite-event-read-surface.js"
import { createSqliteEventInserter } from "../../../../src/infra/sqlite-event-store-core.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { createWorkflowCommitHost, WorkflowCommitConflictError, WorkflowCommitStorageError } from "../../../../src/workflows/vm/commit-host.js"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import { buildWorkflowControlInitializedFact, type WorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { initializeWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { recoveredWorkflowRoot } from "../../../helpers/workflow-root-fixtures.js"
import { buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts.js"
import { createWorkflowContextProjection, contextFromProjection } from "../../../../src/workflows/context-bundle/context-projection.js"
import { composeWorkflowCompanions } from "../../../../src/workflows/vm/companions.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import { createLiveWorkflowView, loadQueueFromEvents } from "../../../../src/workflows/view/view-projection.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { WorkflowMalformedStateError } from "../../../../src/workflows/vm/host-types.js"

const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "workflow",
  name: "Workflow",
  phases: [{ phase: "work", brief: "Do the work work.", name: "work", writes: [] }],
})
const skills = testSkillRevision([testSkill("work", { name: "Work" })])
const bindings = resolveWorkflowAgents(workflow)

function initializedRoot() {
  const fact = buildWorkflowControlInitializedFact(compileWorkflowControl(workflow, bindings, { skills }))
  if (fact.type !== "workflow.control.initialized") throw new Error("Expected initialized root")
  return fact
}

function stored(event: GuardedEventStoreAppend, seq: number, position = seq + 1): StoredFact {
  const { expectedSeq: _expectedSeq, ...persisted } = event
  return { ...persisted, id: `event-${position}`, position, seq }
}

function storedFact(fact: WorkflowSessionFact, seq: number): StoredFact {
  return stored({
    aggregateId: "workflow:session",
    sessionId: "session",
    timestamp: 10,
    type: fact.type,
    version: fact.version,
    actor: fact.actor,
    payload: fact.payload,
  }, seq)
}

function reader(events: readonly StoredFact[], onRead?: (kind: "indexed" | "full") => void): EventReader {
  const base = inMemoryEventReader(events)
  return {
    ...base,
    read: (query = {}) => {
      onRead?.(query.fromSeq !== undefined ? "indexed" : "full")
      return base.read(query)
    },
    readTolerant: (query = {}) => {
      onRead?.(query.fromSeq !== undefined ? "indexed" : "full")
      return base.readTolerant(query)
    },
  }
}

function writer(overrides: Partial<AsyncGuardedEventWriter> = {}): AsyncGuardedEventWriter {
  return {
    append: async (event) => stored(event, 0),
    appendBatch: async (events) => events.map((event, index) => stored(event, index)),
    appendGuarded: async (event) => ({ kind: "stored", events: [stored(event, 0)] }),
    appendBatchGuarded: async (events) => ({ kind: "stored", events: events.map((event, index) => stored(event, index)) }),
    pruneSupersededEvents: async () => 0,
    ...overrides,
  }
}

function host(eventWriter: AsyncEventWriter, events: readonly StoredFact[] | EventReader = [], onRead?: (kind: "indexed" | "full") => void) {
  const captured = repoDefinitions().captureRevision()
  return createWorkflowCommitHost({
    sessionId: "session",
    writer: eventWriter,
    reader: asAsyncEventReadSurface("read" in events ? events : reader(events, onRead)),
    definitionRevision: Object.freeze({
      ...captured,
      skills,
      personas: new Map(),
    }),
    workflow,
    now: () => 10,
  })
}

describe("workflow commit host", () => {
  it("awaits exactly one guarded batch and puts expectedSeq only on its first event", async () => {
    const initialized = initializedRoot()
    const proposed = transitionWorkflow(initializeWorkflow(initialized.payload.control).state, {
      type: "PAUSE", reason: "operator",
    })
    if (proposed.command.kind !== "commit") throw new Error("Pause must propose a commit")
    const proposal = proposed.command.proposal
    let batches = 0
    let appended: readonly GuardedEventStoreAppend[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const commit = host(writer({
      appendBatchGuarded: async (events) => {
        batches += 1
        appended = events
        await gate
        return { kind: "stored", events: events.map((event, index) => stored(event, index + 1)) }
      },
    })).commit(proposal)

    await Promise.resolve()
    expect(batches).toBe(1)
    expect(appended.map(({ expectedSeq }) => expectedSeq)).toEqual([1, undefined])
    expect(appended.every(({ aggregateId, sessionId, timestamp }) => aggregateId === "workflow:session" && sessionId === "session" && timestamp === 10)).toBe(true)
    let settled = false
    void commit.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release?.()
    expect(await commit).toHaveLength(2)
    expect(batches).toBe(1)
  })

  it("maps sequence conflicts and storage failures to typed host errors", async () => {
    const proposal = { proposalId: "proposal", expectedSeq: 4, facts: [] }
    const conflict = host(writer({
      appendBatchGuarded: async () => ({ kind: "conflict", conflict: { aggregateId: "session:session", expectedSeq: 4, actualSeq: 5 } }),
    })).commit(proposal)
    await expect(conflict).rejects.toBeInstanceOf(WorkflowCommitConflictError)
    await expect(conflict).rejects.toMatchObject({
      _tag: "WorkflowCommitConflictError",
      proposalId: "proposal",
      expectedSeq: 4,
      actualSeq: 5,
    })

    const failure = host(writer({ appendBatchGuarded: async () => { throw new Error("disk unavailable") } })).commit(proposal)
    await expect(failure).rejects.toBeInstanceOf(WorkflowCommitStorageError)
    await expect(failure).rejects.toMatchObject({
      _tag: "WorkflowCommitStorageError",
      proposalId: "proposal",
      message: "disk unavailable",
    })
  })

  it("preserves the typed conflict when proposal-prefix validation fails", async () => {
    const initial = initializeWorkflow(compileWorkflowControl(workflow, bindings, { skills }))
    const proposed = transitionWorkflow(initial.state, { type: "START" })
    if (proposed.command.kind !== "commit") throw new Error("start must propose a commit")

    let thrown: unknown
    try {
      await host(writer({
        appendBatchGuarded: async () => ({ kind: "conflict", conflict: { aggregateId: "workflow:session", expectedSeq: 0, actualSeq: 1 } }),
      })).commitOrReplay({
        snapshot: initial.state,
        event: { type: "START" },
        proposal: proposed.command.proposal,
        applyStoredFacts: () => {},
      })
    } catch (error) {
      thrown = error
    }

    if (!(thrown instanceof Error)) throw new Error("proposal-prefix validation did not throw")
    expect(thrown.cause).toBeInstanceOf(WorkflowCommitConflictError)
  })

  it("applies every stored event before acknowledging the commit", async () => {
    const initial = initializeWorkflow(compileWorkflowControl(workflow, bindings, { skills }))
    const proposed = transitionWorkflow(initial.state, { type: "START" })
    if (proposed.command.kind !== "commit") throw new Error("start must propose a commit")
    let projectionReleased = false
    const appliedBatches: (readonly StoredFact[])[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const continuation = host(writer()).commitOrReplay({
      snapshot: proposed.state,
      event: { type: "START" },
      proposal: proposed.command.proposal,
      applyStoredFacts: async (events) => {
        appliedBatches.push(events)
        await gate
        projectionReleased = true
      },
    })

    await Promise.resolve()
    let settled = false
    void continuation.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release?.()
    const continued = await continuation
    expect(continued.publication).toBe("committed")
    expect(projectionReleased).toBe(true)
    expect(appliedBatches).toHaveLength(1)
    expect(appliedBatches[0]).toHaveLength(proposed.command.proposal.facts.length)
    expect(continued.state.lifecycle).toBe("ready")
    expect(continued.command).toMatchObject({ kind: "prepare_attempt", attempt: { attemptId: "workflow:node:1:attempt:1" } })
  })

  it("resolves a conflict only by rereading facts and discarding the stale snapshot", async () => {
    const initialized = initializedRoot()
    const committed = initialized.payload.control
    const paused = transitionWorkflow(initializeWorkflow(committed).state, {
      type: "PAUSE", reason: "concurrent operator",
    })
    if (paused.command.kind !== "commit" || !paused.state.context.pending) throw new Error("Pause must propose a commit")
    const events = [
      storedFact(initialized, 0),
      ...paused.command.proposal.facts.map((fact, index) => storedFact(fact, index + 1)),
    ]
    const proposed = transitionWorkflow(initializeWorkflow(committed).state, { type: "START" })
    if (proposed.command.kind !== "commit") throw new Error("start must propose a commit")

    const projected: string[] = []
    const reads: string[] = []
    const result = await host(writer({
      appendBatchGuarded: async () => ({ kind: "conflict", conflict: { aggregateId: "session:session", expectedSeq: 1, actualSeq: 3 } }),
    }), events, (kind) => { reads.push(kind) }).commitOrReplay({
      snapshot: proposed.state,
      event: { type: "START" },
      proposal: proposed.command.proposal,
      applyStoredFacts: (batch) => { projected.push(...batch.map(({ type }) => type)) },
    })

    expect(projected).toEqual(["workflow.paused", "workflow.control.committed"])
    expect(result.publication).toBe("replayed")
    expect(reads).toEqual(["indexed"])
    expect(result.state.lifecycle).toBe("paused")
    expect(result.state.context.committed).toEqual(paused.state.context.pending.proposedCommitted)
    expect(result.state.context.pending).toBeNull()
    expect(result.command.kind).toBe("none")
  })

  it("publishes each complete winning conflict batch after projection and excludes a trailing partial batch", async () => {
    const initialized = initializedRoot()
    const initial = initializeWorkflow(initialized.payload.control)
    const paused = transitionWorkflow(initial.state, { type: "PAUSE", reason: "first winner" })
    if (paused.command.kind !== "commit" || !paused.state.context.pending) throw new Error("Pause must propose a commit")
    const pausedState = transitionWorkflow(paused.state, {
      type: "COMMIT_SUCCEEDED",
      proposalId: paused.command.proposal.proposalId,
      aggregateSeq: paused.state.context.pending.proposedCommitted.aggregateSeq,
    })
    const resumed = transitionWorkflow(pausedState.state, { type: "RESUME", readers: {} })
    if (resumed.command.kind !== "commit") throw new Error("Resume must propose a commit")
    const winningFacts = [...paused.command.proposal.facts, ...resumed.command.proposal.facts]
    const events = [
      storedFact(initialized, 0),
      ...winningFacts.map((fact, index) => storedFact(fact, index + 1)),
      storedFact({ type: "queue.deleted", version: 1, actor: "flywheel", payload: {} }, winningFacts.length + 1),
    ]
    const stale = transitionWorkflow(initial.state, { type: "START" })
    if (stale.command.kind !== "commit") throw new Error("Start must propose a commit")
    const projected: string[] = []
    const published: { readonly types: readonly string[]; readonly projectedCount: number }[] = []

    const result = await host(writer({
      appendBatchGuarded: async () => ({ kind: "conflict", conflict: { aggregateId: "workflow:session", expectedSeq: 1, actualSeq: events.length } }),
    }), events).commitOrReplay({
      snapshot: stale.state,
      event: { type: "START" },
      proposal: stale.command.proposal,
      applyStoredFacts: (batch) => { projected.push(...batch.map(({ type }) => type)) },
      onCommitted: (batch) => { published.push({ types: batch.map(({ type }) => type), projectedCount: projected.length }) },
    })

    expect(published).toEqual([
      { types: ["workflow.paused", "workflow.control.committed"], projectedCount: 2 },
      { types: ["workflow.resumed", "workflow.control.committed"], projectedCount: 4 },
    ])
    expect(projected).toEqual([
      "workflow.paused", "workflow.control.committed",
      "workflow.resumed", "workflow.control.committed",
      "queue.deleted",
    ])
    expect(result.state.lifecycle).toBe("awaiting_commit")
    expect(result.command).toMatchObject({ kind: "commit", proposal: { expectedSeq: events.length } })
  })

  it.each([0, 1])("rebases SQLite recovery past invalid JSON at seq %s and publishes each terminal's exact queue", async (damagedSeq) => {
    const db = new Database(":memory:")
    try {
      const inserter = createSqliteEventInserter(db)
      const store = createSqliteEventReadSurface(db)
      const initialized = initializedRoot()
      const original = initializeWorkflow(initialized.payload.control)
      const stale = transitionWorkflow(original.state, { type: "START" })
      if (stale.command.kind !== "commit") throw new Error("Start must propose a commit")
      const events = inserter.insertEventRows([storedFact(initialized, 0)])
      const live = createLiveWorkflowView(asAsyncEventReadSurface(store), "session")
      const root = recoveredWorkflowRoot(initialized.payload.control, 6)
      const bootstrapQueue = flattenWorkflowView(root.payload.control, bindings)
      inserter.insertEventRows([
        storedFact(buildContextInputSeededFact("workflow", "old"), 1),
        { ...storedFact(initialized, 0), id: "other-session", aggregateId: "workflow:other", sessionId: "other" },
      ])
      const bootstrap = inserter.insertEventRows([root, ...queueFactsForState(null, bootstrapQueue), buildContextInputSeededFact("workflow", "new")]
        .map((fact, index) => storedFact(fact, index + 2)))
      events.push(...bootstrap)
      db.run("update event set payload = '{{broken' where aggregate_id = 'workflow:session' and seq = ?", [damagedSeq])
      expect(stale.command.proposal.expectedSeq).toBe(1)
      const resumed = composeWorkflowCompanions(transitionWorkflow(initializeWorkflow(root.payload.control).state, { type: "RESUME", readers: {} }), {
        queue: bootstrapQueue, resolvedAgents: bindings, timestamp: 10, addenda: [],
      })
      if (resumed.command.kind !== "commit" || !resumed.state.context.pending) throw new Error("Resume must propose a commit")
      const nextSeq = 2 + bootstrap.length
      const firstBatch = inserter.insertEventRows(resumed.command.proposal.facts.map((fact, index) => storedFact(fact, index + nextSeq)))
      const resumedQueue = loadQueueFromEvents([...events, ...firstBatch])
      const resumedState = transitionWorkflow(resumed.state, {
        type: "COMMIT_SUCCEEDED", proposalId: resumed.command.proposal.proposalId,
        aggregateSeq: resumed.state.context.pending.proposedCommitted.aggregateSeq,
      })
      const paused = composeWorkflowCompanions(transitionWorkflow(resumedState.state, { type: "PAUSE", reason: "second winner" }), {
        queue: resumedQueue, resolvedAgents: bindings, timestamp: 10, addenda: [],
      })
      if (paused.command.kind !== "commit") throw new Error("Pause must propose a commit")
      const secondBatch = inserter.insertEventRows(paused.command.proposal.facts.map((fact, index) => storedFact(fact, index + nextSeq + firstBatch.length)))
      events.push(...firstBatch, ...secondBatch)
      const pausedQueue = loadQueueFromEvents(events)
      const applied: (readonly StoredFact[])[] = []
      const published: Awaited<ReturnType<typeof live.read>>[] = []
      const result = await host(writer({
        appendBatchGuarded: async (facts) => {
          const expectedSeq = facts[0]?.expectedSeq
          if (expectedSeq === undefined) throw new Error("expected guarded workflow append")
          return { kind: "conflict", conflict: { aggregateId: "workflow:session", expectedSeq, actualSeq: store.aggregateSeq("workflow:session") + 1 } }
        },
      }), store).commitOrReplay({
        snapshot: stale.state, event: { type: "START" }, proposal: stale.command.proposal,
        applyStoredFacts: async (batch) => { applied.push(batch); await live.apply(batch) },
        onCommitted: () => { published.push(loadQueueFromEvents(applied.flat())) },
      })
      expect(applied).toEqual([bootstrap, firstBatch, secondBatch])
      expect(bootstrap[0]).toMatchObject({ seq: 2, position: 4 })
      expect(published).toEqual([resumedQueue, pausedQueue])
      expect(published.map((value) => value?.status)).toEqual(["idle", "paused"])
      expect(result.state.context.committed.aggregateSeq).toBe(store.aggregateSeq("workflow:session") + 1)
      expect(db.query<{ payload: string }, [number]>("select payload from event where aggregate_id = 'workflow:session' and seq = ?").get(damagedSeq)?.payload).toBe("{{broken")
    } finally {
      db.close()
    }
  })

  it.each(["root-json", "root-schema", "root-version", "suffix-json"] as const)("refuses selected SQLite recovery with %s damage before publishing", async (damage) => {
    const db = new Database(":memory:")
    try {
      const inserter = createSqliteEventInserter(db)
      const store = createSqliteEventReadSurface(db)
      const initialized = initializedRoot()
      const proposed = transitionWorkflow(initializeWorkflow(initialized.payload.control).state, { type: "START" })
      if (proposed.command.kind !== "commit") throw new Error("Start must propose a commit")
      const recovered = recoveredWorkflowRoot(initialized.payload.control, 4)
      inserter.insertEventRows([
        storedFact(initialized, 0),
        storedFact(recovered, 1),
        storedFact(buildContextInputSeededFact("workflow", "new"), 2),
        ...queueFactsForState(null, flattenWorkflowView(recovered.payload.control, bindings)).map((fact, index) => storedFact(fact, index + 3)),
      ])
      if (damage === "root-version") db.run("update event set version = 99 where seq = 1")
      else db.run("update event set payload = ? where seq = ?", [damage === "root-schema" ? "{}" : "{{broken", damage === "suffix-json" ? 2 : 1])
      const applied: (readonly StoredFact[])[] = []
      const published: (readonly StoredFact[])[] = []
      await expect(host(writer({
        appendBatchGuarded: async (facts) => {
          const expectedSeq = facts[0]?.expectedSeq
          if (expectedSeq === undefined) throw new Error("expected guarded workflow append")
          return { kind: "conflict", conflict: { aggregateId: "workflow:session", expectedSeq, actualSeq: store.aggregateSeq("workflow:session") + 1 } }
        },
      }), store).commitOrReplay({
        snapshot: proposed.state, event: { type: "START" }, proposal: proposed.command.proposal,
        applyStoredFacts: (batch) => { applied.push(batch) },
        onCommitted: (batch) => { published.push(batch) },
      })).rejects.toBeInstanceOf(WorkflowMalformedStateError)
      expect(applied).toEqual([])
      expect(published).toEqual([])
    } finally {
      db.close()
    }
  })

  it("rebases a competing recovered root and synchronizes held families without folding superseded poison", async () => {
    const initialized = initializedRoot()
    const proposed = transitionWorkflow(initializeWorkflow(initialized.payload.control).state, { type: "START" })
    if (proposed.command.kind !== "commit") throw new Error("Start must propose a commit")
    const events = [storedFact(initialized, 0)]
    const context = createWorkflowContextProjection(asAsyncEventReadSurface(inMemoryEventReader(events)), "session")
    const recovered = recoveredWorkflowRoot(initialized.payload.control, 4)
    events.push(
      { ...storedFact(buildContextInputSeededFact("workflow", "old"), 1), payload: {} },
      storedFact(recovered, 2),
      storedFact(buildContextInputSeededFact("workflow", "new"), 3),
    )
    const reads: string[] = []
    const projected: string[] = []
    const result = await host(writer({
      appendBatchGuarded: async () => ({ kind: "conflict", conflict: { aggregateId: "workflow:session", expectedSeq: 1, actualSeq: 4 } }),
    }), events, (kind) => { reads.push(kind) }).commitOrReplay({
      snapshot: proposed.state,
      event: { type: "START" },
      proposal: proposed.command.proposal,
      applyStoredFacts: async (facts) => { projected.push(...facts.map(({ type }) => type)); await context.apply(facts) },
    })
    expect(reads).toEqual(["indexed"])
    expect(projected).toEqual(["workflow.control.recovered", "context.input.seeded"])
    expect(result.state.context.committed).toEqual(recovered.payload.control)
    expect(result.state.context.pending).toBeNull()
    expect(result.command.kind).toBe("none")
    expect(contextFromProjection(await context.getState()).request?.original).toBe("new")
  })
})
