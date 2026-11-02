import { describe, expect, it, spyOn } from "bun:test"

import * as eventLoopLag from "../../../src/infra/event-loop-lag.js"
import { SLOW_UNIT_BUDGET_MS } from "../../../src/infra/event-loop-lag.js"
import { Log } from "../../../src/infra/log.js"
import { runInTaskSlices, runInTaskTurn } from "../../../src/infra/task-scheduling.js"

/** Holds the thread for at least `ms` milliseconds, as one synchronous unit does.
 *  A loaded machine can only make a unit longer, so each expectation below
 *  depends on a lower bound only: a unit that must spend the slice holds the
 *  thread for longer than the budget, and no expectation needs a unit to stay
 *  short. */
function hold(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) { /* busy unit */ }
}

/** A generator of `count` units that each hold the thread for `ms`. */
function* units(progress: { done: number }, count: number, ms: number): Generator<void, void> {
  for (let index = 0; index < count; index += 1) {
    hold(ms)
    progress.done += 1
    if (index < count - 1) yield
  }
}

/** Waits for the timer turn of the event loop, where a pending slice ends. */
function nextTimerTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("runInTaskSlices", () => {
  it("shares one slice budget between runners that start in the same task", async () => {
    // A pending slice from earlier work ends before this test starts its own task.
    await nextTimerTurn()
    const unitMs = SLOW_UNIT_BUDGET_MS + 1
    const first = { done: 0 }
    const second = { done: 0 }
    const firstRun = runInTaskSlices("test:runner", units(first, 2, unitMs))
    const secondRun = runInTaskSlices("test:runner", units(second, 2, unitMs))
    // The first runner spent the budget of this task with one unit, so the
    // second waits for a later task. A budget for each runner would let it run.
    expect(first.done).toBe(1)
    expect(second.done).toBe(0)
    await Promise.all([firstRun, secondRun])
    expect([first.done, second.done]).toEqual([2, 2])
  })

  it("gives a runner that starts later a turn before a long runner finishes", async () => {
    await nextTimerTurn()
    const longUnits = 8 * SLOW_UNIT_BUDGET_MS
    const long = { done: 0 }
    const longRun = runInTaskSlices("test:runner", units(long, longUnits, 1))
    await nextTimerTurn()
    const short = { done: 0 }
    let longDoneWhenShortFinished = -1
    const shortRun = runInTaskSlices("test:runner", units(short, 2, 1)).then(() => { longDoneWhenShortFinished = long.done })
    await Promise.all([longRun, shortRun])
    // The runners take turns in arrival order, so the short runner waits a few slices at most.
    expect(longDoneWhenShortFinished).toBeGreaterThanOrEqual(0)
    expect(longDoneWhenShortFinished).toBeLessThanOrEqual(5 * SLOW_UNIT_BUDGET_MS)
  })

  it("gives waiting runners turns in arrival order, also after a runner finishes with the slice spent", async () => {
    await nextTimerTurn()
    const unitMs = SLOW_UNIT_BUDGET_MS + 1
    const order: number[] = []
    function* logged(runner: number): Generator<void, void> {
      for (let index = 0; index < 2; index += 1) {
        hold(unitMs)
        order.push(runner)
        if (index < 1) yield
      }
    }
    // Each unit spends the slice. Runner 0 finishes with the slice spent, and
    // the waiting runners still get their turns in arrival order. A runner that
    // spends a slice goes behind the runners that wait.
    await Promise.all([0, 1, 2].map((runner) => runInTaskSlices("test:runner", logged(runner))))
    expect(order).toEqual([0, 0, 1, 2, 1, 2])
  })

  it("starts a new slice in the next host task", async () => {
    await nextTimerTurn()
    const first = { done: 0 }
    await runInTaskSlices("test:runner", units(first, 2, SLOW_UNIT_BUDGET_MS + 1))
    await nextTimerTurn()
    const second = { done: 0 }
    const secondRun = runInTaskSlices("test:runner", units(second, 2, 1))
    // The spent slice of the earlier task does not hold the first unit back.
    expect(second.done).toBeGreaterThanOrEqual(1)
    await secondRun
    expect(second.done).toBe(2)
  })

  it("runs a turn after a spent slice ends, and names each unit in the lag meter", async () => {
    await nextTimerTurn()
    const debug = spyOn(Log.create({ service: "event-loop-lag" }), "debug").mockImplementation(() => {})
    try {
      // A run of units can pass the budget by one unit, so the meter calls a
      // run slow only at twice the budget.
      const slowMs = 2 * SLOW_UNIT_BUDGET_MS + 1
      const sliced = { done: 0 }
      const slicedRun = runInTaskSlices("test:sliced", units(sliced, 1, slowMs))
      let turnRan = false
      const turnRun = runInTaskTurn("test:turn", () => {
        hold(slowMs)
        turnRan = true
        return "parsed"
      })
      // The sliced runner spent the slice of this task, so the turn waits for a later task.
      expect(turnRan).toBe(false)
      expect(await turnRun).toBe("parsed")
      await slicedRun
      const slowUnits = debug.mock.calls.filter(([message]) => message === "slow loop unit").map(([, fields]) => fields)
      expect(slowUnits).toEqual([
        { kind: "task-slice", name: "test:sliced", durationMs: expect.any(Number) },
        { kind: "task-slice", name: "test:turn", durationMs: expect.any(Number) },
      ])
    } finally {
      debug.mockRestore()
    }
  })

  it("probes each run of units in one slice once, not each unit", async () => {
    const probe = spyOn(eventLoopLag, "probeLoopUnit")
    try {
      let clock = 0
      const progress = { done: 0 }
      // Each clock read advances a quarter of the budget, so four units fill a slice.
      const result = await runInTaskSlices("test:runner", (function* () {
        for (let index = 0; index < 8; index += 1) {
          progress.done += 1
          if (index < 7) yield
        }
        return progress.done
      })(), {
        now: () => (clock += SLOW_UNIT_BUDGET_MS / 4),
        yieldToNextTask: async () => {},
      })
      expect(result).toBe(8)
      expect(probe.mock.calls.map(([kind, name]) => `${kind}:${name}`)).toEqual(["task-slice:test:runner", "task-slice:test:runner"])
    } finally {
      probe.mockRestore()
    }
  })

  it("gives an injected clock and yield a slice of its own that restarts after each injected yield", async () => {
    let clock = 0
    const order: string[] = []
    const progress = { done: 0 }
    const work = (function* () {
      for (let index = 0; index < 3; index += 1) {
        progress.done += 1
        order.push(`unit ${index}`)
        if (index < 2) yield
      }
      return "done"
    })()
    const result = await runInTaskSlices("test:runner", work, {
      now: () => (clock += SLOW_UNIT_BUDGET_MS),
      yieldToNextTask: async () => { order.push("yield") },
    })
    expect(result).toBe("done")
    expect(order).toEqual(["unit 0", "yield", "unit 1", "yield", "unit 2"])
  })
})
