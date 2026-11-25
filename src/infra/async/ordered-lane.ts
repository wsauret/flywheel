/** One ordered lane of async work: each task starts after every task queued
 *  before it has finished. A failed task surfaces to its caller and leaves the
 *  lane open, so one failed task never stops the tasks queued after it. */
export interface OrderedLane {
  run<T>(task: () => T | PromiseLike<T>): Promise<T>
  /** Resolves once every queued task has finished. It never rejects. */
  settled(): Promise<void>
  /** True while a task waits for an earlier one to finish, so a long task
   *  can give up its turn. */
  contended(): boolean
}

/** `onIdle` runs when no queued task remains, for an owner that keeps one
 *  lane for each key and evicts the lanes it no longer uses. It must not
 *  throw, because nothing awaits it. A caller that voids `run` must contain
 *  its own failure; use `createBackgroundLane` when it cannot. */
export function createOrderedLane(onIdle?: () => void): OrderedLane {
  let tail: Promise<void> = Promise.resolve()
  let waiting = 0
  return {
    run(task) {
      waiting += 1
      const result = tail.then(() => {
        waiting -= 1
        return task()
      })
      const settled = result.then(() => undefined, () => undefined)
      tail = settled
      if (onIdle) void settled.then(() => { if (tail === settled) onIdle() })
      return result
    },
    settled: () => tail,
    contended: () => waiting > 0,
  }
}
