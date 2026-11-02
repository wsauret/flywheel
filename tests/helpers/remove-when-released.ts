import { rmSync } from "node:fs"

/** Remove a directory once the processes that held it have released it.
 *
 *  A kill returns before Windows has released the terminated process's
 *  handles, and a process that has exited can still hold them for a moment, so
 *  the removal can be refused as busy. POSIX unlinks a directory a dead
 *  process held right away. Retrying within a bound removes the directory on
 *  both instead of leaving it behind on one. The last error is thrown when the
 *  bound passes, so a handle that is never released is reported, never
 *  hidden. */
export function removeWhenReleased(dir: string, timeoutMs = 10_000): void {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      Bun.sleepSync(25)
    }
  }
}
