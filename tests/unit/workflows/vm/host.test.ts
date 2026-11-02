import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { parseProjectionFact } from "../../../../src/infra/event-projection.js"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { buildWorkflowCompletedFact, buildWorkflowFailedFact } from "../../../../src/workflows/vm/fact-drafts.js"
import { asAsyncEventReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"
import type { WorkflowRuntimeEvent } from "../../../../src/workflows/vm/host-types.js"
import { createWorkflowRuntimePublisher } from "../../../../src/workflows/vm/host-publication.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import { drive, fourLaneControl, interrupt, startNext, wideBindings, wideControl } from "./_tree-fixtures.js"
import { runningControl } from "./_machine-semantics-fixtures.js"
import { addressedKeysToRetire, startedAgents } from "../../../../src/workflows/vm/host-commit-controller.js"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import { loadQueueFromEvents } from "../../../../src/workflows/view/view-projection.js"
import { frontendAttempts } from "../../../../src/orchestration/workflow-host/frontend-attempts.js"
import { createWorkflowViewProtocolReader } from "../../../../src/orchestration/modules/workflows/view-protocol.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { addressReachesStartedAgent } from "../../../../src/orchestration/workflow-host/workflow-addressing.js"
import {
  createMemoryStore,
  fixtureSkills,
  initialFacts,
  sequentialWorkflow,
  testHost,
  workflow,
} from "./host-test-support.js"


describe("workflow VM host", () => {
  it("commits attempt start before invoking one bounded worker and publishes only committed progress", async () => {
    const store = createMemoryStore(initialFacts())
    const order: string[] = []
    const runtimeEvents: string[] = []
    const originalAppend = store.appendBatchGuarded
    store.appendBatchGuarded = async (events) => {
      const result = await originalAppend(events)
      if (result.kind === "stored") order.push(...result.events.map(({ type }) => type))
      return result
    }
    const host = testHost(store, {
      attemptRunner: {
        run: async (input) => {
          expect(order).toContain("attempt.started")
          expect(host.hasRunnableWork()).toBe(false)
          order.push("worker")
          return {
            kind: "success",
            attemptId: input.attemptId,
            conversationId: "conversation-1",
            handoff: { summary: "done" },
            reassessment: null,
            toolUses: 3,
          }
        },
      },
      emit: async (event) => { runtimeEvents.push(event.type) },
      now: () => 10,
    })

    expect(host.hasRunnableWork()).toBe(true)
    const result = await host.run()
    expect(host.hasRunnableWork()).toBe(false)

    if (result.kind === "failed") throw new Error(JSON.stringify(result.failure))
    expect(result.kind).toBe("completed")
    expect(order.indexOf("attempt.started")).toBeLessThan(order.indexOf("worker"))
    expect(runtimeEvents).toEqual([
      "workflow.run.initialized",
      "workflow.attempt.started",
      "workflow.attempt.completed",
      "workflow.run.completed",
    ])
    expect(store.events.map(({ type }) => type)).toContain("context.accumulated")
    expect(store.events.find(({ type }) => type === "attempt.succeeded")?.payload.toolUses).toBe(3)
    const restored = loadQueueFromEvents(store.events)!
    expect(frontendAttempts(restored)[0]?.toolUses).toBe(3)
    await store.append({ aggregateId: "workflow:session", sessionId: "session", timestamp: 10, actor: "flywheel", type: "workflow.run.registered", version: 1,
      payload: { settings: { workflowDefinitionId: workflow.id, label: "Fixture", createdAt: new Date(10).toISOString(), lastUpdated: new Date(10).toISOString(), roleAssignments: { defaults: {}, overrides: {} } }, request: "Work", launchedFrom: { parentSessionId: "parent", conversationId: "parent-conversation", toolUseId: "launch" } } })
    expect((await createWorkflowViewProtocolReader(asAsyncEventReadSurface(store))("session"))?.attempts[0]?.toolUses).toBe(3)
  })

  it("durably aborts from the completed wait and resumes with completed plan semantics", async () => {
    const store = createMemoryStore(initialFacts())
    const host = testHost(store, {
      attemptRunner: {
        run: async (input, active) => ({
          kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
          handoff: { summary: "done" }, reassessment: null,
        }),
      },
    })
    expect((await host.run()).kind).toBe("completed")
    expect(await host.abort("close completed wait")).toBe(true)
    expect(store.events.filter(({ type }) => type === "workflow.aborted")).toHaveLength(1)

    const resumed = testHost(store, {
      startMode: "operator_resume",
      preAttemptPolicy: () => { throw new Error("completed work must not check attempt budget") },
      attemptRunner: { run: async () => { throw new Error("completed work reran") } },
    })
    expect((await resumed.run()).kind).toBe("completed")
  })
  it("maps storage failure without publishing speculative attempt state", async () => {
    const store = createMemoryStore(initialFacts())
    const durableCount = store.events.length
    store.appendBatchGuarded = async () => { throw new Error("disk unavailable") }
    let workers = 0
    const runtimeEvents: string[] = []
    const host = testHost(store, {
      attemptRunner: { run: async () => { workers += 1; throw new Error("must not run") } },
      emit: (event) => { runtimeEvents.push(event.type) },
    })

    const result = await host.run()

    expect(result).toMatchObject({ kind: "failed", failure: { kind: "storage", message: "disk unavailable" } })
    expect(store.events).toHaveLength(durableCount)
    expect(workers).toBe(0)
    expect(runtimeEvents).toEqual(["workflow.run.initialized"])
  })

  it("runs pre-attempt policy before start and pauses without invoking the worker", async () => {
    const store = createMemoryStore(initialFacts())
    let invocations = 0
    const host = testHost(store, {
      preAttemptPolicy: () => "Budget exhausted",
      attemptRunner: { run: async () => { invocations += 1; throw new Error("must not run") } },
    })

    const result = await host.run()

    expect(result).toMatchObject({ kind: "paused", reason: "Budget exhausted" })
    expect(invocations).toBe(0)
    expect(store.events.map(({ type }) => type).filter((type) => type === "attempt.started")).toHaveLength(0)
    expect(store.events.map(({ type }) => type)).toContain("workflow.paused")

    const durableCount = store.events.length
    const publications: string[] = []
    let prepared = 0
    let checks = 0
    let refusal: string | null = "Invocation budget exhausted (1/1)"
    const resumed = testHost(store, {
      startMode: "operator_resume",
      preAttemptPolicy: () => { checks += 1; return refusal },
      onPostPreflight: () => { prepared += 1 },
      emit: (event) => { publications.push(event.type) },
      attemptRunner: { run: async () => { invocations += 1; throw new Error("must not run") } },
    })
    for (let action = 0; action < 2; action += 1) {
      expect(await resumed.preflight()).toMatchObject({ kind: "attempt_refused", message: refusal })
      expect(store.events).toHaveLength(durableCount)
      expect(publications).toEqual([])
      expect(prepared).toBe(0)
      expect(invocations).toBe(0)
    }
    refusal = null
    expect(await resumed.preflight()).toBeNull()
    expect(checks).toBe(3)
    expect(prepared).toBe(1)
    expect(publications).toEqual(["workflow.run.initialized"])
  })

  it("returns the committed insertion refusal after successful work, including on reattach", async () => {
    // Only a run from before phases inserts attempts: its `then` chain is
    // the history arm of its agent node.
    const continued = workflow
    const facts = initialFacts(continued).map((event) => {
      const fact = parseWorkflowSessionFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
      if (fact.type !== "workflow.control.initialized") return event
      const { control } = fact.payload
      const nodes = control.graph.nodes.map((node) => node.kind === "agent" ? { ...node, followUpV10: { step: "work", when: null, then: null } } : node)
      return { ...event, payload: { control: { ...control, graph: { ...control.graph, nodes }, guardrails: { ...control.guardrails, maxAttempts: 1 } } } }
    })
    const store = createMemoryStore(facts)
    const published: WorkflowRuntimeEvent[] = []
    const host = testHost(store, {
      workflow: continued,
      emit: (event) => { published.push(event) },
      attemptRunner: {
        run: async (input, active) => ({
          kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
          handoff: { summary: "Source completed" }, reassessment: null,
        }),
      },
    })
    const expected = {
      kind: "failed",
      failure: { kind: "workflow", message: 'Workflow control "then" rejected insert_after: max queue length (1)' },
    }
    expect(await host.run()).toMatchObject(expected)
    expect(published.at(-1)).toEqual({ type: "workflow.run.failed", data: { reason: expected.failure.message, attemptsCompleted: 1 } })
    expect(await testHost(store, { workflow: continued }).run()).toMatchObject(expected)
  })

  it("yields to a queued control input and heartbeat without changing committed fact order", async () => {
    const store = createMemoryStore(initialFacts(sequentialWorkflow))
    const order: string[] = []
    const originalAppend = store.appendBatchGuarded
    store.appendBatchGuarded = async (events) => {
      const result = await originalAppend(events)
      if (result.kind !== "stored") return result
      const terminal = result.events.map((fact) => parseProjectionFact(fact, parseWorkflowSessionFact)).at(-1)
      const event = terminal?.type === "workflow.control.committed" ? terminal.payload.event : null
      if (event?.type === "ATTEMPT_SUCCEEDED" && !order.includes("first-completion")) {
        order.push("first-completion")
        queueMicrotask(() => {
          order.push("heartbeat")
          void host.abort("queued control")
        })
      }
      return result
    }
    const host = testHost(store, {
      workflow: sequentialWorkflow,
      attemptRunner: {
        run: async (input, active) => {
          order.push(`worker:${input.definitionId}`)
          return {
            kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
            handoff: { summary: input.definitionId }, reassessment: null,
          }
        },
      },
    })

    const result = await host.run()
    expect(result).toMatchObject({ kind: "paused", reason: "queued control" })
    expect(order).toEqual(["worker:work", "first-completion", "heartbeat"])
    const controlEvents = store.events
      .map((fact) => parseProjectionFact(fact, parseWorkflowSessionFact))
      .filter((fact) => fact.type === "workflow.control.committed")
      .map(({ payload }) => payload.event.type)
    expect(controlEvents).toEqual(["START", "ATTEMPT_STARTED", "ATTEMPT_SUCCEEDED", "ABORT"])
  })


  it("records each parent message once when two settled attempts read one conversation", async () => {
    const retried = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({ ...workflow, phases: workflow.phases.map((phase) => ({ ...phase, retry: { max: 2, stuck: true } })) })
    const store = createMemoryStore(initialFacts(retried))
    const first = { key: "msg:parent:call-1", source: { kind: "parent" as const, name: "Planner" }, text: "Also cover Windows." }
    const second = { key: "msg:parent:call-2", source: { kind: "parent" as const, name: "Planner" }, text: "Skip the docs." }
    const reads: { readonly attemptId: string; readonly conversationId: string }[] = []
    const host = testHost(store, {
      workflow: retried,
      // The retry reads the same conversation again, so the first message
      // comes back beside the new one.
      requestAddenda: async (attempt) => { reads.push(attempt); return reads.length === 1 ? [first] : [first, second, second] },
      attemptRunner: {
        run: async (input, active) => input.iteration === 1
          ? { kind: "missing_handoff", attemptId: input.attemptId, conversationId: active.conversationId, reason: "no handoff", toolUses: 2 }
          : { kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "done" }, reassessment: null, toolUses: 4 },
      },
    })
    expect((await host.run()).kind).toBe("completed")

    expect(reads.map(({ conversationId }) => conversationId)).toEqual(["conversation-1", "conversation-1"])
    expect(new Set(reads.map(({ attemptId }) => attemptId)).size).toBe(2)
    const added = store.events
      .map((fact) => parseProjectionFact(fact, parseWorkflowSessionFact))
      .flatMap((fact) => fact.type === "step_context.input.added" ? [fact.payload.key] : [])
    expect(added).toEqual(["msg:parent:call-1", "msg:parent:call-2"])
    expect(loadQueueFromEvents(store.events)?.attempts.map(({ toolUses }) => toolUses)).toEqual([2, 4])
  })

  it("records a held addressed message in the first commit, from its address only, and retires its cell after the commit", async () => {
    const store = createMemoryStore(initialFacts())
    const addressed = { key: "msg:parent:call-1", source: { kind: "parent" as const, name: "Planner" }, text: "Keep the old flag names.", addressedTo: [{ _tag: "agent" as const, nodeId: "node-1", definitionId: "work" }] as const }
    let held = [addressed]
    const retired: string[][] = []
    const host = testHost(store, {
      addressedMessages: { read: async () => held, retire: async (keys) => { retired.push([...keys]); held = held.filter(({ key }) => !keys.includes(key)) } },
      // The running step also read the message live, so its reading names
      // the same key.
      requestAddenda: async () => [{ key: addressed.key, source: addressed.source, text: addressed.text }],
      attemptRunner: {
        run: async (input, active) => ({ kind: "success", attemptId: input.attemptId, conversationId: active.conversationId, handoff: { summary: "done" }, reassessment: null }),
      },
    })
    expect((await host.run()).kind).toBe("completed")
    const facts = store.events.map((fact) => parseProjectionFact(fact, parseWorkflowSessionFact))
    const added = facts.flatMap((fact) => fact.type === "step_context.input.added" ? [{ version: fact.version, key: fact.payload.key }] : [])
    expect(added).toEqual([{ version: 4, key: "msg:parent:call-1" }])
    const firstControl = facts.findIndex((fact) => fact.type === "workflow.control.committed")
    expect(facts.findIndex((fact) => fact.type === "step_context.input.added")).toBeLessThan(firstControl)
    expect(retired).toEqual([["msg:parent:call-1"]])
  })

  it("keeps the cell of a message for the step that runs or waits in the same attempt across a commit, and retires every other cell once recorded", () => {
    const group = "input-mapped:node:1"
    const forLane = (key: string, ordinal: number) => ({ key, source: { kind: "person" as const }, text: "Keep the old flag names.", addressedTo: [{ _tag: "item" as const, listNodeId: group, itemNodeId: `${group}:item:${ordinal}`, key: `t${ordinal}` }] as const })
    const messages = [forLane("for-t2", 2), forLane("for-t3", 3)]
    const running = flattenWorkflowView(fourLaneControl(), wideBindings)
    // Lane t2 runs before and after, so its step reads the message in its
    // conversation; lane t3 reads the record when its first step starts.
    expect(addressedKeysToRetire(messages, running, running)).toEqual(["for-t3"])
    // An interrupt parks the same attempt, which a later run resumes.
    expect(addressedKeysToRetire(messages, running, flattenWorkflowView(interrupt(fourLaneControl()), wideBindings))).toEqual(["for-t3"])
    // A commit that starts the step builds its prompt from the record.
    expect(addressedKeysToRetire(messages, flattenWorkflowView(wideControl(4), wideBindings), running)).toEqual(["for-t2", "for-t3"])
  })

  it("delivers whole-workflow and logical step messages to a flat follow-up and keeps their cells while the attempt continues", () => {
    // Only a run from before phases runs a follow-up as a second attempt of
    // its node: the `then` chain is the history arm of its agent node.
    const bindings = resolveWorkflowAgents(sequentialWorkflow)
    const compiled = compileWorkflowControl(sequentialWorkflow, bindings, { skills: fixtureSkills })
    const [work] = compiled.graph.nodes
    if (work?.kind !== "agent") throw new Error("The sequential workflow starts with an agent")
    const continued = {
      ...compiled,
      graph: { ...compiled.graph, nodes: [{ ...work, followUpV10: { step: "review", when: null, then: null } }], dependencies: [] },
      attempts: compiled.attempts.filter(({ logicalNodeId }) => logicalNodeId === work.id),
      guardrails: { ...compiled.guardrails, attemptMutationsUsed: compiled.guardrails.attemptMutationsUsed.filter(({ attemptId }) => attemptId.startsWith(`${work.id}:`)) },
    }
    const afterWork = drive(continued, () => ({ handoff: { summary: "done" } }), (control) => control.attempts.length === 2)
    const control = startNext(afterWork)
    const running = flattenWorkflowView(control, bindings)
    const owner = "host-sequential:node:1"
    expect(startedAgents(running)).toMatchObject([{ agent: { nodeId: owner }, attemptId: control.attempts[1]!.id }])
    const message = { key: "answer", source: { kind: "parent" as const, name: "Chat" }, text: "Accept the recommendation.", addressedTo: [{ _tag: "workflow" }] as const }
    const targeted = { ...message, key: "targeted", addressedTo: [{ _tag: "agent" as const, nodeId: owner, definitionId: "work" }] as const }
    expect(addressReachesStartedAgent(running, { addressedTo: message.addressedTo, label: "the workflow" })).toBe(true)
    expect(addressReachesStartedAgent(running, { addressedTo: targeted.addressedTo, label: "agent work" })).toBe(true)
    expect(addressedKeysToRetire([message, targeted], running, running)).toEqual([])
    expect(addressedKeysToRetire([message, targeted], running, flattenWorkflowView(interrupt(control), bindings))).toEqual([])
    const settled = flattenWorkflowView(drive(afterWork, () => ({ handoff: { summary: "reviewed" } })), bindings)
    expect(addressedKeysToRetire([message, targeted], running, settled)).toEqual(["answer", "targeted"])
  })

  it("composes sequential attempt companions from caught-up queue and context", async () => {
    const store = createMemoryStore(initialFacts(sequentialWorkflow))
    const host = testHost(store, {
      workflow: sequentialWorkflow,
      conversationId: (input) => `conversation-${input?.definitionId}`,
      attemptRunner: {
        run: async (input, active) => ({
          kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
          handoff: { summary: input.definitionId }, reassessment: null,
        }),
      },
    })

    const result = await host.run()
    expect(result.kind).toBe("completed")
    expect(result.view?.attempts.map(({ definitionId, status }) => ({ definitionId, status }))).toEqual([
      { definitionId: "work", status: "completed" },
      { definitionId: "review", status: "completed" },
    ])
    const contextDefinitions = store.events
      .map((fact) => parseProjectionFact(fact, parseWorkflowSessionFact))
      .filter((fact) => fact.type === "context.accumulated")
      .map(({ payload }) => payload.entry.definitionId)
    expect(contextDefinitions).toEqual(["work", "review"])
  })

})

