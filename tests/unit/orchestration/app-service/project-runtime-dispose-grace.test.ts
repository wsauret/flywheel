import { describe, expect, test } from "bun:test"

import { createProjectRuntime } from "../../../../src/orchestration/app-service/project-runtime.js"

describe("ProjectRuntime disposal", () => {
  test("owns endpoint, transports, and barrier in independent ordered teardown", async () => {
    const order: string[] = []
    const runtime = createProjectRuntime({
      projectRoot: "/project",
      idleGraceMs: 0,
      blockers: async () => [],
      onIdle: async () => {},
      closeEndpoint: async () => { order.push("endpoint") },
      closeTransports: async () => { order.push("transports") },
      runShutdownBarrier: async () => { order.push("barrier") },
    })

    await runtime.dispose()
    expect(order).toEqual(["endpoint", "transports", "barrier"])
    await runtime.dispose()
    expect(order).toEqual(["endpoint", "transports", "barrier"])
  })

  test("bounds presentation transport disposal without abandoning the runtime barrier", async () => {
    const order: string[] = []
    let timedOut = false
    const runtime = createProjectRuntime({
      projectRoot: "/project",
      idleGraceMs: 0,
      transportDisposeGraceMs: 5,
      blockers: async () => [],
      onIdle: async () => {},
      closeEndpoint: async () => { order.push("endpoint") },
      closeTransports: () => new Promise<void>(() => {}),
      onTransportDisposeTimeout: () => { timedOut = true },
      runShutdownBarrier: async () => { order.push("barrier") },
    })

    await runtime.dispose()
    expect(timedOut).toBe(true)
    expect(order).toEqual(["endpoint", "barrier"])
  })

  test("retries only the retained failed release step", async () => {
    const order: string[] = []
    let attempts = 0
    const runtime = createProjectRuntime({
      projectRoot: "/project",
      idleGraceMs: 0,
      blockers: async () => [],
      onIdle: async () => {},
      closeEndpoint: async () => { order.push("endpoint") },
      closeTransports: async () => {
        order.push("transports")
        attempts += 1
        if (attempts === 1) throw new Error("transport release failed")
      },
      runShutdownBarrier: async () => { order.push("barrier") },
    })

    await expect(runtime.dispose()).rejects.toThrow("transport release failed")
    await runtime.dispose()
    expect(order).toEqual(["endpoint", "transports", "transports", "barrier"])
  })

  test("requests owner close after final release and defers while work is live", async () => {
    let live = true
    let closes = 0
    const runtime = createProjectRuntime({
      projectRoot: "/project",
      idleGraceMs: 1,
      blockers: async () => live ? [{ projectRoot: "/project", projectLabel: "project", reason: "turn" }] : [],
      onIdle: async () => { closes += 1 },
      closeEndpoint: async () => {},
      closeTransports: async () => {},
      runShutdownBarrier: async () => {},
    })

    const release = runtime.holdClient()
    release()
    await Bun.sleep(5)
    expect(closes).toBe(0)
    live = false
    runtime.liveWorkChanged()
    await Bun.sleep(5)
    expect(closes).toBe(1)
    await runtime.dispose()
  })
})
