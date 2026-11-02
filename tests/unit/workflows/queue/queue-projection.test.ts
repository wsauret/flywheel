import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, type EventStore, type StoredFact } from "../../../../src/infra/event-store-types"
import { InvariantViolation } from "../../../../src/infra/invariant"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { factDescriptors } from "../../../../src/infra/event-registry"
import { WorkflowQueueFactSchemas, parseWorkflowQueueFact, type WorkflowQueueFact } from "../../../../src/workflows/view/view-facts"
import { createLiveWorkflowView, createReplayingWorkflowView, createWorkflowQueueProjection, loadQueueFromEvents, loadWorkflowStateFromEvents, queueFromProjection } from "../../../../src/workflows/view/view-projection"
import { loadQueueSnapshotFromReader, readWorkflowStatees } from "../../../../src/workflows/view/view-store"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { initializedWorkflowRoot, recoveredWorkflowRoot, storedWorkflowFacts } from "../../../helpers/workflow-root-fixtures.js"
import { Schema } from "effect"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import { completeAttempt, startExecution } from "../../../../src/workflows/vm/attempt-transitions.js"
import { testResolvedAgent, testResolvedAgents, testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { buildWorkflowControlInitializedFact, buildWorkflowControlCommittedFact, parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { buildAttemptRetryInsertedFact, buildWorkflowReassessedFact } from "../../../../src/workflows/vm/fact-drafts.js"
import { recoverWorkflowControl, workflowRecoveryBasis } from "../../../../src/workflows/vm/recovery.js"
import { drive, mapControl, mapBindings, mapOutcome } from "../vm/_tree-fixtures.js"
import { MAP_GROUP, branch, items, stage } from "../vm/_map-fixtures.js"
import { WorkflowRowsSchema } from "../../../../src/workflows/view/schemas.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { asThenChain } from "../../../helpers/control-before-phases.js"
import arms from "../vm/golden/committed-v10-history-arms.json"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"
import { initializeWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js"
import { composeWorkflowCompanions } from "../../../../src/workflows/vm/companions.js"
import { createMemoryStore, initialFacts, testHost } from "../vm/host-test-support.js"
import type { WorkflowTree } from "../../../../src/protocol/workflow-view-protocol-types.js"

/** Fact literals below carry the registered version of their type, so a queue
 *  fact version bump stays a migration concern instead of a test edit. */
const registeredQueueFactVersions = new Map(
  factDescriptors(WorkflowQueueFactSchemas).map(({ type, version }) => [type, version]),
)

function queueFact<T extends WorkflowQueueFact["type"]>(
  type: T,
  payload: Extract<WorkflowQueueFact, { type: T }>["payload"],
): WorkflowQueueFact {
  const version = registeredQueueFactVersions.get(type)
  if (version === undefined) throw new Error(`unregistered queue fact type ${type}`)
  return parseWorkflowQueueFact({ type, version, actor: "flywheel", payload })
}

let tmpDir: string

function appendFact(store: EventStore, sessionId: string, fact: WorkflowQueueFact): void {
  const aggregateId = `workflow:${sessionId}`
  if (store.countByAggregate(aggregateId) === 0) {
    store.append({
      aggregateId,
      type: "workflow.control.initialized",
      version: initializedWorkflowRoot.version,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId,
      payload: initializedWorkflowRoot.payload,
    })
  }
  store.append({
    aggregateId,
    type: fact.type,
    version: fact.version,
    timestamp: Date.now(),
    actor: fact.actor,
    sessionId,
    payload: fact.payload,
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "flywheel-queue-projection-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

const sampleAttempt = (id: string) => ({
  id,
  definitionId: id,
  briefId: `fly.${id}`,
  workflowDefinitionId: "wf",
  name: id,
  status: "pending" as const,
  writes: [],
  resumeRevertCount: 0,
})

const sampleMutation = {
  timestamp: 1,
  action: "insert",
  actor: "test",
  reason: "test",
  attemptIds: ["s1"],
}

describe("queue projection invariants", () => {
  // Only a build before phases recorded a version 2 tree, and only its
  // control held the concurrent spans of `after`, so the root is one that
  // such a build recorded (vm/golden/committed-v10-history-arms.json).
  test("rebuilds a version 2 tree from control as a parallel phase without writing facts", async () => {
    const bindings = testResolvedAgents(["a", "b", "c"].map((id) => testResolvedAgent(id, testSkill(id))))
    const control = replayWorkflowControl([parseWorkflowSessionFact(arms.fork.root)])
    const { tree, ...queue } = flattenWorkflowView(control, bindings)
    expect(tree.nodes[0]).toMatchObject({ kind: "phase", form: "parallel" })
    // A version 2 tree named each agent a step. Builds before 2026-10-15 also
    // wrote `joinsInto`, which later trees dropped.
    const oldTree = { nodes: tree.nodes.flatMap((node) => node.kind === "agent"
      ? [{ id: node.id, kind: "step", stepId: node.definitionId, label: node.label, parentId: null, disposition: node.disposition, attempts: node.attempts, joinsInto: "Report" }]
      : []) }
    const events = storedWorkflowFacts([
      buildWorkflowControlInitializedFact({ ...control, aggregateSeq: 1 }),
      queueFact("queue.created", { rows: Schema.decodeUnknownSync(WorkflowRowsSchema)(queue) }),
      parseWorkflowSessionFact({ type: "queue.tree.changed", version: 2, actor: "flywheel", payload: { tree: oldTree } }),
    ])
    const before = structuredClone(events)
    expect(loadQueueFromEvents(events)?.tree).toEqual(tree)
    const source = asAsyncEventReadSurface(inMemoryEventReader(events))
    let aggregateReads = 0
    const reader = { ...source, readSlice: async (...args: Parameters<typeof source.readSlice>) => {
      if (args[0].types === undefined) aggregateReads += 1
      return source.readSlice(...args)
    } }
    const [first, second] = await Promise.all([loadQueueSnapshotFromReader(reader, "session"), loadQueueSnapshotFromReader(reader, "session")])
    expect(first?.tree).toEqual(tree)
    expect(second).toBe(first)
    expect(aggregateReads).toBe(1)
    expect(events).toEqual(before)

    // Builds of the phase grammar before the agent lexicon wrote the same
    // spellings as version 3, which the reader also rebuilds from control.
    const { joinsInto: _joinsInto, ...v3Node } = oldTree.nodes[0]!
    const v3Events = storedWorkflowFacts([
      buildWorkflowControlInitializedFact({ ...control, aggregateSeq: 1 }),
      queueFact("queue.created", { rows: Schema.decodeUnknownSync(WorkflowRowsSchema)(queue) }),
      parseWorkflowSessionFact({ type: "queue.tree.changed", version: 3, actor: "flywheel", payload: { tree: { nodes: [v3Node] } } }),
    ])
    expect(loadQueueFromEvents(v3Events)?.tree).toEqual(tree)
  })
  test("round-trips a parallel phase and the agents its agents wait on through the current tree fact", () => {
    const fact = queueFact("queue.tree.changed", { tree: { nodes: [
      { id: "a:span", kind: "phase", form: "parallel", phaseId: "parallel", label: "Parallel agents", parentId: null, disposition: "pending" },
      { id: "a", kind: "agent", definitionId: "a", label: "A", parentId: "a:span", disposition: "pending", attempts: 1 },
      { id: "b", kind: "agent", definitionId: "b", label: "B", parentId: "a:span", disposition: "pending", attempts: 1, waitsOn: ["a"], nodeId: "b-node" },
    ] } })
    expect(parseWorkflowQueueFact(JSON.parse(JSON.stringify(fact)))).toEqual(fact)
  })
  // A build before phases ran a follow-up chain as one node, and a version 1
  // tree showed that chain as one step.
  test.each(["absent", "v1", "invalid-suffix", "companion-damage"] as const)("upgrades %s historical follow-up chains without losing an execution", async (history) => {
    const skills = testSkillRevision(["work", "review"].map((id) => testSkill(id)))
    const definition = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "history", name: "History",
      phases: [{ phase: "work", brief: "Work.", name: "Work", writes: [] }, { phase: "review", brief: "Review.", name: "Review", writes: [] }],
    })
    const bindings = resolveWorkflowAgents(definition)
    let control = asThenChain(compileWorkflowControl(definition, bindings, { skills }))
    for (let index = 0; index < 2; index += 1) {
      const attempt = control.attempts.find(({ state }) => state._tag === "pending")!
      control = startExecution(control, attempt.id, `conversation-${index}`).control
      control = completeAttempt(control, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: attempt.id, conversationId: `conversation-${index}`, handoff: { summary: `${index}` }, reassessment: null } }).committed
    }
    const current = flattenWorkflowView(control, bindings)
    const { tree, ...queue } = current
    // Each execution of the chain is an agent of a single phase of its own,
    // which names the chain's control node.
    const chainNode = control.attempts[0]!.logicalNodeId
    expect(tree.nodes.flatMap((node) => node.kind === "agent" ? [node.nodeId] : [])).toEqual([chainNode, chainNode])
    const events = storedWorkflowFacts([
      buildWorkflowControlInitializedFact({ ...control, aggregateSeq: 1 }),
      queueFact("queue.created", { rows: Schema.decodeUnknownSync(WorkflowRowsSchema)(queue) }),
      ...(history === "absent" ? [] : [{
        type: "queue.tree.changed", version: 1, actor: "flywheel",
        payload: { tree: { nodes: [{ id: chainNode, kind: "step", label: "Work", parentId: null, disposition: "completed", currentAttemptId: control.attempts[1]!.id, attempts: 2 }] } },
      }] satisfies WorkflowQueueFact[]),
      ...(history === "invalid-suffix" ? [buildWorkflowControlCommittedFact("wrong-proposal", { type: "START" })] : []),
    ])
    // A damaged handoff body, and a current tree fact with a key that a
    // later build removed: neither decides control, and the tree rebuilds
    // from control.
    if (history === "companion-damage") events.push({
      ...events.at(-1)!, type: "handoff.written", version: 1, payload: {},
      id: "damaged", seq: events.length, position: (events.length + 1) * 10,
    }, {
      ...events.at(-1)!, type: "queue.tree.changed", version: 4,
      payload: { tree: { nodes: tree.nodes.map((node, index) => index === 0 ? { ...node, removedLaterField: "x" } : node) } },
      id: "unknown-key", seq: events.length + 1, position: (events.length + 2) * 10,
    })
    if (history === "invalid-suffix") {
      expect(recoverWorkflowControl(events).executable).toBe(false)
      expect(workflowRecoveryBasis(events)).toBeNull()
    }
    if (history === "companion-damage") {
      expect(recoverWorkflowControl(events).executable).toBe(true)
      expect(workflowRecoveryBasis(events)).not.toBeNull()
    }
    const before = structuredClone(events)
    const converted = loadQueueFromEvents(events)!
    expect(converted.tree.nodes.flatMap((node) => node.kind === "agent" ? [[node.definitionId, node.disposition, node.currentAttemptId]] : [])).toEqual([
      ["work", "completed", control.attempts[0]!.id], ["review", "completed", control.attempts[1]!.id],
    ])
    const reader = asAsyncEventReadSurface(inMemoryEventReader(events))
    expect(await loadQueueSnapshotFromReader(reader, "session")).toEqual(converted)
    expect(events).toEqual(before)
  })

  test("converts a retained version 1 map whose control is unreadable into one list phase for each stage", () => {
    const control = drive(mapControl(), mapOutcome(items("a", "b")))
    const { tree: _current, ...queue } = flattenWorkflowView(control, mapBindings)
    const settled = { reducer: "collect@1", state: "settled", slots: 2, completed: 2, failed: 0, pending: 0, missing: 0 } as const
    const v1Item = (ordinal: number, key: string) => [
      { id: branch(ordinal), kind: "branch", label: `Item ${key}`, key, ordinal, item: key, parentId: MAP_GROUP, disposition: "completed", attempts: 0 },
      { id: stage(ordinal, 1), kind: "step", label: "Implement", parentId: branch(ordinal), disposition: "completed", attempts: 1 },
      { id: stage(ordinal, 2), kind: "step", label: "Review", parentId: branch(ordinal), disposition: "completed", attempts: 1 },
    ] as const
    const events = storedWorkflowFacts([
      buildWorkflowControlInitializedFact({ ...control, aggregateSeq: 1 }),
      queueFact("queue.created", { rows: Schema.decodeUnknownSync(WorkflowRowsSchema)(queue) }),
      // A version 1 tree names no step ids, and a build before 2026-10-15
      // wrote the group's `joinsInto`.
      { type: "queue.tree.changed", version: 1, actor: "flywheel", payload: { tree: { nodes: [
        { id: MAP_GROUP, kind: "group", label: "Fix each", parentId: null, disposition: "completed", attempts: 0, stages: ["Implement", "Review"], stageIds: ["implement", "review"], join: settled, joinsInto: "Report" },
        ...v1Item(1, "a"), ...v1Item(2, "b"),
      ] } } },
      buildWorkflowControlCommittedFact("invalid", { type: "START" }),
    ])
    expect(workflowRecoveryBasis(events)).toBeNull()
    const item = (ordinal: number, key: string) => ({ nodeId: branch(ordinal), key, label: `Item ${key}`, ordinal, text: key })
    const nodes = loadQueueFromEvents(events)!.tree.nodes
    // The retained map keeps its place, and rows that it did not hold follow it.
    expect(nodes.slice(6).map(({ id }) => id)).toEqual(["mapped:node:1:phase", "mapped:node:1", "mapped:node:4:phase", "mapped:node:4"])
    expect(nodes.slice(0, 6)).toMatchObject([
      { id: `${MAP_GROUP}:phase:1`, kind: "phase", form: "list", phaseId: "implement", label: "Implement", parentId: null, disposition: "completed", list: { id: MAP_GROUP, expanded: true } },
      ...([[1, "a"], [2, "b"]] as const).map(([ordinal, key]) => ({ id: stage(ordinal, 1), kind: "agent", definitionId: "implement", label: "Implement", parentId: `${MAP_GROUP}:phase:1`, disposition: "completed", attempts: 1, currentAttemptId: `${stage(ordinal, 1)}:attempt:1`, item: item(ordinal, key) })),
      { id: `${MAP_GROUP}:phase:2`, kind: "phase", form: "list", phaseId: "review", label: "Review", parentId: null, disposition: "completed", list: { id: MAP_GROUP, expanded: true }, join: settled },
      ...([[1, "a"], [2, "b"]] as const).map(([ordinal, key]) => ({ id: stage(ordinal, 2), kind: "agent", definitionId: "review", label: "Review", parentId: `${MAP_GROUP}:phase:2`, disposition: "completed", attempts: 1, currentAttemptId: `${stage(ordinal, 2)}:attempt:1`, item: item(ordinal, key) })),
    ])
  })

  test("retained retry edges collapse attempts and reassessment targets override encoded owners", () => {
    const initial = initializedWorkflowRoot.payload.control
    const first = initial.attempts[0]!
    const retryId = `${first.logicalNodeId}:attempt:2`
    const replacementId = "other-owner:attempt:1:reassessment:1"
    const rows = [
      { ...sampleAttempt(first.id), definitionId: "work", status: "failed" as const },
      { ...sampleAttempt(retryId), definitionId: "work", status: "completed" as const },
      { ...sampleAttempt(replacementId), definitionId: "review", status: "completed" as const },
    ]
    const events = storedWorkflowFacts([
      initializedWorkflowRoot,
      queueFact("queue.created", { rows: { attempts: rows, cursor: 3, status: "completed", mutationLog: [] } }),
      buildAttemptRetryInsertedFact(first.id, retryId, "retry"),
      buildWorkflowReassessedFact("replace", [{ kind: "insert_after", targetAttemptId: retryId, afterAttemptId: retryId, attemptId: replacementId, forItem: null, reason: "review" }]),
      { type: "queue.tree.changed", version: 1, actor: "flywheel", payload: { tree: { nodes: [{ id: first.logicalNodeId, kind: "step", label: "Work", parentId: null, disposition: "completed", attempts: 3, currentAttemptId: replacementId }] } } },
      buildWorkflowControlCommittedFact("invalid", { type: "START" }),
    ])
    expect(workflowRecoveryBasis(events)).toBeNull()
    const nodes = loadQueueFromEvents(events)!.tree.nodes
    // The executions of the chain are agents of single phases of their own.
    expect(nodes.map(({ kind }) => kind)).toEqual(["phase", "agent", "phase", "agent"])
    expect(nodes.flatMap((node) => node.kind === "agent" ? [[node.definitionId, node.attempts, node.currentAttemptId, node.parentId]] : [])).toEqual([
      ["work", 2, retryId, `${first.id}:phase`], ["review", 1, replacementId, `${replacementId}:phase`],
    ])
    expect(() => loadQueueFromEvents(events.filter((event) => event.type !== "workflow.reassessed"))).toThrow(InvariantViolation)
  })
  test("historical normalization is shared across overlapping live, replaying and one-shot reads", async () => {
    const events = storedWorkflowFacts([initializedWorkflowRoot, queueFact("queue.created", {
      rows: { attempts: [sampleAttempt("s1")], cursor: 0, status: "idle", mutationLog: [] },
    })])
    const source = asAsyncEventReadSurface(inMemoryEventReader(events))
    let aggregateReads = 0
    const reader = { ...source, readSlice: async (...args: Parameters<typeof source.readSlice>) => {
      if (args[0].types === undefined) {
        aggregateReads += 1
        if (aggregateReads === 1) events.push(...storedWorkflowFacts([
          buildWorkflowControlInitializedFact({
            ...startExecution(initializedWorkflowRoot.payload.control, initializedWorkflowRoot.payload.control.attempts[0]!.id, "running").control,
            aggregateSeq: 2,
          }),
        ], 2))
      }
      return source.readSlice(...args)
    } }
    const live = createLiveWorkflowView(reader, "session")
    const replaying = createReplayingWorkflowView(reader, "session")
    const [first, second, third] = await Promise.all([live.read(), replaying.read(), loadQueueSnapshotFromReader(reader, "session")])
    expect(first?.tree.nodes.map(({ kind }) => kind)).toEqual(["phase", "agent"])
    expect(first?.status).toBe("idle")
    expect(first?.attempts[0]?.status).toBe("pending")
    expect(first?.tree.nodes.some((node) => node.disposition === "running")).toBe(false)
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(aggregateReads).toBe(1)
    expect(await loadQueueSnapshotFromReader(reader, "session")).toBe(first)
    expect(aggregateReads).toBe(1)
    const next = storedWorkflowFacts([queueFact("queue.state.changed", { status: "paused", cursor: 0, maxAttempts: null })], 3)
    events.push(...next)
    await live.apply(next)
    const updated = await live.read()
    expect(updated).not.toBe(first)
    expect(aggregateReads).toBe(1)
    expect(await replaying.read()).toBe(updated)
    const tree = updated!.tree
    const current = storedWorkflowFacts([queueFact("queue.tree.changed", { tree })], 4)
    events.push(...current)
    await live.apply(current)
    expect((await live.read())?.tree).toEqual(tree)
    expect(aggregateReads).toBe(1)
  })
  test.each([2, 20])("resumed historical trees advance without refolding %s prior proposals", async (history) => {
    const bindings = testResolvedAgents([testResolvedAgent("work", testSkill("work"))])
    const control = initializedWorkflowRoot.payload.control
    const { tree: _tree, ...rows } = flattenWorkflowView(control, bindings)
    const events = storedWorkflowFacts([initializedWorkflowRoot, queueFact("queue.created", { rows })])
    let state = initializeWorkflow(replayWorkflowControl(events)).state
    function commit(type: "PAUSE" | "RESUME") {
      const queue = loadQueueFromEvents(events)!
      const proposal = composeWorkflowCompanions(transitionWorkflow(state, type === "PAUSE" ? { type, reason: "person" } : { type, readers: {} }), {
        queue, resolvedAgents: bindings, timestamp: 100, addenda: [],
      })
      if (proposal.command.kind !== "commit" || !proposal.state.context.pending) throw new Error("expected proposal")
      const pending = proposal.state.context.pending
      const batch = storedWorkflowFacts(proposal.command.proposal.facts, events.length)
      events.push(...batch)
      state = transitionWorkflow(proposal.state, { type: "COMMIT_SUCCEEDED", proposalId: pending.proposalId, aggregateSeq: pending.proposedCommitted.aggregateSeq }).state
      return batch
    }
    for (let index = 0; index < history; index += 1) {
      commit("PAUSE")
      commit("RESUME")
    }
    const counter = countStateRequests(asAsyncEventReadSurface(inMemoryEventReader(events)))
    const live = createLiveWorkflowView(counter.reader, "session")
    const first = await live.read()
    counter.take()
    const next = commit("PAUSE")
    expect(next.some(({ type }) => type === "queue.tree.changed")).toBe(false)
    await live.apply(next)
    expect((await live.read())?.tree).toEqual(first?.tree)
    expect((await live.read())?.status).toBe("paused")
    const requests = counter.take()
    expect(factsRead(requests)).toBe(1)
    expect(requests.filter(({ method }) => method === "readSlice")).toHaveLength(0)
  })
  test("queue.mutated before queue.created throws InvariantViolation kind=missing-producer-event", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "queue-orphan-mutated"
    appendFact(store, sessionId, queueFact("queue.mutated", { mutation: sampleMutation }))

    let caught: unknown
    try {
      await createWorkflowQueueProjection(asAsyncEventReadSurface(store), sessionId).replay()
    } catch (err) {
      caught = err
    }
    store.close()

    expect(caught).toBeInstanceOf(InvariantViolation)
    if (!(caught instanceof InvariantViolation)) throw new Error("expected invariant violation")
    expect(caught.kind).toBe("missing-producer-event")
    expect(caught.eventType).toBe("queue.mutated")
  })

  test("step.status.changed for an unknown attempt id after queue.created throws InvariantViolation with the id in detail", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "queue-unknown-step"
    appendFact(store, sessionId, queueFact("queue.created", {
      rows: { attempts: [sampleAttempt("s1")], cursor: 0, status: "idle", mutationLog: [] },
    }))
    appendFact(store, sessionId, queueFact("step.status.changed", { attemptId: "ghost-step", status: "running" }))

    let caught: unknown
    try {
      await createWorkflowQueueProjection(asAsyncEventReadSurface(store), sessionId).replay()
    } catch (err) {
      caught = err
    }
    store.close()

    expect(caught).toBeInstanceOf(InvariantViolation)
    if (!(caught instanceof InvariantViolation)) throw new Error("expected invariant violation")
    const violation = caught
    expect(violation.kind).toBe("missing-producer-event")
    expect(violation.eventType).toBe("step.status.changed")
    expect(violation.detail).toContain("ghost-step")
  })

  test("live queue view seeds once and folds pushed facts: same reference until apply, fresh queue after", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "queue-live-view"
    appendFact(store, sessionId, queueFact("queue.created", {
      rows: { attempts: [sampleAttempt("s1")], cursor: 0, status: "idle", mutationLog: [] },
    }))

    const view = createLiveWorkflowView(asAsyncEventReadSurface(store), sessionId)
    const first = await view.read()
    expect(first?.status).toBe("idle")

    // read() is push-fed: nothing pushed, identical reference back.
    expect(await view.read()).toBe(first)

    const stored = store.append({
      aggregateId: `workflow:${sessionId}`,
      type: "step.status.changed",
      version: 2,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId,
      payload: { attemptId: "s1", status: "running" },
    })
    await view.apply(stored)
    const updated = await view.read()
    store.close()

    expect(updated).not.toBe(first)
    expect(updated?.attempts[0]?.status).toBe("running")
  })

  test("store onStored broadcast fires post-commit with the stored batch", () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "queue-on-stored"
    const batches: number[] = []
    const unsubscribe = store.onStored((events) => { batches.push(events.length) })

    appendFact(store, sessionId, queueFact("queue.created", {
      rows: { attempts: [sampleAttempt("s1")], cursor: 0, status: "idle", mutationLog: [] },
    }))
    expect(batches).toEqual([1, 1])

    store.transaction(() => {
      appendFact(store, sessionId, queueFact("step.status.changed", { attemptId: "s1", status: "running", previousStatus: "pending" }))
      appendFact(store, sessionId, queueFact("step.status.changed", { attemptId: "s1", status: "completed", previousStatus: "running" }))
      // Nothing announced until the outer transaction commits.
      expect(batches).toEqual([1, 1])
    })
    expect(batches).toEqual([1, 1, 2])

    unsubscribe()
    appendFact(store, sessionId, queueFact("queue.deleted", {}))
    store.close()
    expect(batches).toEqual([1, 1, 2])
  })

  test("a step's timing comes from the times its status changed: the first start and the settlement", () => {
    // Timestamps follow the fact order: the initialized root is 1, the queue is 2.
    const events = storedWorkflowFacts([
      initializedWorkflowRoot,
      queueFact("queue.created", { rows: { attempts: [sampleAttempt("s1"), sampleAttempt("s2")], cursor: 0, status: "running", mutationLog: [] } }),
      queueFact("step.status.changed", { attemptId: "s1", status: "running", previousStatus: "pending" }),
      queueFact("step.status.changed", { attemptId: "s1", status: "pending", previousStatus: "running" }),
      queueFact("step.status.changed", { attemptId: "s1", status: "running", previousStatus: "pending" }),
      queueFact("step.status.changed", { attemptId: "s1", status: "completed", previousStatus: "running" }),
      queueFact("step.status.changed", { attemptId: "s2", status: "running", previousStatus: "pending" }),
    ])
    const [first, second] = loadQueueFromEvents(events)?.attempts ?? []
    expect([first?.startedAt, first?.completedAt]).toEqual([3, 6])
    expect([second?.startedAt, second?.completedAt]).toEqual([7, undefined])
  })

  test("the registered queue.created rejects an attempt row without resumeRevertCount", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "queue-missing-resume-revert-count"
    const { resumeRevertCount: _omitted, ...invalidAttempt } = sampleAttempt("s1")
    store.append({
      aggregateId: `workflow:${sessionId}`,
      type: "workflow.control.initialized",
      version: initializedWorkflowRoot.version,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId,
      payload: initializedWorkflowRoot.payload,
    })
    store.append({
      aggregateId: `workflow:${sessionId}`,
      type: "queue.created", version: queueFact("queue.created", { rows: { attempts: [], cursor: 0, status: "idle", mutationLog: [] } }).version, actor: "flywheel",
      payload: { rows: { attempts: [invalidAttempt], cursor: 0, status: "idle", mutationLog: [] } },
      timestamp: Date.now(),
      sessionId,
    })

    await expect(loadQueueSnapshotFromReader(asAsyncEventReadSurface(store), sessionId)).rejects.toThrow(InvariantViolation)
    store.close()
  })

  test("replaying queue view sees a later commit without being rebuilt, and re-reads cost no fold", async () => {
    // The pull-fed sibling. A background lane holds one of these per session;
    // rebuilding instead replayed the whole aggregate from zero on every pass,
    // which is what spun one runtime for sixteen hours.
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "queue-replaying-view"
    appendFact(store, sessionId, queueFact("queue.created", {
      rows: { attempts: [sampleAttempt("s1")], cursor: 0, status: "idle", mutationLog: [] },
    }))

    const view = createReplayingWorkflowView(asAsyncEventReadSurface(store), sessionId)
    const first = await view.read()
    expect(first?.status).toBe("idle")
    // Nothing new committed: the decode memo holds, so the reference is stable.
    expect(await view.read()).toBe(first)

    // A commit this view was never told about, as another process would make.
    store.append({
      aggregateId: `workflow:${sessionId}`,
      type: "step.status.changed",
      version: 2,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId,
      payload: { attemptId: "s1", status: "running" },
    })

    const updated = await view.read()
    expect(updated).not.toBe(first)
    expect(updated?.attempts[0]?.status).toBe("running")
    store.close()
  })

  test.each(["cold", "replay", "apply"] as const)("newest recovered queue root bypasses old poison on %s", async (mode) => {
    const created = queueFact("queue.created", {
      rows: { attempts: [sampleAttempt("old")], cursor: 0, status: "idle", mutationLog: [] },
    })
    const events = storedWorkflowFacts([initializedWorkflowRoot, created])
    const reader = inMemoryEventReader(events)
    const projectionReader = asAsyncEventReadSurface(reader)
    const held = mode === "cold" ? null : createWorkflowQueueProjection(projectionReader, "session")
    const snapshot = held ? queueFromProjection(await held.replay()) : null
    events.push({ ...storedWorkflowFacts([created], 2)[0]!, payload: {} })
    const recovered = recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 5)
    const batch = storedWorkflowFacts([recovered, queueFact("queue.created", {
      rows: { attempts: [sampleAttempt("new")], cursor: 0, status: "paused", mutationLog: [] },
    })], 3)
    events.push(...batch)
    const projection = held ?? createWorkflowQueueProjection(projectionReader, "session")
    if (mode === "apply") await projection.apply(events.slice(2))
    const state = mode === "apply" ? projection.getState() : await projection.replay()
    expect(queueFromProjection(state)?.attempts.map(({ id }) => id)).toEqual(["new"])
    expect(projection.getPosition()).toBe(50)
    expect(createWorkflowQueueProjection(projectionReader, "session")).toBe(projection)
    expect(loadQueueFromEvents(events)).toEqual(queueFromProjection(state, events))
    expect(loadWorkflowStateFromEvents(events)).toBe("paused")
    expect((await readWorkflowStatees(["session"], projectionReader)).statuses.get("session")).toBe("paused")
    if (snapshot) expect(snapshot.attempts.map(({ id }) => id)).toEqual(["old"])

    const next = storedWorkflowFacts([
      recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 7),
      queueFact("queue.created", { rows: { attempts: [], cursor: 0, status: "paused", mutationLog: [] } }),
    ], 5)
    events.push(...next)
    if (mode === "apply") await projection.apply(next)
    expect(queueFromProjection(await projection.replay())?.attempts).toEqual([])
    expect(loadQueueFromEvents(events)?.attempts).toEqual([])
    expect(events[2]?.payload).toEqual({})
  })

  test.each([1, 99])("a malformed recovered root version %s fences every queue read", async (version) => {
    const events = storedWorkflowFacts([initializedWorkflowRoot, queueFact("queue.created", {
      rows: { attempts: [], cursor: 0, status: "idle", mutationLog: [] },
    })])
    const reader = inMemoryEventReader(events)
    const projectionReader = asAsyncEventReadSurface(reader)
    const held = createWorkflowQueueProjection(projectionReader, "session")
    // A recovery commits its root with the queue it starts from in one batch.
    const [recovered, companion] = storedWorkflowFacts([recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 4), queueFact("queue.created", {
      rows: { attempts: [], cursor: 0, status: "idle", mutationLog: [] },
    })], 2)
    const root: StoredFact = { ...recovered!, version, payload: {} }
    events.push(root, companion!)
    await expect(held.replay()).rejects.toThrow(InvariantViolation)
    await expect(held.apply([root, companion!])).rejects.toThrow(InvariantViolation)
    await expect(createWorkflowQueueProjection(asAsyncEventReadSurface(inMemoryEventReader(events)), "session").replay()).rejects.toThrow(InvariantViolation)
    expect(() => loadQueueFromEvents(events)).toThrow(InvariantViolation)
    expect(() => loadWorkflowStateFromEvents(events)).toThrow(InvariantViolation)
    expect((await readWorkflowStatees(["session"], projectionReader)).errors).toHaveLength(1)
  })

  /** The facts of a run of one parallel phase of `agents` agents, as the
   *  current build writes them. */
  async function parallelRun(agents: number): Promise<StoredFact[]> {
    const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
      id: "wide", name: "Wide",
      phases: [{ phase: "wide", agents: Array.from({ length: agents }, (_, index) => { const id = `a${String(index).padStart(2, "0")}`; return { agent: id, name: id, brief: "Run.", writes: [] } }) }],
    })
    const store = createMemoryStore(initialFacts(workflow))
    const host = testHost(store, {
      workflow,
      attemptRunner: { run: async (input, active) => ({ kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: input.definitionId }, reassessment: null }) },
    })
    try {
      expect((await host.run()).kind).toBe("completed")
    } finally {
      await host.dispose()
    }
    return store.events
  }

  /** The history as builds before node changes wrote it: each batch that
   *  changed nodes stores the whole tree after its changes instead. Only the
   *  batches that `converts` selects are converted. */
  function wholeTreeHistory(events: readonly StoredFact[], converts: (batch: number) => boolean): StoredFact[] {
    let tree: WorkflowTree | undefined
    let batch = 0
    const result: StoredFact[] = []
    for (const [index, event] of events.entries()) {
      const fact = event.type.startsWith("queue.tree.") ? parseWorkflowQueueFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload }) : undefined
      if (fact?.type === "queue.tree.changed" && fact.version === 4) tree = fact.payload.tree
      if (fact?.type !== "queue.tree.node.changed") { result.push(event); continue }
      if (!tree) throw new Error("Expected a node change after a tree")
      const { currentAgentNodeId: _current, ...rest } = tree
      tree = { ...rest, nodes: tree.nodes.map((node) => node.id === fact.payload.node.id ? fact.payload.node : node), ...(fact.payload.currentAgentNodeId === null ? {} : { currentAgentNodeId: fact.payload.currentAgentNodeId }) }
      // The previous producer wrote one tree for each batch, after its last change.
      if (events[index + 1]?.type === "queue.tree.node.changed") { if (!converts(batch)) result.push(event); continue }
      if (converts(batch)) result.push({ ...event, type: "queue.tree.changed", version: 4, payload: { tree } })
      else result.push(event)
      batch += 1
    }
    return result
  }

  test("a run stores node changes, and the whole-tree shape and a mix of both shapes fold to the same view", async () => {
    const events = await parallelRun(4)
    expect(events.filter(({ type }) => type === "queue.tree.node.changed").length).toBeGreaterThan(0)
    const view = loadQueueFromEvents(events)
    expect(view?.tree.nodes.filter(({ kind }) => kind === "agent").map(({ disposition }) => disposition)).toEqual(["completed", "completed", "completed", "completed"])
    const previous = wholeTreeHistory(events, () => true)
    expect(previous.some(({ type }) => type === "queue.tree.node.changed")).toBe(false)
    expect(loadQueueFromEvents(previous)).toEqual(view)
    const mixed = wholeTreeHistory(events, (batch) => batch % 2 === 0)
    expect(new Set(mixed.flatMap(({ type }) => type.startsWith("queue.tree.") ? [type] : []))).toEqual(new Set(["queue.tree.changed", "queue.tree.node.changed"]))
    expect(loadQueueFromEvents(mixed)).toEqual(view)
    // The held projection folds the same facts to the same view.
    expect(await createReplayingWorkflowView(asAsyncEventReadSurface(inMemoryEventReader(mixed)), "session").read()).toEqual(view)
  })

  test("a node change this build cannot read rebuilds the tree from control", async () => {
    const events = await parallelRun(4)
    const view = loadQueueFromEvents(events)
    const last = events.findLastIndex(({ type }) => type === "queue.tree.node.changed")
    const stored = events[last]!
    const { node } = stored.payload
    if (typeof node !== "object" || node === null) throw new Error("expected a stored tree node")
    const damaged = events.with(last, { ...stored, payload: { ...stored.payload, node: { ...node, removedLaterField: "x" } } })
    expect(loadQueueFromEvents(damaged)).toEqual(view)
  })

  test("a commit stores the same tree nodes whatever the number of agents", async () => {
    /** The most tree nodes that one commit after the launch stored, and the
     *  most bytes of one stored node. The node changes of a commit are
     *  contiguous. Ids grow by a digit with the count, so bytes are bounded
     *  rather than equal. */
    const treePerCommit = async (agents: number) => {
      const events = await parallelRun(agents)
      expect(events.slice(initialFacts().length).some(({ type }) => type === "queue.tree.changed")).toBe(false)
      const commits: number[] = []
      let bytes = 0
      let previous: string | undefined
      for (const event of events) {
        if (event.type === "queue.tree.node.changed") {
          if (previous !== "queue.tree.node.changed") commits.push(0)
          commits[commits.length - 1]! += 1
          bytes = Math.max(bytes, JSON.stringify(event.payload).length)
        }
        previous = event.type
      }
      return { nodes: Math.max(...commits), bytes }
    }
    const [few, many] = [await treePerCommit(3), await treePerCommit(12)]
    expect(many.nodes).toBe(few.nodes)
    expect(many.bytes).toBeLessThan(few.bytes + 16)
  })
})
