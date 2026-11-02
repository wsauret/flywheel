import { describe, expect, test } from "bun:test"

import { servePersistentProcessBridge } from "../../../src/infra/persistent-process-bridge.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import type { PersistentSubprocess } from "../../../src/infra/persistent-subprocess.js"

function persistentRecord(pid: number, command: readonly string[]): PersistentSubprocess {
  return {
    pid,
    command,
    spool: { directory: `/spool/${pid}`, stdoutPath: `/spool/${pid}/stdout`, stderrPath: `/spool/${pid}/stderr` },
    exited: new Promise<number>(() => {}),
    metadata: () => ({ startedAtMs: pid, status: "running", stdoutBytes: 1, stderrBytes: 0 }),
    read: () => ({ data: new Uint8Array([pid]), nextOffset: 1, eof: true }),
    stop: async () => "terminated",
    release: () => {},
  }
}

interface WorkerResult {
  readonly kind: string
  readonly launchedId?: string
  readonly counts?: readonly number[]
  readonly values?: readonly number[]
  readonly error?: string
}

interface RunningWorker {
  readonly worker: Worker
  readonly result: Promise<WorkerResult>
}

function runWorker(port: MessagePort, launch: boolean): RunningWorker {
  const worker = new Worker(new URL("persistent-process-bridge-worker.ts", import.meta.url).href)
  const result = new Promise<WorkerResult>((resolve, reject) => {
    worker.addEventListener("message", (event: MessageEvent) => {
      const value: unknown = event.data
      if (typeof value !== "object" || value === null || !("kind" in value) || typeof value.kind !== "string") {
        reject(new Error("invalid worker result"))
        return
      }
      const launchedId = "launchedId" in value && typeof value.launchedId === "string" ? value.launchedId : undefined
      const counts = "counts" in value && Array.isArray(value.counts) && value.counts.every((count) => typeof count === "number") ? value.counts : undefined
      const values = "values" in value && Array.isArray(value.values) && value.values.every((entry) => typeof entry === "number") ? value.values : undefined
      const error = "error" in value && typeof value.error === "string" ? value.error : undefined
      resolve({ kind: value.kind, launchedId, counts, values, error })
    }, { once: true })
    worker.addEventListener("error", (event) => { reject(event.error instanceof Error ? event.error : new Error(event.message)) }, { once: true })
  })
  worker.postMessage({ port, launch }, [port])
  return { worker, result }
}

describe("persistent process bridge across Bun Worker realms", () => {
  test("retains distinct manager state when a Worker replaces another", async () => {
    let launches = 0
    const manager = createPersistentProcessManager({
      launch: async (command) => {
        launches += 1
        return persistentRecord(launches, command)
      },
    })
    const firstChannel = new MessageChannel()
    const closeFirstHost = servePersistentProcessBridge({ manager, port: firstChannel.port1, allowLaunch: async () => true })
    const first = runWorker(firstChannel.port2, true)

    const firstResult = await first.result
    expect(firstResult).toMatchObject({ kind: "launched" })
    expect(firstResult.error).toBeUndefined()
    expect(firstResult.values).toEqual(Array.from({ length: 16 }, (_, index) => index + 1))
    expect(launches).toBe(16)
    first.worker.terminate()
    await closeFirstHost()

    const secondChannel = new MessageChannel()
    const closeSecondHost = servePersistentProcessBridge({ manager, port: secondChannel.port1, allowLaunch: async () => true })
    const second = runWorker(secondChannel.port2, false)
    try {
      const secondResult = await second.result
      expect(secondResult).toMatchObject({ kind: "complete" })
      expect(secondResult.counts).toEqual([16])
      expect(secondResult.values).toEqual(Array.from({ length: 16 }, (_, index) => index + 1))
      expect(launches).toBe(16)
    } finally {
      second.worker.terminate()
      await closeSecondHost()
      manager.releaseAll()
    }
  }, 10_000)
})
