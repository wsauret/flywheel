import type { StoredFact } from "../../../infra/substrate/store/event-store-types.js"
import { Log } from "../../../infra/diagnostics/log.js"
import { coalesceRepeats } from "../../../infra/diagnostics/repeat-coalescer.js"
import { projectNotificationsCursor, type ProjectNotificationPatchPayload } from "../../../protocol/modules/project-notifications.js"
import type { RuntimeUiPatchInput } from "../../../protocol/runtime/runtime-ui-protocol-types.js"
import { parseProjectNotificationFact } from "./facts.js"
import type { ProjectNotificationJournal } from "./journal.js"

export interface ProjectNotificationPublisher {
  /** Folds and publishes what other connections committed; the snapshot runs it first so its position covers the commits. */
  reconcile(): Promise<void>
  settled(): Promise<void>
  closeAdmission(): void
}

interface ProjectNotificationPublisherDeps {
  readonly journal: ProjectNotificationJournal
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly publish: (patch: RuntimeUiPatchInput) => void
  readonly intervalMs?: number
  readonly schedule?: (reconcile: () => void, intervalMs: number) => () => void
}

const log = Log.create({ service: "project-notification-publisher" })

/** A failing journal read or publish usually keeps failing on every poll, so
 *  one count an hour shows that it continues without filling the log. */
const FAILURE_WINDOW_MS = 60 * 60_000

const scheduleInterval = (reconcile: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(reconcile, intervalMs)
  return () => clearInterval(timer)
}

/** Publishes the journal's newly folded facts and polls for commits made through other SQLite connections. */
export function createProjectNotificationPublisher(deps: ProjectNotificationPublisherDeps): ProjectNotificationPublisher {
  let accepting = true
  let publishedSeq = -1
  let tail = Promise.resolve()
  // Shutdown only needs to know that publication failed, so the first failure
  // and a count keep that contract in constant memory while a poll fails once
  // a second for the life of the project.
  let failed: { readonly first: unknown; count: number } | undefined
  const failures = coalesceRepeats<string>({
    windowMs: FAILURE_WINDOW_MS,
    first: (_condition, errorType) => log.warn("notification publication failed", { errorType }),
    repeated: (_condition, repeats) => log.warn("notification publication failures repeated", { count: repeats.count, windowMs: repeats.windowMs }),
  })
  const own = (read: () => Promise<readonly StoredFact[]>): Promise<void> => {
    const task = tail.then(read).then(publishFacts)
    tail = task.then(
      () => failures.end(),
      (error: unknown) => {
        if (failed) failed.count += 1
        else failed = { first: error, count: 1 }
        failures.observe("publication", error instanceof Error ? error.name : typeof error)
      },
    )
    return task
  }

  const publishFacts = (facts: readonly StoredFact[]): void => {
    for (const stored of facts) {
      if (stored.seq <= publishedSeq) continue
      const fact = parseProjectNotificationFact({ type: stored.type, version: stored.version, actor: stored.actor, payload: stored.payload })
      let payload: ProjectNotificationPatchPayload
      if (fact.type === "project.notification.raised") {
        const episode = deps.journal.projection().episodes.find((candidate) => candidate.id === stored.id)
        if (!episode) throw new Error(`Folded project notification is missing: ${stored.id}`)
        payload = { kind: "project_notifications.raised", episode }
      } else if (fact.type === "project.notification.resolved") {
        payload = { kind: "project_notifications.resolved", ...fact.payload, resolvedAt: stored.timestamp }
      } else {
        payload = { kind: "project_notifications.dismissed", ...fact.payload, dismissedAt: stored.timestamp }
      }
      deps.publish({ cursor: projectNotificationsCursor(), payload })
      publishedSeq = stored.seq
    }
  }

  const reconcile = (): Promise<void> => {
    return accepting ? own(() => deps.journal.reconcile()) : Promise.resolve()
  }
  const unsubscribe = deps.onStored((events) => {
    if (accepting) void own(() => deps.journal.observe(events)).catch(() => {})
  })
  void reconcile().catch(() => {})
  const cancelSchedule = (deps.schedule ?? scheduleInterval)(() => { void reconcile().catch(() => {}) }, deps.intervalMs ?? 1_000)

  return {
    reconcile,
    async settled() {
      await tail
      failures.end()
      if (failed) throw new Error(`Notification publication failed ${failed.count} times`, { cause: failed.first })
    },
    closeAdmission() {
      if (!accepting) return
      accepting = false
      cancelSchedule()
      unsubscribe()
    },
  }
}
