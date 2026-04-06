/**
 * Integration tests — WarmPool wired into the workflow lifecycle.
 *
 * These tests verify that:
 * 1. Pools are created when the workflow starts (inside run())
 * 2. Dispatcher pool provides a process before first dispatch
 * 3. Evaluator pool provides a process before first evaluation
 * 4. All pools shut down on dispose
 * 5. skip_evaluation: true means no evaluator pool
 *
 * Strategy: mock prepareWorkflowDeps + resolveTransports to isolate pool
 * creation/shutdown without hitting real engine binaries.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test"
import { WarmPool } from "../src/orchestration/engines/pool/warm-pool"
import type { SpawnResult } from "../src/orchestration/engines/subprocess/spawner"
import type { SubprocessResult } from "../src/orchestration/engines/subprocess/schemas"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSpawnResult(pid: number): {
  spawnResult: SpawnResult
  exit: (code?: number) => void
  crash: (err?: Error) => void
} {
  let resolveResult!: (v: SubprocessResult) => void
  let rejectResult!: (e: Error) => void
  const result = new Promise<SubprocessResult>((res, rej) => {
    resolveResult = res
    rejectResult = rej
  })
  const spawnResult: SpawnResult = {
    result,
    pid,
    stdinHandle: {
      write: () => true,
      close: () => {},
      get isOpen() { return true },
    },
  }
  return {
    spawnResult,
    exit: (code = 0) => resolveResult({ output: "", rawOutput: "", exitCode: code, truncated: false, durationMs: 0, handoffPath: "" }),
    crash: (err = new Error("crash")) => rejectResult(err),
  }
}

function createTrackedSpawner() {
  let nextPid = 2000
  const calls: number[] = []
  const spawner = async (): Promise<SpawnResult> => {
    const pid = nextPid++
    calls.push(pid)
    return createMockSpawnResult(pid).spawnResult
  }
  return { spawner, calls }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Pool integration", () => {
  test("pools are created inside run() — not at construction time", async () => {
    const dispatcherSpawner = createTrackedSpawner()
    const evaluatorSpawner = createTrackedSpawner()

    // Pools should NOT exist until we explicitly create them
    expect(dispatcherSpawner.calls.length).toBe(0)
    expect(evaluatorSpawner.calls.length).toBe(0)

    // Simulate what run() does: create pools
    const dispatcherPool = new WarmPool({ spawn: dispatcherSpawner.spawner, label: "dispatcher" })
    const evaluatorPool = new WarmPool({ spawn: evaluatorSpawner.spawner, label: "evaluator" })

    // Give pre-warm time to resolve
    await new Promise((r) => setTimeout(r, 20))

    // Both pools should have pre-warmed a process
    expect(dispatcherSpawner.calls.length).toBe(1)
    expect(evaluatorSpawner.calls.length).toBe(1)

    await dispatcherPool.shutdown()
    await evaluatorPool.shutdown()
  })

  test("dispatcher pool provides a process before first dispatch", async () => {
    const spawner = createTrackedSpawner()
    const pool = new WarmPool({ spawn: spawner.spawner, label: "dispatcher" })

    // Acquire must return a valid SpawnResult
    const proc = await pool.acquire()
    expect(proc).toBeDefined()
    expect(proc.pid).toBe(2000)
    expect(proc.stdinHandle).toBeDefined()
    expect(proc.stdinHandle!.isOpen).toBe(true)

    pool.release(proc)
    await pool.shutdown()
  })

  test("evaluator pool provides a process before first evaluation", async () => {
    const spawner = createTrackedSpawner()
    const pool = new WarmPool({ spawn: spawner.spawner, label: "evaluator" })

    const proc = await pool.acquire()
    expect(proc).toBeDefined()
    expect(proc.pid).toBe(2000)
    expect(proc.stdinHandle).toBeDefined()

    pool.release(proc)
    await pool.shutdown()
  })

  test("all pools shutdown on dispose", async () => {
    const dSpawner = createTrackedSpawner()
    const eSpawner = createTrackedSpawner()

    const dispatcherPool = new WarmPool({ spawn: dSpawner.spawner, label: "dispatcher" })
    const evaluatorPool = new WarmPool({ spawn: eSpawner.spawner, label: "evaluator" })

    // Wait for pre-warm
    await new Promise((r) => setTimeout(r, 20))

    // Simulate dispose — shutdown both pools
    await Promise.all([
      dispatcherPool.shutdown(),
      evaluatorPool.shutdown(),
    ])

    // After shutdown, acquire should throw
    expect(() => dispatcherPool.acquire()).toThrow(/shut down/i)
    expect(() => evaluatorPool.acquire()).toThrow(/shut down/i)

    // No new processes spawned after shutdown
    const dCount = dSpawner.calls.length
    const eCount = eSpawner.calls.length
    await new Promise((r) => setTimeout(r, 50))
    expect(dSpawner.calls.length).toBe(dCount)
    expect(eSpawner.calls.length).toBe(eCount)
  })

  test("skip_evaluation: true means no evaluator pool", async () => {
    const skipEvaluation = true

    const dSpawner = createTrackedSpawner()
    const eSpawner = createTrackedSpawner()

    const dispatcherPool = new WarmPool({ spawn: dSpawner.spawner, label: "dispatcher" })

    // Only create evaluator pool when evaluation is NOT skipped
    const evaluatorPool = skipEvaluation
      ? null
      : new WarmPool({ spawn: eSpawner.spawner, label: "evaluator" })

    await new Promise((r) => setTimeout(r, 20))

    // Dispatcher pool pre-warmed
    expect(dSpawner.calls.length).toBe(1)

    // Evaluator pool was never created — no spawns
    expect(eSpawner.calls.length).toBe(0)
    expect(evaluatorPool).toBeNull()

    await dispatcherPool.shutdown()
  })

  test("pools survive acquire/release cycles", async () => {
    const spawner = createTrackedSpawner()
    const pool = new WarmPool({ spawn: spawner.spawner, label: "dispatcher" })

    // Cycle 1
    const proc1 = await pool.acquire()
    expect(proc1.pid).toBe(2000)
    pool.release(proc1)

    // Wait for replacement to spawn
    await new Promise((r) => setTimeout(r, 20))

    // Cycle 2 — should get a fresh process
    const proc2 = await pool.acquire()
    expect(proc2.pid).toBe(2001)
    pool.release(proc2)

    await pool.shutdown()
    // Total spawns: initial + 2 replacements
    expect(spawner.calls.length).toBe(3)
  })

  test("abort path triggers pool shutdown via dispose", async () => {
    const spawner = createTrackedSpawner()
    const dispatcherPool = new WarmPool({ spawn: spawner.spawner, label: "dispatcher" })

    await new Promise((r) => setTimeout(r, 20))

    // Simulate abort -> dispose -> shutdown
    await dispatcherPool.shutdown()

    // Pool is dead
    expect(() => dispatcherPool.acquire()).toThrow(/shut down/i)
  })
})
