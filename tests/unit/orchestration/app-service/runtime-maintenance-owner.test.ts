import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import type { StartupDirectories } from "../../../../src/infra/directory-authorities.js"
import { connectOwnedProcessBridge } from "../../../../src/infra/owned-process-bridge.js"
import type { GuardianControl } from "../../../../src/infra/process-supervisor.js"
import { createMaintenanceQueue, type ProjectMaintenanceJob } from "../../../../src/orchestration/app-service/runtime-maintenance-owner.js"
import type { RuntimeMaintenanceWorkerInit } from "../../../../src/orchestration/app-service/runtime-maintenance-worker.js"

/** A guardian that declares a generation and proves it empty on close; no job
 *  under test leases anything into it. */
const idleGuardian: Pick<GuardianControl, "openGeneration"> = {
  openGeneration: async () => ({
    request: async () => { throw new Error("this generation leases nothing") },
    pid: async () => process.pid,
    close: async () => ({ settled: true as const }),
  }),
}

/** A Worker thread as the owner sees one: it takes its init frame, and the
 *  test says when it ends, as a job that finished or was cut. */
class FakeWorker extends EventTarget {
  static instances: FakeWorker[] = []
  static failInit = false
  init: RuntimeMaintenanceWorkerInit | undefined
  terminated = 0
  constructor() {
    super()
    FakeWorker.instances.push(this)
  }
  postMessage(message: RuntimeMaintenanceWorkerInit): void {
    if (FakeWorker.failInit) throw new Error("maintenance init failed")
    this.init = message
  }
  terminate(): void {
    this.terminated++
    this.exit()
  }
  exit(): void {
    this.dispatchEvent(new Event("close"))
  }
  /** Ends the thread once its generation is cut, as the real Worker does
   *  after its lifetime aborts and its work settles. */
  exitWhenCut(): void {
    const port = this.init?.ownership
    if (!port) throw new Error("the Worker has no init")
    const ownership = connectOwnedProcessBridge({ port })
    ownership.lifetime.addEventListener("abort", () => { this.exit() }, { once: true })
  }
}

const OriginalWorker = globalThis.Worker
beforeEach(() => {
  FakeWorker.instances = []
  FakeWorker.failInit = false
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: FakeWorker })
})
afterEach(() => {
  Object.defineProperty(globalThis, "Worker", { configurable: true, writable: true, value: OriginalWorker })
})

function directories(projectRoot: string): StartupDirectories {
  return { projectRoot, executionCwd: projectRoot, accountHome: "/home/me", userDataRoot: "/home/me/.flywheel" }
}

/** A project's job whose state channel records its serving. */
function job(projectRoot: string) {
  const served = { opened: 0, stopped: 0 }
  const spec: ProjectMaintenanceJob = {
    directories: directories(projectRoot),
    serveState: () => {
      served.opened++
      return async () => { served.stopped++ }
    },
  }
  return { spec, served }
}

function queue() {
  return createMaintenanceQueue({ workerUrl: "flywheel-test://maintenance", guardian: idleGuardian })
}

async function isPending(promise: Promise<void>): Promise<boolean> {
  const marker = Symbol("pending")
  return await Promise.race([promise.then(() => false), Bun.sleep(5).then(() => marker)]) === marker
}

async function nextWorker(count: number): Promise<FakeWorker> {
  for (let attempt = 0; attempt < 100 && FakeWorker.instances.length < count; attempt++) await Bun.sleep(1)
  const worker = FakeWorker.instances[count - 1]
  if (!worker) throw new Error(`Worker ${count} was not started`)
  return worker
}

describe("the account's startup maintenance queue", () => {
  test("runs one project's job at a time, each in its own Worker with its own state channel", async () => {
    const maintenance = queue()
    const alpha = job("/work/alpha")
    const beta = job("/work/beta")
    maintenance.project(alpha.spec).admit()
    maintenance.project(beta.spec).admit()

    const first = await nextWorker(1)
    expect(first.init?.directories.projectRoot).toBe("/work/alpha")
    expect(alpha.served.opened).toBe(1)
    await Bun.sleep(5)
    expect(FakeWorker.instances).toHaveLength(1)

    first.exit()
    const second = await nextWorker(2)
    expect(second.init?.directories.projectRoot).toBe("/work/beta")
    second.exit()
    await maintenance.dispose()
    expect(alpha.served).toEqual({ opened: 1, stopped: 1 })
    expect(beta.served).toEqual({ opened: 1, stopped: 1 })
  })

  test("a queued job withdrawn settles at once, never waiting for another project's job, and never starts", async () => {
    const maintenance = queue()
    const alpha = maintenance.project(job("/work/alpha").spec)
    const beta = job("/work/beta")
    const betaJob = maintenance.project(beta.spec)
    alpha.admit()
    betaJob.admit()
    const running = await nextWorker(1)

    await betaJob.withdraw()
    running.exit()
    await maintenance.dispose()
    expect(FakeWorker.instances).toHaveLength(1)
    expect(beta.served.opened).toBe(0)
  })

  test("a running job withdrawn has its generation cut and settles once its Worker has ended", async () => {
    const maintenance = queue()
    const alpha = job("/work/alpha")
    const handle = maintenance.project(alpha.spec)
    handle.admit()
    const worker = await nextWorker(1)
    worker.exitWhenCut()

    const withdrawn = handle.withdraw()
    await withdrawn
    expect(alpha.served).toEqual({ opened: 1, stopped: 1 })
    handle.admit()
    await maintenance.dispose()
    expect(FakeWorker.instances).toHaveLength(1)
  })

  test("a job whose Worker cannot take its init is ended and joined, and the next job still runs", async () => {
    const maintenance = queue()
    FakeWorker.failInit = true
    const alpha = job("/work/alpha")
    const handle = maintenance.project(alpha.spec)
    handle.admit()
    const failed = await nextWorker(1)
    FakeWorker.failInit = false
    await handle.withdraw()
    expect(failed.terminated).toBe(1)
    expect(alpha.served.stopped).toBe(alpha.served.opened)

    maintenance.project(job("/work/beta").spec).admit()
    const next = await nextWorker(2)
    expect(next.init?.directories.projectRoot).toBe("/work/beta")
    next.exit()
    await maintenance.dispose()
  })

  test("a job withdrawn before its project is ready never runs, and a disposed queue admits nothing", async () => {
    const maintenance = queue()
    const early = maintenance.project(job("/work/alpha").spec)
    expect(await isPending(early.withdraw())).toBe(false)
    early.admit()
    await maintenance.dispose()
    maintenance.project(job("/work/beta").spec).admit()
    await Bun.sleep(5)
    expect(FakeWorker.instances).toHaveLength(0)
  })
})
