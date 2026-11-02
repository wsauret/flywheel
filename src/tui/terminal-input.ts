import { errnoCode, errorDetail, errorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"

const log = Log.create({ service: "terminal-input" })

/** Read failures that mean the terminal itself is gone. When the shell that
 *  owns the terminal exits (its window or pane closed, or it was killed), the
 *  kernel revokes the terminal, and every later read of it fails with EIO. */
const TERMINAL_GONE_CODES = new Set(["EIO"])

/** Gives the renderer's terminal input the error listener that it does not
 *  have. Without one, a failed read of standard input is an uncaught
 *  exception.
 *
 *  A gone terminal is an expected end: it records one INFO record. The
 *  listener does not start the exit. The hangup that revokes the terminal
 *  also sends SIGHUP, and the parent-death watchdog covers a parent that dies
 *  without a signal. Both run the graceful exit, and a second exit request
 *  while that exit runs would end the process before its cleanup finishes.
 *  Any other read failure records one ERROR record. */
export function watchTerminalInput(input: { on(event: "error", listener: (error: Error) => void): void }): void {
  input.on("error", (error) => {
    const code = errnoCode(error)
    if (code !== undefined && TERMINAL_GONE_CODES.has(code)) {
      log.info("terminal input closed", { code })
      return
    }
    log.error("terminal input failed", { error: errorMessage(error), errorDetail: errorDetail(error) })
  })
}
