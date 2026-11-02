import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { isAbortError } from "../../../../src/infra/abort.js"
import { errorMessage } from "../../../../src/infra/error-message.js"
import { bunWorkerRunnerLayer } from "../../../../src/orchestration/app-service/bun-worker-rpc.js"
import { createProcessBackgroundClient } from "../../../../src/orchestration/app-service/worker-background-client.js"
import { RuntimeBackgroundRpc, RuntimeProtocolError, type RuntimeBackgroundSummaryResult } from "../../../../src/protocol/runtime-protocol-schemas.js"

const originalWorker = globalThis.Worker

/** A Worker whose other end runs the real background RPC server on this
 *  thread. Each message crosses as a structured clone on a later macrotask,
 *  as it does between threads. The server answers a summary read as the test
 *  states, by default never, and answers a project release and a shutdown at
 *  once. */
class InThreadServerWorker extends EventTarget {
  static instances: InThreadServerWorker[] = []
  static summaryRead: (released: Promise<void>) => Effect.Effect<RuntimeBackgroundSummaryResult, RuntimeProtocolError> = () => Effect.never
  static released = Promise.withResolvers<void>()
  static detailSessions: string[] = []
  readonly #self = new EventTarget()
  readonly server

  constructor() {
    super()
    InThreadServerWorker.instances.push(this)
    const listeners = new Map<(event: MessageEvent) => void, (event: Event) => void>()
    const self = {
      addEventListener: (type: "message", listener: (event: MessageEvent) => void) => {
        const adapted = (event: Event) => { if (event instanceof MessageEvent) listener(event) }
        listeners.set(listener, adapted)
        this.#self.addEventListener(type, adapted)
      },
      removeEventListener: (type: "message", listener: (event: MessageEvent) => void) => {
        const adapted = listeners.get(listener)
        if (adapted) this.#self.removeEventListener(type, adapted)
      },
      postMessage: (message: unknown) => { deliver(this, message) },
    }
    const unused = () => Effect.die(new Error("not used in this fixture"))
    this.server = ManagedRuntime.make(RpcServer.layer(RuntimeBackgroundRpc).pipe(
      Layer.provide(RuntimeBackgroundRpc.toLayer(Effect.succeed(RuntimeBackgroundRpc.of({
        RuntimeBackgroundRecall: unused,
        RuntimeBackgroundTranscriptSearch: unused,
        RuntimeBackgroundOutputWindow: unused,
        RuntimeBackgroundOutputRange: unused,
        RuntimeBackgroundOutputGroupChildren: unused,
        RuntimeBackgroundOutputBlockBody: unused,
        RuntimeBackgroundSessionChangeSummary: unused,
        RuntimeBackgroundSnapshot: unused,
        RuntimeBackgroundSessionSummaryImmediate: () => InThreadServerWorker.summaryRead(InThreadServerWorker.released.promise),
        RuntimeBackgroundWaitForTotals: unused,
        RuntimeBackgroundSessionDetail: (payload) => Effect.sync(() => {
          InThreadServerWorker.detailSessions.push(payload.sessionId)
          return { view: null }
        }),
        RuntimeBackgroundQueueSnapshotBatch: unused,
        RuntimeBackgroundModuleSnapshot: unused,
        RuntimeBackgroundReleaseProject: () => Effect.sync(() => { InThreadServerWorker.released.resolve() }),
        RuntimeBackgroundShutdown: () => Effect.void,
      })))),
      Layer.provide(RpcServer.layerProtocolWorkerRunner),
      Layer.provide(bunWorkerRunnerLayer(self)),
    ))
    void this.server.context()
  }

  postMessage(message: unknown): void {
    deliver(this.#self, message)
  }

  terminate(): void {
    this.dispatchEvent(new Event("close"))
  }
}

function deliver(target: EventTarget, message: unknown): void {
  const data: unknown = structuredClone(message)
  setTimeout(() => { target.dispatchEvent(new MessageEvent("message", { data })) }, 0)
}

class InitFailingWorker extends EventTarget {
  static instances: InitFailingWorker[] = []
  terminateCount = 0
  init: unknown

  constructor() {
    super()
    InitFailingWorker.instances.push(this)
  }

  postMessage(message: unknown): void {
    if (typeof message === "object" && message !== null && "flywheel" in message && message.flywheel === "background.init") {
      this.init = message
      throw new Error("background init failed")
    }
  }

