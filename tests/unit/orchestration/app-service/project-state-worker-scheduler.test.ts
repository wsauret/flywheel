import { describe, expect, test, spyOn } from "bun:test"
import { createProjectStateScheduler } from "../../../../src/orchestration/app-service/project-state-worker.js"
import type { ProjectStateOperation, ProjectStateResult } from "../../../../src/orchestration/app-service/project-state-protocol.js"
import { enqueue, served } from "./_project-state-worker-fixture.js"

describe("project state scheduler queueing", () => {
  test("runs control after the complete current execution item", async () => {
    const order: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const scheduler = createProjectStateScheduler(async (operation: ProjectStateOperation) => {
      order.push(`start:${operation.kind}`)
      if (operation.kind === "execution.operation") await blocked
      order.push(`end:${operation.kind}`)
      return { result: { kind: "ok" } }
    })

    const first = enqueue(scheduler, "execution", {
      kind: "execution.operation",
      projectId: "p",
      generation: 1,
      operation: { kind: "append", item: { sessionId: "s", events: [], inFlight: [{ op: "put", kind: "tool", key: "k", payload: {} }] } },
    })
    await Promise.resolve()
    const second = enqueue(scheduler, "execution", { kind: "generation.close", projectId: "p", generation: 1 })
    const control = enqueue(scheduler, "control", { kind: "position.capture" })
    release()
    await Promise.all([first, second, control])

    expect(order).toEqual([
      "start:execution.operation",
      "end:execution.operation",
      "start:position.capture",
      "end:position.capture",
      "start:generation.close",
      "end:generation.close",
    ])
  })

  test("serves requests without a timer, alone or behind a backlog", async () => {
    // A zero timer costs about one millisecond in Bun, so a timer per queued
    // request capped the worker near a thousand requests per second while idle.
    const timers = spyOn(globalThis, "setTimeout")
    const kinds: string[] = []
    const scheduler = createProjectStateScheduler(async (operation) => { kinds.push(operation.kind); return { result: { kind: "ok" } } })
    try {
      await enqueue(scheduler, "control", { kind: "position.capture" })
      const second = enqueue(scheduler, "control", { kind: "position.capture" })
      // An idle scheduler starts the request in the same task.
      expect(kinds).toEqual(["position.capture", "position.capture"])
      await second
      await Promise.all(Array.from({ length: 100 }, () => enqueue(scheduler, "execution", { kind: "generation.admit", projectId: "p", generation: 1 })))
      expect(kinds).toHaveLength(102)
      expect(timers).toHaveBeenCalledTimes(0)
    } finally {
      timers.mockRestore()
      await scheduler.close()
    }
  })

  test("bounds each lane before insertion, and a refusal for pressure carries no head", async () => {
    const scheduler = createProjectStateScheduler(async () => ({ result: { kind: "ok" }, head: 1 }), { maxQueuedItems: 0 })
    await expect(served(scheduler, "execution", { kind: "generation.admit", projectId: "p", generation: 1 }))
      .resolves.toStrictEqual({ result: { kind: "refused", reason: "pressure" } })
  })

  test("yields to incoming control messages while execution remains queued", async () => {
    const order: string[] = []
    const scheduler = createProjectStateScheduler(async (operation) => {
      order.push(operation.kind)
      return { result: { kind: "ok" } }
    })
    // A port message is a task that arrives while the backlog drains.
    const control = new Promise<ProjectStateResult>((resolve) => {
      setImmediate(() => resolve(enqueue(scheduler, "control", { kind: "position.capture" })))
    })
    const execution = Array.from({ length: 8 }, () =>
      enqueue(scheduler, "execution", { kind: "generation.admit", projectId: "p", generation: 1 }))
    await Promise.all([...execution, control])
    expect(order.slice(0, 3)).toEqual(["generation.admit", "position.capture", "generation.admit"])
    await scheduler.close()
  })

  test("counts in-flight work, isolates lane bounds, joins work, and contains operation failure", async () => {
    const release = Promise.withResolvers<void>()
    const failure = new Error("operation failed")
    const scheduler = createProjectStateScheduler(async (operation) => {
      if (operation.kind === "generation.admit") {
        await release.promise
        throw failure
      }
      return { result: { kind: "ok" } }
    }, { maxQueuedItems: 1 })
    const execution = enqueue(scheduler, "execution", { kind: "generation.admit", projectId: "p", generation: 1 })
    await expect(enqueue(scheduler, "execution", { kind: "generation.close", projectId: "p", generation: 1 })).resolves.toMatchObject({ kind: "refused", reason: "pressure" })
    const control = enqueue(scheduler, "control", { kind: "position.capture" })
    let joined = false
    const close = scheduler.close().then(() => { joined = true })
    await Promise.resolve()
    expect(joined).toBe(false)
    await expect(enqueue(scheduler, "control", { kind: "position.capture" })).resolves.toMatchObject({ kind: "failed" })
    release.resolve()
    await expect(execution).resolves.toEqual({ kind: "failed", error: failure })
    await expect(control).resolves.toEqual({ kind: "ok" })
    await close
    expect(joined).toBe(true)
  })
})
