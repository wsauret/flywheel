import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { describeStartFailure, type PrepareAccountResult } from "./supervisor.js"

interface RuntimeRecovery {
  /** The find-or-start a connection asks for when it found nothing listening
   *  where the runtime was. Concurrent askers share one run, and an ask while
   *  the host's own connection is connected runs nothing. A rejection carries
   *  the start's own reason. */
  readonly ensureRuntime: () => Promise<void>
  /** Told each state of the host's own connection, so the log shows the
   *  reconnect that follows a loss as well as the loss, and so an ask that
   *  arrives after the service answers again does not start it again. */
  readonly observeState: (state: RuntimeConnection["state"]) => void
}

/** The host's one find-or-start after a lost runtime, shared by the host's
 *  connection and the client's: the runtime's own `serve ensure`, one run at
 *  a time. The client's connection reaches the same socket through the host,
 *  and it often asks only after the host's run has finished and the host has
 *  connected again. The host's connected connection is the evidence that the
 *  service listens, so that late ask resolves at once and the client simply
 *  connects again. */
export function createRuntimeRecovery(options: {
  readonly ensure: () => Promise<PrepareAccountResult>
  readonly log: { info(line: string): void }
}): RuntimeRecovery {
  let ensuring: Promise<void> | undefined
  let reconnecting = false
  let connected = false
  return {
    ensureRuntime: () => {
      if (connected && ensuring === undefined) {
        options.log.info("a client connection found nothing listening, but the host is connected to the account service; the client connects again")
        return Promise.resolve()
      }
      ensuring ??= (async () => {
        reconnecting = true
        options.log.info("a runtime connection found nothing listening; finding or starting the account service")
        const result = await options.ensure()
        if (!result.ok) throw new Error(describeStartFailure(result.failure))
      })().finally(() => { ensuring = undefined })
      return ensuring
    },
    observeState: (state) => {
      connected = state === "connected"
      if (!connected || !reconnecting) return
      reconnecting = false
      options.log.info("reconnected to the account service after a connection found nothing listening")
    },
  }
}