  terminate(): void {
    this.terminateCount += 1
    this.dispatchEvent(new Event("close"))
  }
}

afterEach(async () => {
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker })
  InitFailingWorker.instances = []
  await Promise.all(InThreadServerWorker.instances.splice(0).map((worker) => worker.server.dispose()))
  InThreadServerWorker.summaryRead = () => Effect.never
  InThreadServerWorker.released = Promise.withResolvers<void>()
  InThreadServerWorker.detailSessions = []
})

describe("Worker background client", () => {
  test("detail session identity crosses the real RPC codec", async () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: InThreadServerWorker })
    const owner = createProcessBackgroundClient({ workerUrl: "worker.ts", logBase: "/scratch/flywheel-background-client" })
    const client = owner.acquire("/scratch/flywheel-background-client")
    try {
      await client.sessionDetail({ sessionId: "s1" })
      await client.sessionDetail({ sessionId: "s2" })
      expect(InThreadServerWorker.detailSessions).toEqual(["s1", "s2"])
    } finally {
      await client.close()
      await owner.dispose()
    }
  })

  test("an unused account owner has no Worker to warm or dispose", async () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: InitFailingWorker })
    const owner = createProcessBackgroundClient({ workerUrl: "worker.ts", logBase: "/scratch/flywheel-background-client" })
    expect(InitFailingWorker.instances).toHaveLength(0)
    await owner.dispose()
    expect(InitFailingWorker.instances).toHaveLength(0)
  })

  test("joins an allocated Worker when initialization fails", async () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: InitFailingWorker })
    const owner = createProcessBackgroundClient({ workerUrl: "worker.ts", logBase: "/scratch/flywheel-background-client" })
    const client = owner.acquire("/scratch/flywheel-background-client")
    const warming = client.warm().catch(() => undefined)

    const deadline = Date.now() + 1_000
    while (!InitFailingWorker.instances[0] || InitFailingWorker.instances[0].terminateCount === 0) {
      if (Date.now() > deadline) break
      await Bun.sleep(1)
    }

    expect(InitFailingWorker.instances[0]?.terminateCount).toBe(1)
    expect(InitFailingWorker.instances[0]?.init).toMatchObject({
      flywheel: "background.init",
      logBase: "/scratch/flywheel-background-client",
    })
    await client.close()
    await owner.dispose()
    await warming
  })

  test("a call that the owner's disposal interrupts rejects as an abort, not as a failure", async () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: InThreadServerWorker })
    const owner = createProcessBackgroundClient({ workerUrl: "worker.ts", logBase: "/scratch/flywheel-background-client" })
    const client = owner.acquire("/scratch/flywheel-background-client")
    const read = client.sessionSummaryImmediate(["s1"]).then(() => undefined, (error: unknown) => error)
    await client.warm()
    await client.close()
    await owner.dispose()

    expect(isAbortError(await read)).toBe(true)
  })

  test("the Worker's refusal of a project that the client's own close released, and every later call, reject as aborts", async () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: InThreadServerWorker })
    InThreadServerWorker.summaryRead = (released) => Effect.promise(() => released).pipe(
      Effect.andThen(Effect.fail(new RuntimeProtocolError({ message: "Runtime background project is closing", kind: "internal" }))),
    )
    const owner = createProcessBackgroundClient({ workerUrl: "worker.ts", logBase: "/scratch/flywheel-background-client" })
    const client = owner.acquire("/scratch/flywheel-background-client")
    const read = client.sessionSummaryImmediate(["s1"]).then(() => undefined, (error: unknown) => error)
    await client.warm()
    await client.close()
    const refusal = await read
    const later: unknown = await client.snapshot().then(() => undefined, (error: unknown) => error)
    await owner.dispose()

    expect(isAbortError(refusal)).toBe(true)
    expect(errorMessage(refusal)).toContain("Runtime background project is closing")
    expect(isAbortError(later)).toBe(true)
    expect(later).toMatchObject({ message: "Runtime background client is closed" })
  })

  test("the Worker's refusal of an open client stays a failure", async () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: InThreadServerWorker })
    InThreadServerWorker.summaryRead = () => Effect.fail(new RuntimeProtocolError({ message: "Runtime background project is closing", kind: "internal" }))
    const owner = createProcessBackgroundClient({ workerUrl: "worker.ts", logBase: "/scratch/flywheel-background-client" })
    const client = owner.acquire("/scratch/flywheel-background-client")
    const refusal: unknown = await client.sessionSummaryImmediate(["s1"]).then(() => undefined, (error: unknown) => error)
    await client.close()
    await owner.dispose()

    expect(refusal).toBeInstanceOf(RuntimeProtocolError)
    expect(isAbortError(refusal)).toBe(false)
  })
})
