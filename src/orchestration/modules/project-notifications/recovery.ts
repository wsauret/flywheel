import { Log } from "../../../infra/log.js"
import { createSqliteEventStore } from "../../../infra/sqlite-event-store.js"
import { PROJECT_NOTIFICATION_AGGREGATE_ID, projectProjectNotifications } from "./projection.js"

const log = Log.create({ service: "project-notification-recovery" })

interface ProjectNotificationRecoveryResult {
  readonly discardedFacts: number
}

/** Strictly replays notification history before the journal opens it. Any
 *  failure retires the complete disposable aggregate instead of blocking
 *  startup (ARCH-SUBSTRATE-014). Runs on its own short-lived connection, so
 *  the deletion is one local transaction the runtime's writer lane never
 *  interleaves with. */
export function recoverProjectNotificationHistory(dbFile: string): ProjectNotificationRecoveryResult {
  const store = createSqliteEventStore(dbFile)
  let discardedFacts = 0
  let failureType: string | undefined
  try {
    store.transaction(() => {
      try {
        projectProjectNotifications(store.read({ aggregateId: PROJECT_NOTIFICATION_AGGREGATE_ID }), Date.now())
      } catch (error) {
        failureType = error instanceof Error ? error.name : typeof error
        discardedFacts = store.deleteAggregate(PROJECT_NOTIFICATION_AGGREGATE_ID)
      }
    })
  } finally {
    store.close()
  }
  if (failureType !== undefined) {
    log.warn("discarded malformed project notification history", { discardedFacts, failureType })
  }
  return { discardedFacts }
}
