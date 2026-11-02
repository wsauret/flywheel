import { probeLoopUnit, SLOW_UNIT_BUDGET_MS } from "./event-loop-lag.js"

/** The lag meter kind of every unit that runs on the shared slice clock. The
 *  runner's name follows it, so a stall record names the work behind it. */
const TASK_SLICE_UNIT_KIND = "task-slice"

/** Lets already-scheduled work run before the caller starts its next bounded unit. */
export function yieldToNextTask(): Promise<void> {
  return Bun.sleep(0)
}

/** Clock and yield seams. Tests replace them to stop the work at a known yield.
 *  A scheduling that replaces either seam owns its task boundary: it gets a
 *  slice of its own that starts at the first unit of the runner and restarts
 *  after each injected yield. */
export interface TaskSliceScheduling {
  readonly now?: () => number
  readonly yieldToNextTask?: () => Promise<void>
}

interface TaskSlice {
  /** Milliseconds the current slice has run. The first read in a slice starts it. */
  elapsed(): number
  /** Resolves when the runner may start its next unit in a slice that has budget left. */
  nextTurn(): Promise<void>
  /** Gives the rest of the slice to the next waiting runner when a runner finishes. */
  finish(): void
}

let hostSliceStartedAt: number | undefined
/** Runners that wait for the host slice, in the order they asked for a turn. */
const waitingRunners: Array<() => void> = []
let turnScheduled = false

function endHostSlice(): void {
  hostSliceStartedAt = undefined
}

/** True until the timer armed at the start of the slice ends it. */
function hostSliceIsOpen(): boolean {
  return hostSliceStartedAt !== undefined
}

/** Gives the first waiting runner a new slice once the timer has ended the
 *  current one. The timer was armed when the slice started, so it is usually
 *  due when the slice is spent and the wait takes one or two hops. */
async function startNextHostTurn(): Promise<void> {
  do await yieldToNextTask()
  while (hostSliceIsOpen())
  turnScheduled = false
  waitingRunners.shift()?.()
}

function hostSliceHasBudget(): boolean {
  return hostSliceStartedAt !== undefined && performance.now() - hostSliceStartedAt < SLOW_UNIT_BUDGET_MS
}

/** Gives the first waiting runner the rest of the current slice, or a new
 *  slice in a later task when the current one is spent. */
function handOffHostSlice(): void {
  if (waitingRunners.length === 0) return
  if (hostSliceHasBudget()) {
    waitingRunners.shift()?.()
    return
  }
  if (turnScheduled) return
  turnScheduled = true
  void startNextHostTurn()
}

/** The slice that every runner without injected seams shares, so concurrent
 *  runners in one host task spend one budget, not one budget each. It starts at
 *  the first unit in a host task, and the zero-delay timer armed there ends it,
 *  so a runner that starts in a later task gets a new slice. The timer never
 *  holds the process open, an idle process holds no timer, and a unit costs one
 *  clock read.
 *
 *  Runners that find the slice spent wait in arrival order, and a runner that
 *  spends the slice goes behind them. When the timer has ended the slice, the
 *  first waiting runner gets the next one, so a short runner never waits for a
 *  long runner to finish. A runner that finishes gives the rest of its slice to
 *  the next waiting runner in the same task. A runner that starts after the
 *  timer ended the slice, and before the next turn, starts the new slice itself
 *  without a wait. When it spends that slice, it goes behind the waiting runners.
 *
 *  Only the timer ends a slice. Bun runs Bun.sleep(0) resumes and immediates
 *  before due timers, so a slice that started at such a resume, or that ended
 *  in an immediate, let two slices run before a due 5 ms interval (measured
 *  with Bun 1.4: gaps of 16 to 18 ms instead of 8 to 9 ms). The turn waits for
 *  that timer with Bun.sleep(0), not with a timer of its own, because a timer
 *  armed when the slice is spent waits at least 1 ms more: such turns made 50
 *  slices of work 14% slower. */
