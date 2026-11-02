import { describe, expect, it } from "bun:test"
import { asAsyncEventReadSurface, CorruptEventRowError, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { recoverWorkflowContext } from "../../../../src/workflows/context-bundle/context-recovery.js"
import { validateWorkflowBootstrap } from "../../../../src/workflows/vm/bootstrap-validation.js"
import { createMemoryStore, initialFacts, testHost, workflow } from "./host-test-support.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { commitWorkflowRecovery } from "../../../../src/orchestration/workflow-host/recovery-commit.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { buildWorkflowControlInitializedFact, parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { buildAttemptRecoveredFact } from "../../../../src/workflows/vm/fact-drafts.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { workflowRecoveryBasis } from "../../../../src/workflows/vm/recovery.js"
import { initializedWorkflowFacts, initializedWorkflowRoot, recoveredWorkflowRoot, storedWorkflowFacts } from "../../../helpers/workflow-root-fixtures.js"
import { controlBeforePhases } from "../../../helpers/control-before-phases.js"
import { buildContextAccumulatedFact, buildContextInputAddedFact, buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts.js"

describe("complete workflow bootstrap", () => {
  it("recovers the input seed that ordinary initialization publishes before its root", () => {
    const facts = storedWorkflowFacts(initializedWorkflowFacts("Original request"))
    expect(recoverWorkflowContext(facts)).toEqual({
      seed: { fact: buildContextInputSeededFact("workflow", "Original request"), timestamp: 1 },
      records: [],
      reasons: [],
    })
  })

  it.each(["malformed JSON", "malformed payload", "unsupported version"])(
    "fences predecessor context at a newest initialized root with %s",
    (damage) => {
      const accumulated = parseWorkflowSessionFact({
        type: "context.accumulated", version: 4, actor: "flywheel",
        payload: { entry: {
          stepId: "writer", stepName: "Writer", definitionId: "work", workflowDefinitionId: "workflow",
          recipientStepId: null, timestamp: 21,
          writes: [{ id: "artifact", lifetime: "durable", supersedes: [] }],
          handoff: { summary: "readable" },
        } },
      })
      if (accumulated.type !== "context.accumulated") throw new Error("Expected accumulated context")
      const predecessor = storedWorkflowFacts([
        ...initializedWorkflowFacts("Predecessor request"),
        accumulated,
      ])
      const initialized = storedWorkflowFacts([initializedWorkflowRoot], predecessor.length)[0]!
      const newest = damage === "malformed JSON"
        ? new CorruptEventRowError({
          ...initialized, eventId: initialized.id, rawPayload: "not-json",
        }, "Payload is not JSON")
        : damage === "malformed payload"
          ? { ...initialized, payload: { control: {} } }
          : { ...initialized, version: initialized.version + 1 }
      const fenced = [...predecessor, newest]
      expect(recoverWorkflowContext(fenced)).toEqual({ seed: null, records: [], reasons: [] })

      const retained = storedWorkflowFacts([accumulated], initialized.seq + 1)
      const facts = [...fenced, ...retained]
      const original = JSON.stringify(facts)
      expect(recoverWorkflowContext(facts)).toEqual({
        seed: null,
        records: [{ fact: accumulated, timestamp: initialized.seq + 2 }],
        reasons: [],
      })
      expect(JSON.stringify(facts)).toBe(original)
    },
  )

  it("keeps predecessor-context salvage exclusive to the exact historical v1 two-fact root", () => {
    const root = recoveredWorkflowRoot(initializedWorkflowRoot.payload.control, 3)
    const identities = {
      ...root.payload.identities,
      attempt: { source: "recovered" as const, value: "attempt" },
      conversation: { source: "recovered" as const, value: "conversation" },
    }
    for (const version of [1, 2]) {
      const recovered = parseWorkflowSessionFact({
        ...root, version, payload: { ...root.payload, supersededThroughSeq: 0, identities, control: { ...controlBeforePhases(root.payload.control), issues: [], seals: [] } },
      })
      const facts = storedWorkflowFacts([
        buildContextInputSeededFact("workflow", "Predecessor request"),
        recovered,
        buildAttemptRecoveredFact("attempt", "conversation"),
      ])
      expect(recoverWorkflowContext(facts).seed?.fact.payload.userRequest ?? null)
        .toBe(version === 1 ? "Predecessor request" : null)
      expect(replayWorkflowControl(facts)).toEqual(root.payload.control)
    }
  })

  it("keeps a raw-JSON-damaged newest root as a fence rather than reviving older control", () => {
    const store = createMemoryStore(initialFacts())
    const corrupt = new CorruptEventRowError({
      aggregateId: "workflow:session", seq: 3, position: 4, type: "workflow.control.recovered",
      version: 1, timestamp: 4, actor: "flywheel", sessionId: "session", eventId: "corrupt-root", rawPayload: "not-json",
    }, "Payload is not JSON")
    const facts = [...store.events, corrupt]
    expect(workflowRecoveryBasis(facts)).toBeNull()
    expect(validateWorkflowBootstrap(facts)).toMatchObject({ kind: "recovery", reasons: [{ kind: "malformed_fact", seq: 3 }] })
  })

  it("repairs companions of settled control without turning completed work into another task", async () => {
    const original = createMemoryStore(initialFacts())
    const host = testHost(original, { attemptRunner: { run: async (input, owner) => ({
      kind: "success", attemptId: input.attemptId, conversationId: owner.conversationId,
      handoff: { summary: "complete" }, reassessment: null,
    }) } })
    expect((await host.run()).kind).toBe("completed")
    const completed = replayWorkflowControl(original.events)
    const store = createMemoryStore([{
      ...buildWorkflowControlInitializedFact({ ...completed, aggregateSeq: 0 }),
      aggregateId: "workflow:session", sessionId: "session", timestamp: 1,
    }, {
      aggregateId: "workflow:session", sessionId: "session", timestamp: 1,
      type: "workflow.run.registered", version: 1, actor: "flywheel",
      payload: {
        request: "Original task",
        settings: { workflowDefinitionId: workflow.id, label: "Original task", executionCwd: "/scratch", createdAt: new Date(1).toISOString(), lastUpdated: new Date(1).toISOString(), roleAssignments: { defaults: {}, overrides: {} } },
        launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "launch" },
      },
    }])
    const result = await commitWorkflowRecovery({
      sessionId: "session", reader: asAsyncEventReadSurface(inMemoryEventReader(store.events)), writer: store,
      timestamp: new Date(1).toISOString(),
      runtimeIdentity: async () => ({ version: "test", buildId: "test" }),
      prepare: async (basis) => {
        expect(basis?.status).toBe("completed")
        if (!basis) throw new Error("Settled root remains a basis")
        return { control: basis, resolvedAgents: resolveWorkflowAgents(workflow) }
      },
    })
    expect(result.kind).toBe("committed")
    const repaired = replayWorkflowControl(store.events.filter(({ aggregateId }) => aggregateId === "workflow:session"))
    expect(repaired.attempts.map(({ state }) => state._tag)).toEqual(completed.attempts.map(({ state }) => state._tag))
    expect(repaired.graph).toEqual(completed.graph)
    const queueIndex = original.events.findIndex(({ type }) => type === "queue.created")
    original.events.splice(queueIndex, 1)
    const repairedSuffix = await commitWorkflowRecovery({
      sessionId: "session", reader: asAsyncEventReadSurface(inMemoryEventReader(original.events)), writer: original,
      timestamp: new Date(2).toISOString(),
      runtimeIdentity: async () => ({ version: "test", buildId: "test" }),
      prepare: async (basis) => {
        expect(basis).toEqual(completed)
        if (!basis) throw new Error("Completed semantic suffix must survive missing bootstrap queue")
        return { control: basis, resolvedAgents: resolveWorkflowAgents(workflow) }
      },
    })
    expect(repairedSuffix.kind).toBe("committed")
    expect(replayWorkflowControl(original.events.filter(({ aggregateId }) => aggregateId === "workflow:session")).attempts.map(({ state }) => state._tag)).toEqual(completed.attempts.map(({ state }) => state._tag))
    await host.dispose()
  })

  it("requires canonical input and matching current queue identities without changing valid control", () => {
    const store = createMemoryStore(initialFacts())
    expect(validateWorkflowBootstrap(store.events).executable).toBe(true)
    const queue = store.events.find(({ type }) => type === "queue.created")!
    const seed = store.events.find(({ type }) => type === "context.input.seeded")!
    for (const excluded of [[queue], [seed], [queue, seed]]) {
      const result = validateWorkflowBootstrap(store.events.filter((fact) => !excluded.includes(fact)))
      expect(result.kind).toBe("recovery")
      if (result.kind === "recovery") {
        for (const fact of excluded) {
          if (fact.type !== "queue.created" && fact.type !== "context.input.seeded") throw new Error("Expected bootstrap companion")
          expect(result.reasons).toContainEqual({ kind: "missing_companion", family: fact.type })
        }
      }
    }
    const result = validateWorkflowBootstrap(store.events.map((fact) => fact === queue
      ? { ...fact, payload: { rows: { attempts: [], cursor: 0, status: "idle", mutationLog: [] } } }
      : fact))
    expect(result).toMatchObject({ kind: "recovery", reasons: [{ kind: "missing_companion", family: "queue.created" }] })
  })

  it("stays executable when a tree fact holds an unknown key, and names a step-row fact it cannot read", () => {
    const store = createMemoryStore(initialFacts())
    const withUnknownKey = (type: string) =>
      store.events.map((fact) => fact.type === type ? { ...fact, payload: { ...fact.payload, removedLaterField: "x" } } : fact)

    // A tree only describes control, so Resume stays available.
    expect(store.events.map(({ type }) => type)).toContain("queue.tree.changed")
    expect(validateWorkflowBootstrap(withUnknownKey("queue.tree.changed")).executable).toBe(true)

    // The step list exists, so the reason is the fact that does not read.
    const rows = withUnknownKey("queue.created")
    const created = rows.find(({ type }) => type === "queue.created")!
    expect(validateWorkflowBootstrap(rows)).toMatchObject({
      kind: "recovery",
      reasons: [{ kind: "unknown_version", seq: created.seq, type: "queue.created", version: created.version }],
    })
  })

  it("retains typed entry order, timestamp, supersession and recipient, salvages v3, and reports unreadable bytes", () => {
    const entry = {
      stepId: "writer", stepName: "Writer", definitionId: "work", workflowDefinitionId: "host-test",
      recipientStepId: "corrective", timestamp: 21,
      writes: [{ id: "artifact", lifetime: "durable", supersedes: ["prior"] }],
      handoff: { summary: "readable" },
    }
    const event = (seq: number, version: number, payload: StoredFact["payload"]): StoredFact => ({
      id: `event-${seq}`, position: seq + 1, seq, aggregateId: "workflow:session", sessionId: "session",
      actor: "flywheel", type: "context.accumulated", version, timestamp: 20 + seq, payload,
    })
    const { recipientStepId: _recipient, ...legacy } = entry
    const facts = [event(0, 4, { entry }), event(1, 3, { entry: legacy }), event(2, 4, { entry: { broken: true } })]
    const original = JSON.stringify(facts)
    const recovered = recoverWorkflowContext(facts)
    expect(recovered.records).toMatchObject([
      { timestamp: 20, fact: { version: 4, payload: { entry } } },
      { timestamp: 21, fact: { version: 4, payload: { entry: { ...entry, recipientStepId: null } } } },
    ])
    expect(recovered.reasons).toEqual([{ kind: "malformed_fact", seq: 2 }])
    expect(JSON.stringify(facts)).toBe(original)
  })

  it("retains request addenda and handoff entries in one recorded order with their timestamps and reports an unreadable addendum", () => {
    const readBy = { attemptId: "work-1", agentName: "Work", conversationId: "conversation-1" }
    const first = buildContextInputAddedFact({ key: "msg:parent:tool-1", source: { kind: "parent", name: "Chat" }, text: "Use SQLite.", readBy })
    const second = buildContextInputAddedFact({ key: "msg:parent:tool-2", source: { kind: "parent", name: "Chat" }, text: "Skip the CLI.", readBy })
    // A post-join entry between two addenda: the context places the branch
    // addenda that it promotes at the join's position, so recovery must
    // keep the entry between them.
    const join = buildContextAccumulatedFact({
      entryId: "workflow:node:2:join", agentName: "Per item", definitionId: "per-item", workflowDefinitionId: "workflow",
      recipientAttemptId: null, timestamp: 2, writes: [{ id: "per-item", lifetime: "transient" }], handoff: { total: 0, completed: 0, failed: 0, items: [] },
    })
    if (join.type !== "context.accumulated") throw new Error("Expected an accumulated entry")
    const launch = storedWorkflowFacts(initializedWorkflowFacts("Original request"))
    const added = storedWorkflowFacts([first, { ...first, payload: { ...first.payload, key: "" } }, join, second], launch.length)
    const facts = [...launch, ...added]
    const original = JSON.stringify(facts)
    const recovered = recoverWorkflowContext(facts)
    expect(recovered.records).toEqual([
      { fact: first, timestamp: added[0]!.timestamp },
      { fact: join, timestamp: added[2]!.timestamp },
      { fact: second, timestamp: added[3]!.timestamp },
    ])
    expect(recovered.reasons).toEqual([{ kind: "malformed_fact", seq: added[1]!.seq }])
    expect(validateWorkflowBootstrap([...launch, ...storedWorkflowFacts([first, second], launch.length)]).executable).toBe(true)
    const bootstrap = validateWorkflowBootstrap(facts)
    expect(bootstrap.kind === "recovery" && bootstrap.reasons).toContainEqual({ kind: "malformed_fact", seq: added[1]!.seq })
    expect(JSON.stringify(facts)).toBe(original)
  })
})