describe("workflow runtime publisher", () => {
  it("names the rosters of maps with no items when the run completes, so the live transcript places them as the history does", async () => {
    const emitted: WorkflowRuntimeEvent[] = []
    const control = drive(wideControl(0), () => ({ handoff: { summary: "done" } }))
    const completed = flattenWorkflowView(control, wideBindings)
    const publisher = createWorkflowRuntimePublisher({ emit: (event) => { emitted.push(event) }, queue: async () => completed, setPauseReason: () => {} })
    const fact: StoredFact = { ...buildWorkflowCompletedFact(), aggregateId: "workflow:run", sessionId: "run", timestamp: 1, position: 1, id: "fact-1", seq: 1 }
    await publisher.publishCommittedBatch([fact], control)
    expect(emitted).toEqual([{ type: "workflow.run.completed", data: { attemptsCompleted: 1 } }])
  })

  it("names the failed agent and its reason when a later commit of other work fails the run", async () => {
    const emitted: WorkflowRuntimeEvent[] = []
    const base = runningControl()
    const failed = {
      ...base,
      graph: { ...base.graph, nodes: base.graph.nodes.map((node) => ({ ...node, state: { _tag: "failed", reason: "unauthorized" } as const })) },
      attempts: base.attempts.map((attempt) => ({ ...attempt, state: { _tag: "failed", reason: "unauthorized" } as const })),
      status: "failed" as const,
    }
    const publisher = createWorkflowRuntimePublisher({ emit: (event) => { emitted.push(event) }, queue: async () => ({ attempts: [], tree: { nodes: [] }, cursor: 0, status: "failed", mutationLog: [] }), setPauseReason: () => {} })
    const fact: StoredFact = { ...buildWorkflowFailedFact(), aggregateId: "workflow:run", sessionId: "run", timestamp: 1, position: 1, id: "fact-1", seq: 1 }
    await publisher.publishCommittedBatch([fact], failed)
    expect(emitted).toEqual([{ type: "workflow.run.failed", data: { reason: 'Agent "Work" failed: unauthorized', attemptsCompleted: 0 } }])
  })
})