const hostSlice: TaskSlice = {
  elapsed() {
    const now = performance.now()
    if (hostSliceStartedAt === undefined) {
      hostSliceStartedAt = now
      setTimeout(endHostSlice, 0).unref()
      return 0
    }
    return now - hostSliceStartedAt
  },
  async nextTurn() {
    // A runner that was given a turn can find the slice spent again when a new
    // runner started first. It then keeps its place at the front.
    for (let given = false; ; given = true) {
      await new Promise<void>((resolve) => {
        if (given) waitingRunners.unshift(resolve)
        else waitingRunners.push(resolve)
        handOffHostSlice()
      })
      if (hostSlice.elapsed() < SLOW_UNIT_BUDGET_MS) return
    }
  },
  finish: handOffHostSlice,
}

function injectedSlice(scheduling: TaskSliceScheduling): TaskSlice {
  const now = scheduling.now ?? performance.now.bind(performance)
  const yieldTask = scheduling.yieldToNextTask ?? yieldToNextTask
  let startedAt: number | undefined
  const slice: TaskSlice = {
    elapsed() {
      const at = now()
      startedAt ??= at
      return at - startedAt
    },
    async nextTurn() {
      do {
        await yieldTask()
        startedAt = undefined
      } while (slice.elapsed() >= SLOW_UNIT_BUDGET_MS)
    },
    finish() {},
  }
  return slice
}

/** Runs one step of work at a time until a step is done. The steps run in
 *  runs: a run starts in a slice with budget and ends at the first step that
 *  finishes past SLOW_UNIT_BUDGET_MS, or at the last step. Each run is one
 *  probed unit, so a stall names the work at the cost of one probe for each
 *  slice, not one for each step. A run can pass the budget by one step, so a
 *  run counts as slow only at twice the budget, which only a step longer than
 *  the budget can cause. */
async function runSteps<T>(name: string, slice: TaskSlice, step: () => IteratorResult<void, T>): Promise<T> {
  const runUntilSpent = (): IteratorResult<void, T> => {
    for (;;) {
      const result = step()
      if (result.done === true || slice.elapsed() >= SLOW_UNIT_BUDGET_MS) return result
    }
  }
  try {
    if (slice.elapsed() >= SLOW_UNIT_BUDGET_MS) await slice.nextTurn()
    for (;;) {
      const result = probeLoopUnit(TASK_SLICE_UNIT_KIND, name, runUntilSpent, 2 * SLOW_UNIT_BUDGET_MS)
      if (result.done === true) return result.value
      await slice.nextTurn()
    }
  } finally {
    slice.finish()
  }
}

/** Run one generator in task slices. Each `yield` in the work marks a point
 *  between two bounded units. Before each unit, including the first, the
 *  runner gives the task queue a turn if the shared slice of the current host
 *  task has reached SLOW_UNIT_BUDGET_MS. Runners that start or resume in one
 *  host task share that slice and take turns in arrival order, so a runner that
 *  starts after others spent the budget waits for a later task before its first
 *  unit. Each run of units in one slice reports to the event-loop lag meter as
 *  `task-slice:<name>`, so a stall that sliced work joins names that work. */
export function runInTaskSlices<T>(name: string, work: Generator<void, T>, scheduling: TaskSliceScheduling = {}): Promise<T> {
  const slice = scheduling.now === undefined && scheduling.yieldToNextTask === undefined ? hostSlice : injectedSlice(scheduling)
  return runSteps(name, slice, () => work.next())
}

/** Run one synchronous unit that cannot be divided, such as one parse of a
 *  received body, as a turn of the shared host slice. The unit waits until the
 *  slice of the current host task has budget, so at most one such unit joins
 *  each spent slice, and it reports to the lag meter as `task-slice:<name>`. */
export function runInTaskTurn<T>(name: string, unit: () => T): Promise<T> {
  return runSteps(name, hostSlice, () => ({ done: true, value: unit() }))
}

/** Run the same generator without yielding, for synchronous and offline readers. */
export function runToCompletion<T>(work: Generator<void, T>): T {
  for (;;) {
    const step = work.next()
    if (step.done) return step.value
  }
}
