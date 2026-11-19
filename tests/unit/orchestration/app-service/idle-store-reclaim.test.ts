import { describe, expect, test } from "bun:test"
import { createIdleStoreReclaim, IDLE_RECLAIM_INTERVAL_MS, IDLE_RECLAIM_RECHECK_MS } from "../../../../src/orchestration/app-service/idle-store-reclaim.js"
import type { ReplacementBlocker } from "../../../../src/orchestration/app-service/replacement-blockers.js"

const TURN: ReplacementBlocker = { projectRoot: "/work/alpha", projectLabel: "alpha", reason: "turn", sessionId: "s1" }
const OPENING: ReplacementBlocker = { projectRoot: "/work/alpha", projectLabel: "alpha", reason: "opening" }

/** An idle reclaim whose runs and blockers the case controls. */
function scheduler(options: { readonly converts?: boolean } = {}) {
  let blockers: readonly ReplacementBlocker[] = []
  let conversionOffers = 0
  let now = 1_000
  const runs: { withdrawn: number; end: () => void }[] = []
  let blockerReads = 0
  // The one timer the owner keeps armed, which the case fires.
  let timer: { readonly fire: () => void; readonly delayMs: number } | undefined
  const reclaim = createIdleStoreReclaim({
    blockers: async () => { blockerReads++; return blockers },
    convert: () => { conversionOffers++; return options.converts ?? false },
    now: () => now,
    setTimer: (fire, delayMs) => {
      const armed = { fire, delayMs }
      timer = armed
      return () => { if (timer === armed) timer = undefined }
    },
    start: () => {
      const ended = Promise.withResolvers<void>()
      const run = { withdrawn: 0, end: () => ended.resolve() }
      runs.push(run)
      return { settled: ended.promise, withdraw: async () => { run.withdrawn++; ended.resolve() } }
    },
  })
  const settle = () => Bun.sleep(1)
  return {
    reclaim, runs, settle,
    blockerReads: () => blockerReads,
    conversionOffers: () => conversionOffers,
    timer: () => timer,
    /** Moves the clock to the armed timer and fires it. */
    fire: async () => {
      const armed = timer
      if (!armed) throw new Error("no check is armed")
      timer = undefined
      now += armed.delayMs
      armed.fire()
      await settle()
    },
    work: (next: readonly ReplacementBlocker[]) => { blockers = next },
    advance: (ms: number) => { now += ms },
  }
}

describe("idle store reclaim", () => {
  test("runs while the project is idle, stops when work starts, and waits out the interval before it runs again", async () => {
    const idle = scheduler()
    idle.reclaim.check()
    await idle.settle()
    expect(idle.runs).toHaveLength(1)

    idle.work([TURN])
    idle.reclaim.check()
    await idle.settle()
    expect(idle.runs[0]?.withdrawn).toBe(1)

    idle.work([])
    idle.reclaim.check()
    await idle.settle()
    expect(idle.runs).toHaveLength(1)

    idle.advance(IDLE_RECLAIM_INTERVAL_MS)
    idle.reclaim.check()
    await idle.settle()
    expect(idle.runs).toHaveLength(2)
  })

  test("a check that finds the executor still opening looks again by itself, and the run starts once the project is idle", async () => {
    // Startup maintenance settles before the executor generation is ready,
    // so the one check that settling asks for finds the project opening.
    const idle = scheduler()
    idle.work([OPENING])
    idle.reclaim.check()
    await idle.settle()
    expect(idle.runs).toHaveLength(0)
    expect(idle.timer()?.delayMs).toBe(IDLE_RECLAIM_RECHECK_MS)

    // The executor is ready and no turn runs; nobody calls check().
    idle.work([])
    await idle.fire()
    expect(idle.runs).toHaveLength(1)

    // While the run runs nothing is armed; its end arms the next check at the
    // interval, and each armed check reads the blockers once.
    expect(idle.timer()).toBeUndefined()
    idle.runs[0]?.end()
    await idle.settle()
    expect(idle.timer()?.delayMs).toBe(IDLE_RECLAIM_INTERVAL_MS)
    const reads = idle.blockerReads()
    await idle.fire()
    expect(idle.blockerReads()).toBe(reads + 1)
    expect(idle.runs).toHaveLength(2)

    await idle.reclaim.dispose()
    expect(idle.timer()).toBeUndefined()
  })

  test("an idle check offers the store's conversion before an idle run, and a busy check offers nothing", async () => {
    const idle = scheduler()
    idle.work([TURN])
    idle.reclaim.check()
    await idle.settle()
    expect(idle.conversionOffers()).toBe(0)

    // A store that needs no conversion gets its idle run.
    idle.work([])
    idle.reclaim.check()
    await idle.settle()
    expect(idle.conversionOffers()).toBe(1)
    expect(idle.runs).toHaveLength(1)
  })

  test("a conversion that starts takes the place of the idle run, and the owner checks nothing more in this open", async () => {
    const idle = scheduler({ converts: true })
    idle.reclaim.check()
    await idle.settle()
    expect(idle.conversionOffers()).toBe(1)
    expect(idle.runs).toHaveLength(0)
    expect(idle.timer()).toBeUndefined()

    idle.advance(IDLE_RECLAIM_INTERVAL_MS)
    idle.reclaim.check()
    await idle.settle()
    expect(idle.conversionOffers()).toBe(1)
    expect(idle.runs).toHaveLength(0)
  })

  test("starts no second run while one runs, and a disposed scheduler starts none and withdraws its run", async () => {
    const idle = scheduler()
    idle.reclaim.check()
    idle.reclaim.check()
    await idle.settle()
    idle.advance(IDLE_RECLAIM_INTERVAL_MS)
    idle.reclaim.check()
    await idle.settle()
    expect(idle.runs).toHaveLength(1)

    await idle.reclaim.dispose()
    expect(idle.runs[0]?.withdrawn).toBe(1)
    idle.advance(IDLE_RECLAIM_INTERVAL_MS)
    idle.reclaim.check()
    await idle.settle()
    expect(idle.runs).toHaveLength(1)
  })
})
