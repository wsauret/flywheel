import { Log } from "../../../infra/diagnostics/log.js"
import { createSqliteEventStore } from "../../../infra/substrate/store/sqlite-event-store.js"
import { CorruptEventRowError } from "../../../infra/substrate/store/event-store-types.js"
import { projectProjectNotifications } from "./projection.js"

const NOTIFICATION_FACT_TYPES = ["project.notification.raised", "project.notification.resolved", "project.notification.dismissed"]

const log = Log.create({ service: "project-notification-recovery" })

interface ProjectNotificationRecoveryResult {
  readonly discardedFacts: number
}

/** Strictly replays one notification aggregate before its journal opens it.
 *  Any failure retires the complete disposable aggregate instead of blocking
 *  startup (ARCH-SUBSTRATE-014). Runs on its own short-lived connection, so
 *  the deletion is one local transaction the runtime's writer lane never
 *  interleaves with. */
export function recoverProjectNotificationHistory(dbFile: string, aggregateId: string): ProjectNotificationRecoveryResult {
  return recover(dbFile, () => [aggregateId])
}

/** Strictly replays every notification aggregate of one store at startup:
 *  the project's, and those of the auth profiles a standalone host keeps in
 *  the project store. Each aggregate that fails is retired whole. */
export function recoverNotificationStore(dbFile: string): ProjectNotificationRecoveryResult {
  // The scan only finds the aggregates, so it reads rows it cannot decode
  // too; each aggregate's own strict read below decides its fate.
  return recover(dbFile, (store) => new Set(store.readTolerant({ types: NOTIFICATION_FACT_TYPES })
    .map((row) => row instanceof CorruptEventRowError ? row.row.aggregateId : row.aggregateId)))
}

type NotificationStore = ReturnType<typeof createSqliteEventStore>

function recover(dbFile: string, aggregateIds: (store: NotificationStore) => Iterable<string>): ProjectNotificationRecoveryResult {
  const store = createSqliteEventStore(dbFile)
  let discardedFacts = 0
  const failures: Array<{ readonly aggregateId: string; readonly discardedFacts: number; readonly failureType: string }> = []
  try {
    store.transaction(() => {
      for (const aggregateId of aggregateIds(store)) {
        try {
          projectProjectNotifications(store.read({ aggregateId }), Date.now(), aggregateId)
        } catch (error) {
          const discarded = store.deleteAggregate(aggregateId)
          discardedFacts += discarded
          failures.push({ aggregateId, discardedFacts: discarded, failureType: error instanceof Error ? error.name : typeof error })
        }
      }
    })
  } finally {
    store.close()
  }
  for (const failure of failures) log.warn("discarded malformed project notification history", failure)
  return { discardedFacts }
}
