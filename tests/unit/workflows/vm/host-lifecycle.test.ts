import { describe, expect, it, spyOn } from "bun:test"
import {
  createMemoryStore,
  initialFacts,
  testHost,
  waitFor,
  workflow,
} from "./host-test-support.js"
import { WorkflowHostLifecycleError } from "../../../../src/workflows/vm/host-types.js"
import * as factFold from "../../../../src/workflows/vm/fact-fold.js"
import { parseWorkflowControlFact } from "../../../../src/workflows/vm/session-facts.js"
import type { StoredFact } from "../../../../src/infra/event-store-types.js"

/** The machine event type of each committed control proposal, in commit order. */
function committedEventTypes(events: readonly StoredFact[]): string[] {
  return events.flatMap(({ type, version, actor, payload }) => {
    if (type !== "workflow.control.committed") return []
    const fact = parseWorkflowControlFact({ type, version, actor, payload })
    return fact.type === "workflow.control.committed" ? [fact.payload.event.type] : []
  })
}

describe("workflow VM host lifecycle and preflight", () => {
  it("resumes an attempt the runtime's teardown cut inside the same conversation: a step never restarts", async () => {
    const store = createMemoryStore(initialFacts())
    let firstConversation: string | undefined
    const host = testHost(store, {
      attemptRunner: {
        run: async (_input, { signal, conversationId }) => {
          firstConversation = conversationId
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
          })
          throw new Error("unreachable")
        },
      },
    })
    const running = host.run()
    await waitFor(() => firstConversation !== undefined)
    expect(await host.abort("Runtime teardown")).toBe(true)
    expect(await running).toMatchObject({ kind: "paused" })

    let resumedConversation: string | undefined
    const resumed = testHost(store, {
      startMode: "operator_resume",
      attemptRunner: {
        run: async (input, active) => {
          resumedConversation = active.conversationId
          return {
            kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
            handoff: { summary: "resumed" }, reassessment: null,
          }
        },
      },
    })
    expect((await resumed.run()).kind).toBe("completed")
    expect(resumedConversation).toBe(firstConversation)
  })

  it("commits one abort without a failed outcome and settles the worker", async () => {
    const store = createMemoryStore(initialFacts())
    const order: string[] = []
    let started = false
    const host = testHost(store, {
      attemptRunner: {
        run: async (_input, { signal }) => {
          started = true
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
          }).finally(() => { order.push("worker-finally") })
          throw new Error("unreachable")
        },
      },
    })

    const running = host.run()
    await waitFor(() => started)
    const aborting = host.abort("Operator abort")
    await Promise.resolve()
    expect(await host.abort("duplicate")).toBe(false)
    expect(await aborting).toBe(true)
    const result = await running

    expect(result).toMatchObject({ kind: "paused", reason: "Operator abort" })
    expect(order).toEqual(["worker-finally"])
    const types = store.events.map(({ type }) => type)
    expect(types.filter((type) => type === "workflow.aborted")).toHaveLength(1)
    expect(types).not.toContain("attempt.reverted")
    expect(result.view?.status).toBe("paused")
    expect(result.view?.attempts.map(({ status }) => status)).toEqual(["pending"])
    const committedEvents = committedEventTypes(store.events)
    expect(committedEvents).toEqual(["START", "ATTEMPT_STARTED", "ABORT"])

    const resumed = testHost(store, {
      startMode: "operator_resume",
      attemptRunner: {
        run: async (input, active) => ({
          kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
          handoff: { summary: "resumed" }, reassessment: null,
        }),
      },
    })
    expect((await resumed.run()).kind).toBe("completed")
  })

  it("commits an accepted abort before host disposal starts finalizers", async () => {
    const store = createMemoryStore(initialFacts())
    const order: string[] = []
    let started = false
    const host = testHost(store, {
      attemptRunner: {
        run: async (_input, { signal }) => {
          started = true
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
          })
          throw new Error("unreachable")
        },
      },
      lifecycle: { flushConversation: () => { order.push("dispose") } },
      emit: (event) => {
        if (event.type === "workflow.run.paused") order.push("abort-published")
      },
    })

    const running = host.run()
    await waitFor(() => started)
    const aborting = host.abort("Operator close")
    const disposing = host.dispose()
    expect(await aborting).toBe(true)
    expect((await running).kind).toBe("paused")
    expect(await disposing).toEqual({ kind: "disposed" })
    expect(order).toEqual(["abort-published", "dispose"])
    expect(store.events.map(({ type }) => type)).toContain("workflow.aborted")
  })

  it("commits an accepted abort while a held worker promise stays unsettled", async () => {
    const store = createMemoryStore(initialFacts())
    const order: string[] = []
    let started = false
    let releaseWorker: (() => void) | undefined
    const held = new Promise<void>((resolve) => { releaseWorker = resolve })
    const host = testHost(store, {
      attemptRunner: {
        run: async (_input, { signal }) => {
          started = true
          await new Promise<void>((resolve) => { signal.addEventListener("abort", () => resolve(), { once: true }) })
          await held
          order.push("worker")
          throw new DOMException("Aborted", "AbortError")
        },
      },
      lifecycle: { flushConversation: () => { order.push("conversation") } },
    })

    const running = host.run()
    await waitFor(() => started)
    const aborting = host.abort("Operator abort")

    expect(await aborting).toBe(true)
    expect((await running).kind).toBe("paused")
    expect(store.events.map(({ type }) => type)).toContain("workflow.aborted")
    expect(order).toEqual([])

    const disposing = host.dispose()
    await Bun.sleep(5)
    expect(order).toEqual([])

    releaseWorker?.()
    expect(await disposing).toEqual({ kind: "disposed" })
    expect(order).toEqual(["worker", "conversation"])
  })

  it("preserves runtime publication operation through abort", async () => {
    const store = createMemoryStore(initialFacts())
    let started = false
    const host = testHost(store, {
      attemptRunner: {
        run: async (_input, { signal }) => {
          started = true
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
          })
          throw new Error("unreachable")
        },
      },
      emit: (event) => {
        if (event.type === "workflow.run.paused") throw new Error("UI unavailable")
      },
    })

    const running = host.run()
    await waitFor(() => started)
    try {
      await host.abort("Operator abort")
      throw new Error("Abort unexpectedly succeeded")
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowHostLifecycleError)
      expect(error).toMatchObject({ operation: "runtime_event", message: "UI unavailable" })
    }
    expect(await running).toMatchObject({
      kind: "failed",
      failure: { kind: "lifecycle", operation: "runtime_event", message: "UI unavailable" },
    })
  })

  it("rejects definition drift before post-preflight and worker acquisition", async () => {
    const store = createMemoryStore(initialFacts())
    let preflight = 0
    let workers = 0
    const host = testHost(store, {
      workflow: { ...workflow, phases: [...workflow.phases, { phase: "again", runs: "work", writes: [] }] },
      onPostPreflight: () => { preflight += 1 },
      attemptRunner: { run: async () => { workers += 1; throw new Error("must not run") } },
    })

    const result = await host.run()

    expect(result).toMatchObject({ kind: "failed", failure: { kind: "definition_drift", workflowId: "host-test" } })
    expect(preflight).toBe(0)
    expect(workers).toBe(0)
  })

  it("rejects malformed workflow facts before post-preflight and worker acquisition", async () => {
    const store = createMemoryStore(initialFacts())
    const first = store.events[0]
    if (!first) throw new Error("Malformed fixture has no fact")
    let preflight = 0
    let workers = 0
    const host = testHost(store, {
      onPostPreflight: () => { preflight += 1 },
      attemptRunner: { run: async () => { workers += 1; throw new Error("must not run") } },
    })
    store.events[0] = { ...first, payload: {} }
    const result = await host.run()

    expect(result).toMatchObject({ kind: "failed", failure: { kind: "malformed_state", sessionId: "session" } })
    expect(preflight).toBe(0)
    expect(workers).toBe(0)
  })

  it("reuses the operator resume replay for preflight", async () => {
    const store = createMemoryStore(initialFacts())
    await testHost(store, {
      preAttemptPolicy: () => "prepare paused fixture",
      attemptRunner: { run: async () => { throw new Error("paused fixture ran") } },
    }).run()
    const replay = spyOn(factFold, "replayWorkflowControl")
    replay.mockClear()

    try {
      const host = testHost(store, {
        startMode: "operator_resume",
        preAttemptPolicy: () => "remain paused",
        attemptRunner: { run: async () => { throw new Error("resumed fixture ran") } },
      })

      expect(await host.run()).toMatchObject({ kind: "failed", failure: { kind: "attempt_refused", message: "remain paused" } })
      expect(replay).toHaveBeenCalledTimes(1)
    } finally {
      replay.mockRestore()
    }
  })

  for (const [label, mode, intent] of [["launch", "launch", "START"], ["resume of a paused run", "operator_resume", "RESUME"], ["resume of a crashed run", "operator_resume", "RECOVER"]] as const) {
    it(`${label} invokes its replay intent once across repeated runs`, async () => {
      const store = createMemoryStore(initialFacts())
      if (intent === "RESUME") {
        await testHost(store, {
          preAttemptPolicy: () => "prepare paused fixture",
          attemptRunner: { run: async () => { throw new Error("paused fixture ran") } },
        }).run()
      } else if (intent === "RECOVER") {
        let started = false
        const interrupted = testHost(store, {
          attemptRunner: {
            run: async (_input, { signal }) => {
              started = true
              await new Promise<void>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true })
              })
              throw new Error("unreachable")
            },
          },
        })
        const running = interrupted.run()
        await waitFor(() => started)
        await interrupted.dispose()
        await running
      }
      const host = testHost(store, {
        startMode: mode,
        attemptRunner: {
          run: async (input, active) => ({
            kind: "success", attemptId: input.attemptId, conversationId: active.conversationId,
            handoff: { summary: "done" }, reassessment: null,
          }),
        },
      })

      await host.run()
      await host.run()
      const intents = committedEventTypes(store.events)
        .filter((type) => type === intent)
      expect(intents).toEqual([intent])
    })
  }

  it("runs every disposal boundary in order and aggregates finalizer failures", async () => {
    const store = createMemoryStore(initialFacts())
    const order: string[] = []
    const host = testHost(store, {
      lifecycle: {
        flushConversation: () => { order.push("conversation"); throw new Error("flush failed") },
        drainEventBus: () => { order.push("bus") },
        drainWriter: () => { order.push("writer") },
        disposeProjections: () => { order.push("projections") },
        disposeAdapters: () => { order.push("adapters") },
        disposeRemaining: () => { order.push("remaining"); throw new Error("scope failed") },
      },
    })

    const result = await host.dispose()

    expect(order).toEqual(["conversation", "bus", "writer", "projections", "adapters", "remaining"])
    expect(result).toMatchObject({
      kind: "failed",
      failure: {
        kind: "lifecycle",
        operation: "dispose",
        failures: ["conversation flush: flush failed", "remaining handles: scope failed"],
      },
    })
  })
})
