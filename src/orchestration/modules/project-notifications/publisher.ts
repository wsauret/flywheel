import type { StoredFact } from "../../../infra/event-store-types.js"
import { projectNotificationsCursor, type ProjectNotificationPatchPayload } from "../../../protocol/modules/project-notifications.js"
import type { RuntimeUiPatchInput } from "../../../protocol/runtime-ui-protocol-types.js"
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

const scheduleInterval = (reconcile: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(reconcile, intervalMs)
  return () => clearInterval(timer)
}

/** Publishes the journal's newly folded facts and polls for commits made through other SQLite connections. */
export function createProjectNotificationPublisher(deps: ProjectNotificationPublisherDeps): ProjectNotificationPublisher {
  let accepting = true
  let publishedSeq = -1
  let tail = Promise.resolve()
  const failures: unknown[] = []
  const own = (read: () => Promise<readonly StoredFact[]>): Promise<void> => {
    const task = tail.then(read).then(publishFacts)
    tail = task.catch((error: unknown) => { failures.push(error) })
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
      if (failures.length) throw new AggregateError(failures, "Notification publication failed")
    },
    closeAdmission() {
      if (!accepting) return
      accepting = false
      cancelSchedule()
      unsubscribe()
    },
  }
}
