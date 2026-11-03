import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { Worker as EffectWorker } from "effect/workers"
import { bunWorkerClientLayers } from "../../../../src/orchestration/app-service/bun-worker-rpc.js"
import { applyRuntimeCallPolicy } from "../../../../src/protocol/runtime-client-deadlines.js"

function fakeWorker() {
  const listeners = new Map<string, Set<(event: Event) => void>>()
  const worker: globalThis.Worker = {
    onerror: null,
    onmessage: null,
    onmessageerror: null,
    dispatchEvent: (event: Event) => {
      for (const listener of listeners.get(event.type) ?? []) listener(event)
      return !event.defaultPrevented
    },
    postMessage: () => {},
    terminate: () => {
      for (const listener of listeners.get("close") ?? []) listener(new Event("close"))
    },
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener !== "function") throw new Error("Object listeners are not used by the worker adapter")
      const registered = listeners.get(type) ?? new Set<(event: Event) => void>()
      registered.add(listener)
      listeners.set(type, registered)
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") listeners.get(type)?.delete(listener)
    },
  }
  return {
    worker,
    emit: (type: string, event: Event) => {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
  }
}

describe("bunWorkerClientLayers", () => {
  test("worker close rejects an in-flight lossless call", async () => {
    const fake = fakeWorker()
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const platform = yield* EffectWorker.WorkerPlatform
      const worker = yield* platform.spawn(0)
      const call = yield* applyRuntimeCallPolicy(
        worker.run(() => Effect.void),
        { _tag: "Lossless" },
      ).pipe(Effect.forkScoped)
      yield* Effect.sleep(1)
      fake.emit("message", new MessageEvent("message", { data: [0] }))
      fake.emit("close", new Event("close"))
      return yield* Fiber.await(call)
    }).pipe(Effect.provide(bunWorkerClientLayers(() => fake.worker)))))

    expect(Exit.isFailure(exit)).toBe(true)
  })
})
