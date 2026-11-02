import { createBoundedWorkerSpawner } from "./bounded-worker-spawner.js"
import { terminateWorker } from "./worker-termination.js"

/** Worker source for a clock that ends its own process when a bound expires.
 *  Its one message `{ target, delayMs, decision }` starts the countdown; on
 *  expiry it writes `decision` on fd 2, then sends SIGKILL to `target`.
 *
 *  The clock lives on its own thread because the host thread can be blocked
 *  in native work, such as one SQLite step, where no timer of its own can run.
 *  It signals the process because `process.exit()` inside a Worker ends only
 *  that Worker. The write is synchronous because a blocked host cannot drain a
 *  message. */
export const HARD_EXIT_CLOCK_URL = `data:text/javascript,${encodeURIComponent(`import { writeSync } from "node:fs"; addEventListener("message", (event) => { setTimeout(() => { try { writeSync(2, event.data.decision) } catch {} process.kill(event.data.target, "SIGKILL") }, event.data.delayMs) })`)}`

const spawnHardExitClock = createBoundedWorkerSpawner("hard-exit-clock")

/** Ends this process after `delayMs` even when its main thread never yields,
 *  writing `decision` on stderr first. `cancel` stops the countdown and
 *  resolves once the clock thread is released; a process that finishes in
 *  time must await it before it exits. Starts at most one clock
 *  per process. */
export function startHardExitClock(delayMs: number, decision: string) {
  const clock = spawnHardExitClock(HARD_EXIT_CLOCK_URL, { name: "flywheel-hard-exit-clock", ref: false, smol: true })
  clock.postMessage({ target: process.pid, delayMs, decision }, [])
  return { cancel: () => terminateWorker(clock) }
}
