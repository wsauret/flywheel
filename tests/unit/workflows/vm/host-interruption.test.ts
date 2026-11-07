import { afterEach, describe, expect, it } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import { createEmit, EventBus } from "../../../../src/infra/event-bus.js"
import { EventReaderService, EventStoreWriterLaneService, EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { createEventStoreWriterLane } from "../../../../src/infra/event-store-writer-lane.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter, type AsyncGuardedEventWriter, type GuardedEventStoreAppend } from "../../../../src/infra/event-store-types.js"
import { wireSessionSubscribers } from "../../../../src/orchestration/session/create-session-infra.js"
import { createSessionFactWriter, type SessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { acquireSessionResources } from "../../../../src/orchestration/session/session-resources-service.js"
import { composeWorkflowHostLifecycle } from "../../../../src/orchestration/workflow-host/lifecycle.js"
import { createWorkflowContextStore } from "../../../../src/workflows/context-bundle/context-store.js"
import { createContextAccumulator } from "../../../../src/workflows/context-bundle/context.js"
import { createWorkflowViewStore } from "../../../../src/workflows/view/view-store.js"
import { createAttemptExecutor, type AttemptRunOutcome } from "../../../../src/workflows/vm/attempt-runner.js"
import { createWorkflowVmHost } from "../../../../src/workflows/vm/host.js"
import type { WorkflowVmHostDeps, WorkflowVmStartMode } from "../../../../src/workflows/vm/host-types.js"
import { SqliteVmDriver } from "./_sqlite-vm-driver.js"
import { EVERY_CAPABILITY } from "../../../helpers/attempt-brief.js"

const drivers: SqliteVmDriver[] = []

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

function proposalType(events: readonly GuardedEventStoreAppend[]): string | null {
  const terminal = events.at(-1)
  if (terminal?.type !== "workflow.control.committed" || !("event" in terminal.payload)) return null
  const event = terminal.payload.event
  return typeof event === "object" && event !== null && "type" in event && typeof event.type === "string" ? event.type : null
}

function success(input: Parameters<WorkflowVmHostDeps["attemptRunner"]["run"]>[0], conversationId: string): AttemptRunOutcome {
  return {
    kind: "success",
    attemptId: input.attemptId,
    conversationId,
    handoff: { summary: `${input.definitionId} completed` },
    reassessment: null,
  }
}

function host(
  vm: SqliteVmDriver,
  startMode: WorkflowVmStartMode,
  writer: AsyncEventWriter,
  run: WorkflowVmHostDeps["attemptRunner"]["run"],
  conversationId = "conversation-durable",
) {
  const reader = asAsyncEventReadSurface(vm.store)
  return createWorkflowVmHost({
    servedConversations: async () => new Set(),
    requestAddenda: async () => [],
    startMode,
    sessionId: vm.sessionId,
    reader,
    writer,
    queueStore: createWorkflowViewStore({ sessionId: vm.sessionId, reader }),
    contextStore: createWorkflowContextStore({ sessionId: vm.sessionId, reader }),
    definitionRevision: vm.definitionRevision,
    workflow: vm.workflow,
    conversationId: () => conversationId,
    attemptRunner: { run },
    emit: () => {},
    now: () => 100,
  })
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30 && !predicate(); attempt += 1) await Bun.sleep(1)
  if (!predicate()) throw new Error("Condition was not reached")
}

function assertTerminalBatches(batches: readonly (readonly GuardedEventStoreAppend[])[]): void {
  expect(batches.length).toBeGreaterThan(0)
  expect(batches.every((batch) => batch.at(-1)?.type === "workflow.control.committed")).toBe(true)
}

describe("workflow VM host SQLite interruption", () => {
  it("before ATTEMPT_STARTED commit leaves no start fact and replays pending work", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    const base = asAsyncEventWriter(vm.store)
    const batches: GuardedEventStoreAppend[][] = []
    const writer: AsyncGuardedEventWriter = {
      ...base,
      appendBatchGuarded: async (events) => {
        batches.push([...events])
        if (proposalType(events) === "ATTEMPT_STARTED") throw new Error("interrupted before attempt start")
        return base.appendBatchGuarded(events)
      },
    }
    let workers = 0
    const interrupted = await host(vm, "launch", writer, async () => {
      workers += 1
      throw new Error("uncommitted start ran")
    }).run()

    expect(interrupted).toMatchObject({ kind: "failed", failure: { kind: "storage" } })
    expect(workers).toBe(0)
    expect(vm.events().filter(({ type }) => type === "attempt.started")).toHaveLength(0)
    expect(vm.queue()?.attempts[0]).toMatchObject({ status: "pending" })
    expect(batches.map(proposalType)).toEqual(["START", "ATTEMPT_STARTED"])

    const recoveredCalls: string[] = []
    const recovered = await host(vm, "operator_resume", base, async (input, active) => {
      recoveredCalls.push(input.definitionId)
      return success(input, active.conversationId)
    }).run()
    if (recovered.kind === "failed") throw new Error(JSON.stringify(recovered.failure))
    expect(recovered.kind).toBe("completed")
    expect(recoveredCalls).toEqual(["work", "review"])
    expect(vm.events().filter(({ type }) => type === "attempt.started")).toHaveLength(2)
    expect(vm.queue()?.status).toBe("completed")
  })

  it("after ATTEMPT_STARTED commit recovers with the committed conversation identity", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    const base = asAsyncEventWriter(vm.store)
    let firstStarted = false
    let firstInvocations = 0
    const first = host(vm, "launch", base, async (_input, { signal }) => {
      firstInvocations += 1
      firstStarted = true
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
      })
      throw new Error("unreachable")
    })
    const interruptedRun = first.run()
    await waitFor(() => firstStarted)

    expect(firstInvocations).toBe(1)
    expect(vm.events().filter(({ type }) => type === "attempt.started")).toHaveLength(1)
    expect(vm.queue()?.attempts[0]).toMatchObject({ status: "running", lastConversationId: "conversation-durable" })
    expect(await first.dispose()).toEqual({ kind: "disposed" })
    expect((await interruptedRun).kind).toBe("failed")

    const recoveryIds: string[] = []
    const recoveryDefinitions: string[] = []
    const recovered = await host(vm, "operator_resume", base, async (input, active) => {
      recoveryIds.push(active.conversationId)
      recoveryDefinitions.push(input.definitionId)
      return success(input, active.conversationId)
    }).run()
    expect(recovered.kind).toBe("completed")
    expect(recoveryIds[0]).toBe("conversation-durable")
    expect(recoveryDefinitions).toEqual(["work", "review"])
    expect(vm.events().filter(({ type }) => type === "attempt.resume_recovered")).toHaveLength(1)
  })

  it("before completion commit records no outcome and RECOVER reuses the committed start identity", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    const base = asAsyncEventWriter(vm.store)
    const batches: GuardedEventStoreAppend[][] = []
    const writer: AsyncGuardedEventWriter = {
      ...base,
      appendBatchGuarded: async (events) => {
        batches.push([...events])
        if (proposalType(events) === "ATTEMPT_SUCCEEDED") throw new Error("interrupted before completion")
        return base.appendBatchGuarded(events)
      },
    }
    let firstInvocations = 0
    const first = await host(vm, "launch", writer, async (input, active) => {
      firstInvocations += 1
      return success(input, active.conversationId)
    }).run()

    expect(first).toMatchObject({ kind: "failed", failure: { kind: "storage" } })
    expect(firstInvocations).toBe(1)
    expect(vm.events().filter(({ type }) => type === "attempt.succeeded")).toHaveLength(0)
    expect(vm.events().filter(({ type }) => type === "handoff.written")).toHaveLength(0)
    expect(vm.queue()?.attempts[0]).toMatchObject({ status: "running", lastConversationId: "conversation-durable" })
    expect(batches.map(proposalType)).toEqual(["START", "ATTEMPT_STARTED", "ATTEMPT_SUCCEEDED"])

    const recovery: Array<{ definitionId: string; conversationId: string }> = []
    const recovered = await host(vm, "operator_resume", base, async (input, active) => {
      recovery.push({ definitionId: input.definitionId, conversationId: active.conversationId })
      return success(input, active.conversationId)
    }).run()
    expect(recovered.kind).toBe("completed")
    expect(recovery.map(({ definitionId }) => definitionId)).toEqual(["work", "review"])
    expect(recovery[0]?.conversationId).toBe("conversation-durable")
    expect(vm.events().filter(({ type }) => type === "attempt.resume_recovered")).toHaveLength(1)
  })

  it("after completion commit replays outcome companions without rerunning committed conversation work", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    const base = asAsyncEventWriter(vm.store)
    const batches: GuardedEventStoreAppend[][] = []
    const writer: AsyncGuardedEventWriter = {
      ...base,
      appendBatchGuarded: async (events) => {
        const stored = await base.appendBatchGuarded(events)
        batches.push([...events])
        if (proposalType(events) === "ATTEMPT_SUCCEEDED") throw new Error("interrupted after completion")
        return stored
      },
    }
    let workInvocations = 0
    const first = await host(vm, "launch", writer, async (input, active) => {
      workInvocations += 1
      return success(input, active.conversationId)
    }).run()

    expect(first).toMatchObject({ kind: "failed", failure: { kind: "storage" } })
    expect(workInvocations).toBe(1)
    expect(vm.events().filter(({ type }) => type === "attempt.succeeded")).toHaveLength(1)
    expect(vm.events().filter(({ type }) => type === "handoff.written")).toHaveLength(1)
    expect(vm.events().filter(({ type }) => type === "context.accumulated")).toHaveLength(1)
    expect(vm.queue()?.attempts.map(({ definitionId, status }) => ({ definitionId, status }))).toEqual([
      { definitionId: "work", status: "completed" },
      { definitionId: "review", status: "pending" },
    ])
    assertTerminalBatches(batches)

    const recoveredCalls: string[] = []
    const recovered = await host(vm, "operator_resume", base, async (input, active) => {
      recoveredCalls.push(input.definitionId)
      return success(input, active.conversationId)
    }).run()
    expect(recovered.kind).toBe("completed")
    expect(recoveredCalls).toEqual(["review"])
    expect(vm.events().filter(({ type }) => type === "attempt.succeeded")).toHaveLength(2)
    expect(vm.events().filter(({ type }) => type === "handoff.written")).toHaveLength(2)
    expect(vm.events().filter(({ type }) => type === "context.accumulated")).toHaveLength(2)
    expect(vm.queue()?.status).toBe("completed")
  })

  it("recovers only the pending retry and gives it a fresh committed identity", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    await vm.startAttempt("after", "conversation-failed-ancestor")
    await vm.failHandoff()
    const before = vm.freshViews().control
    const failed = before.attempts.find(({ state }) => state._tag === "failed")
    const retry = before.attempts.find(({ state }) => state._tag === "pending")
    if (!failed || !retry) throw new Error("Retry fixture did not produce failed and pending attempts")

    const calls: Array<{ attemptId: string; conversationId: string }> = []
    const recovered = await host(
      vm,
      "operator_resume",
      asAsyncEventWriter(vm.store),
      async (input, active) => {
        calls.push({ attemptId: input.attemptId, conversationId: active.conversationId })
        return success(input, active.conversationId)
      },
      "conversation-retry-fresh",
    ).run()

    expect(recovered.kind).toBe("completed")
    expect(calls[0]).toEqual({ attemptId: retry.id, conversationId: "conversation-retry-fresh" })
    expect(calls.some(({ attemptId }) => attemptId === failed.id)).toBe(false)
    expect(vm.freshViews().control.attempts.find(({ id }) => id === failed.id)).toMatchObject({
      state: { _tag: "failed" },
      conversationId: "conversation-failed-ancestor",
    })
  })

  it("holds every host finalizer until the real worker promise settles", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    const context = createContextAccumulator()
    context.seedInput({ workflowDefinitionId: vm.workflow.id, userRequest: "SQLite VM acceptance", timestamp: 1 })
    const order: string[] = []
    let workerStarted = false
    let releaseWorker: (() => void) | undefined
    const unwinding = new Promise<void>((resolve) => { releaseWorker = resolve })
    const attemptRunner = createAttemptExecutor({
      unavailableToolReason: (term) => `${term} is off`,
      earlierCheckpoint: async () => null,
      resolvedAgents: vm.bindings,
      context: { getContext: async () => context.getContext() },
      skills: vm.skills,
      recordInvocation: async () => {},
      worker: async (_step, brief, signal) => {
        await brief(EVERY_CAPABILITY)
        workerStarted = true
        await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }) })
        await unwinding
        order.push("worker")
        throw new DOMException("Aborted", "AbortError")
      },
    })
    const settlementHost = createWorkflowVmHost({
      servedConversations: async () => new Set(),
      requestAddenda: async () => [],
      startMode: "launch",
      sessionId: vm.sessionId,
      reader: asAsyncEventReadSurface(vm.store),
      writer: asAsyncEventWriter(vm.store),
      ...vm.workflowStores(),
      definitionRevision: vm.definitionRevision,
      workflow: vm.workflow,
      conversationId: () => "conversation-settlement",
      attemptRunner,
      emit: () => {},
      now: () => 100,
      lifecycle: {
        flushConversation: () => { order.push("conversation") },
        drainWriter: () => { order.push("writer") },
        disposeProjections: () => { order.push("projections") },
      },
    })

    const running = settlementHost.run()
    await waitFor(() => workerStarted)
    const disposing = settlementHost.dispose()
    await Bun.sleep(5)
    expect(order).toEqual([])

    releaseWorker?.()
    expect(await disposing).toEqual({ kind: "disposed" })
    await running
    expect(order).toEqual(["worker", "conversation", "writer", "projections"])
  })

  it("commits abort responsively and disposes production resources only after the held worker settles", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    const bus = new EventBus()
    const emit = createEmit(bus)
    // One record-order timeline: every session fact, the worker's own settlement
    // marker, and each host disposal step. The writer lane makes durability later
    // than the call, so record() order is the only observation point that can
    // tell "finalize ran" apart from "finalize drained".
    const timeline: string[] = []
    bus.subscribeToType("workflow.attempt.interrupted", () => { timeline.push("workflow.attempt.interrupted") }, { delivery: "direct", deliveryClass: "durable" })
    const disposalSteps = ["worker", "conversation", "adapters", "remaining"]
    const resourceScope = Scope.makeUnsafe("sequential")
    // This driver's store is the synchronous tooling shape, so the lane the
    // session resources write through is created over it here. The runtime
    // store carries its own.
    const writerLane = createEventStoreWriterLane(vm.store)
    const resources = await Effect.runPromise(Effect.provideService(
      Effect.provideService(
        Effect.provideService(
          Scope.provide(resourceScope)(acquireSessionResources({
            sessionId: vm.sessionId,
            projectRoot: vm.root,
            emitter: emit,
            eventBus: bus,
            projectionReader: asAsyncEventReadSurface(vm.store),
            factories: {
              createSessionFactWriter: (deps) => recordFacts(createSessionFactWriter(deps), timeline),
            },
          })),
          EventReaderService,
          asAsyncEventReadSurface(vm.store),
        ),
        EventStoreWriterService,
        asAsyncEventWriter(vm.store),
      ),
      EventStoreWriterLaneService,
      writerLane,
    ))

    let workerStarted = false
    let releaseWorker: (() => void) | undefined
    const unwinding = new Promise<void>((resolve) => { releaseWorker = resolve })
    const attemptRunner = createAttemptExecutor({
      unavailableToolReason: (term) => `${term} is off`,
      earlierCheckpoint: async () => null,
      resolvedAgents: vm.bindings,
      context: resources.contextStore,
      skills: vm.skills,
      recordInvocation: async () => {},
      worker: async (_step, brief, signal) => {
        await brief(EVERY_CAPABILITY)
        emit("agent.run.started", { sessionId: vm.sessionId, data: { stepIndex: 0 } })
        workerStarted = true
        await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }) })
        await unwinding
        timeline.push("worker")
        throw new DOMException("Aborted", "AbortError")
      },
    })
    const productionHost = createWorkflowVmHost({
      servedConversations: async () => new Set(),
      requestAddenda: async () => [],
      startMode: "launch",
      sessionId: vm.sessionId,
      reader: asAsyncEventReadSurface(vm.store),
      writer: asAsyncEventWriter(vm.store),
      queueStore: resources.queueStore,
      contextStore: resources.contextStore,
      definitionRevision: vm.definitionRevision,
      workflow: vm.workflow,
      conversationId: () => "conversation-held",
      attemptRunner,
      emit: (event) => { emit(event.type, { sessionId: vm.sessionId, data: event.data }) },
      now: () => 100,
      onPostPreflight: () => { wireSessionSubscribers(bus, resources) },
      lifecycle: composeWorkflowHostLifecycle(resources.lifecycle, {
        flushConversation: () => { timeline.push("conversation") },
        disposeAdapters: () => { timeline.push("adapters") },
        disposeRemaining: async () => {
          timeline.push("remaining")
          await Effect.runPromise(Scope.close(resourceScope, Exit.fail(new Error("workflow aborted"))))
        },
      }),
    })

    const running = productionHost.run()
    await waitFor(() => workerStarted)
    expect(await productionHost.abort("Workflow aborted by operator")).toBe(true)
    expect((await running).kind).toBe("paused")
    expect(vm.events().map(({ type }) => type)).toContain("workflow.aborted")
    expect(timeline.filter((entry) => disposalSteps.includes(entry))).toEqual([])

    const disposing = productionHost.dispose()
    await Bun.sleep(5)
    expect(timeline.filter((entry) => disposalSteps.includes(entry))).toEqual([])

    releaseWorker?.()
    expect(await disposing).toEqual({ kind: "disposed" })
    expect(timeline.filter((entry) => disposalSteps.includes(entry))).toEqual(disposalSteps)
    // Explicit interruption records the step interruption only after the held
    // worker settles.
    const settled = timeline.indexOf("worker")
    expect(settled).toBeGreaterThan(0)
    expect(timeline.indexOf("workflow.attempt.interrupted")).toBeGreaterThan(settled)
  })
})

/** Session fact tap: appends every recorded fact to the timeline as a compact
 *  descriptor, so a test reads record-order without waiting for a lane drain. */
function recordFacts(writer: SessionFactWriter, timeline: string[]): SessionFactWriter {
  return {
    ...writer,
    record: (fact) => {
      timeline.push(describeFact(fact))
      return writer.record(fact)
    },
  }
}

function describeFact(fact: Parameters<SessionFactWriter["record"]>[0]): string {
  return fact.type
}