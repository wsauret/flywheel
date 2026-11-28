import type { StoredFact } from "../../../infra/substrate/store/event-store-types.js"
import { Log } from "../../../infra/diagnostics/log.js"
import { coalesceRepeats } from "../../../infra/diagnostics/repeat-coalescer.js"
import type { ProjectNotificationPatchPayload } from "../../../protocol/modules/project-notifications.js"
import { parseProjectNotificationFact } from "./facts.js"
import type { ProjectNotificationJournal } from "./journal.js"

export interface ProjectNotificationPublisher {
  /** Folds and publishes what other connections committed; the snapshot runs it first so its position covers the commits. The first catch-up of the retained history publishes nothing. */
  reconcile(): Promise<void>
  /** Hears each newly folded fact of the journal once, as a patch payload, until the returned function runs. */
  subscribe(listener: (payload: ProjectNotificationPatchPayload) => void): () => void
  settled(): Promise<void>
  closeAdmission(): void
}

interface ProjectNotificationPublisherDeps {
  readonly journal: ProjectNotificationJournal
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
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

/** Turns the journal's newly folded facts into patch payloads for every
 *  subscriber, and polls for commits made through other SQLite connections.
 *  One publisher serves every project that shows the journal, so a change
 *  folds and reads once however many projects show it. */
export function createProjectNotificationPublisher(deps: ProjectNotificationPublisherDeps): ProjectNotificationPublisher {
  let accepting = true
  let publishedSeq = -1
  let tail = Promise.resolve()
  const listeners = new Set<(payload: ProjectNotificationPatchPayload) => void>()
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

  // The first catch-up that succeeds folds the retained history in silence:
  // a subscriber reads that state from a snapshot, which waits for the
  // catch-up, so only what lands after it is news.
  let caughtUp = false
  const publishFacts = (facts: readonly StoredFact[]): void => {
    if (!caughtUp) {
      caughtUp = true
      publishedSeq = facts.reduce((seq, fact) => Math.max(seq, fact.seq), publishedSeq)
      return
    }
    for (const stored of facts) {
      if (stored.seq <= publishedSeq) continue
      const fact = parseProjectNotificationFact({ type: stored.type, version: stored.version, actor: stored.actor, payload: stored.payload })
      let payload: ProjectNotificationPatchPayload
      if (fact.type === "project.notification.raised") {
        const episode = deps.journal.episode(stored.id)
        if (!episode) throw new Error(`Folded project notification is missing: ${stored.id}`)
        payload = { kind: "project_notifications.raised", episode }
      } else if (fact.type === "project.notification.resolved") {
        payload = { kind: "project_notifications.resolved", ...fact.payload, resolvedAt: stored.timestamp }
      } else {
        payload = { kind: "project_notifications.dismissed", ...fact.payload, dismissedAt: stored.timestamp }
      }
      for (const listener of listeners) listener(payload)
      publishedSeq = stored.seq
    }
  }

  const reconcile = (): Promise<void> => {
    return accepting ? own(() => deps.journal.reconcile()) : Promise.resolve()
  }
  void reconcile().catch(() => {})
  const unsubscribe = deps.onStored((events) => {
    if (accepting) void own(() => deps.journal.observe(events)).catch(() => {})
  })
  const cancelSchedule = (deps.schedule ?? scheduleInterval)(() => { void reconcile().catch(() => {}) }, deps.intervalMs ?? 1_000)

  return {
    reconcile,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
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
