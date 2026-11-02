import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { durationMs } from "../../infra/operation-log.js"
import type { SessionManager } from "./manager.js"

/** Reconciles stale-active sessions to a stationary posture after startup. Workflows remain inactive until the user resumes them.
 *  One record when it settles: at the default level when it changed a
 *  session, and at DEBUG when it found nothing to do, which is every startup
 *  after a clean stop. */
export function queueStartupRecovery(manager: Pick<SessionManager, "recoverStaleSessions">, logger: Pick<typeof Log.Default, "info" | "debug">): () => void {
  const timer = setTimeout(() => {
    void (async () => {
      const started = performance.now()
      try {
        const recovered = await manager.recoverStaleSessions()
        const fields = { recovered, durationMs: durationMs(started) }
        if (recovered > 0) logger.info("session startup recovery done", fields)
        else logger.debug("session startup recovery done", fields)
      } catch (err) {
        Log.Default.warn("session startup recovery failed (non-fatal)", { error: errorMessage(err), errorDetail: errorDetail(err) })
      }
    })()
  }, 5_000)
  timer.unref()
  return () => clearTimeout(timer)
}
