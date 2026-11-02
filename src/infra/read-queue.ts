import { createOrderedLane } from "./ordered-lane.js"

/** Serial reads of one cursor, with the callers that wait coalesced.
 *
 *  A caller that asks for the current state must see every commit made before
 *  it asked. A read that already started can have captured its position before
 *  that commit, so a caller never joins it. A caller joins only the read that
 *  waits behind the running one, which starts after the call and so captures a
 *  position that covers it. A burst of callers therefore costs at most one more
 *  read, and no caller gets a state older than its call. */
export interface ReadQueue<T> {
  /** The state read by a read that starts after this call. */
  read(): Promise<T>
  /** Runs `task` after every earlier read and task. A push-fed owner uses it
   *  to fold through a position it was given, in order with its reads. */
  run(task: () => Promise<T>): Promise<T>
  /** Resolves once every read and task queued before this call has finished.
   *  It never rejects. */
  settled(): Promise<void>
  /** True while a read or task waits behind the running one. */
  contended(): boolean
}

/** `readCurrent` must capture its read position after it starts, never reuse
 *  one captured earlier. `onIdle` runs when no read or task remains, for an
 *  owner that keeps one queue for each key. */
export function createReadQueue<T>(readCurrent: () => Promise<T>, onIdle?: () => void): ReadQueue<T> {
  const lane = createOrderedLane(onIdle)
  let waiting: Promise<T> | undefined

  function read(): Promise<T> {
    if (waiting) return waiting
    const result = lane.run(() => {
      // The read starts now, so a later caller must not join it.
      waiting = undefined
      return readCurrent()
    })
    waiting = result
    return result
  }

  return { read, run: (task) => lane.run(task), settled: () => lane.settled(), contended: () => lane.contended() }
}
