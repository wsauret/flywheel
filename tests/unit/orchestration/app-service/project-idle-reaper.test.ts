import { describe, expect, test } from "bun:test"

import { createProjectRuntime } from "../../../../src/orchestration/app-service/project-runtime.js"
import type { ReplacementBlocker } from "../../../../src/orchestration/app-service/replacement-blockers.js"

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("ProjectRuntime idle ownership", () => {
  test("arms idle grace when a ready project has no initial client", async () => {
    let closes = 0
    const runtime = createProjectRuntime({
      projectRoot: "/project",
      idleGraceMs: 5,
      blockers: async () => [],
      onIdle: async () => { closes += 1 },
      closeEndpoint: async () => {},
      closeTransports: async () => {},
      runShutdownBarrier: async () => {},
    })

    await tick(10)
    expect(closes).toBe(1)
    await runtime.dispose()
  })

  test("a client arriving during the asynchronous work check cancels reaping", async () => {
    const checked = Promise.withResolvers<readonly ReplacementBlocker[]>()
    let barriers = 0
    const runtime = createProjectRuntime({
      projectRoot: "/project",
      idleGraceMs: 5,
      blockers: () => checked.promise,
      onIdle: async () => { barriers += 1 },
      closeEndpoint: async () => {},
      closeTransports: async () => {},
      runShutdownBarrier: async () => {},
    })
    runtime.liveWorkChanged()
    await tick(10)
    runtime.holdClient()
    checked.resolve([])
    await tick(10)
    expect(barriers).toBe(0)
    await runtime.dispose()
  })

  test("a hold for an absent client keeps the project open until it ends, and a closing project takes none", async () => {
    let closes = 0
    const runtime = createProjectRuntime({
      projectRoot: "/project",
      idleGraceMs: 5,
      blockers: async () => [],
      onIdle: async () => { closes += 1 },
      closeEndpoint: async () => {},
      closeTransports: async () => {},
      runShutdownBarrier: async () => {},
    })
    const release = runtime.holdIfOpen()
    await tick(10)
    expect(closes).toBe(0)
    expect(runtime.held()).toBe(true)
    release?.()
    await tick(10)
    expect(closes).toBe(1)

    const disposal = runtime.dispose()
    expect(runtime.holdIfOpen()).toBeUndefined()
    expect(runtime.held()).toBe(false)
    await disposal
  })
})
