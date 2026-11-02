import { errorMessage } from "./error-message.js"
import { Log } from "./log.js"
import { recordTermination } from "./process-container.js"
import { withDeadline } from "./with-deadline.js"

// The supervisor's service, because project executors relay its records by
// service name.
const log = Log.create({ service: "process-supervisor" })

interface EndingProcess {
  readonly pid: number
  readonly exited: Promise<unknown>
  kill(signal: "SIGKILL"): void
}

/** Ends one process and proves it: waits for it to exit on its own, kills it
 *  when it overruns that wait, then waits for the kill to land under a final
 *  bound. Reports why the process could not be proven gone, or nothing once it
 *  exited. A kill is a request the operating system may not have completed, so
 *  it is never read as an exit. */
export async function proveProcessEnded(target: EndingProcess, exitDeadlineMs: number, killDeadlineMs: number): Promise<string | undefined> {
  try {
    await withDeadline(target.exited, exitDeadlineMs)
    return undefined
  } catch (err) {
    log.warn("a process did not exit within its deadline; killing it", { error: errorMessage(err) })
  }
  recordTermination({ container: target.pid, target: target.pid, signal: "SIGKILL", reason: "process exit deadline exceeded" })
  target.kill("SIGKILL")
  try {
    await withDeadline(target.exited, killDeadlineMs)
    return undefined
  } catch (err) {
    return `it was still running ${killDeadlineMs}ms after its kill: ${errorMessage(err)}`
  }
}
