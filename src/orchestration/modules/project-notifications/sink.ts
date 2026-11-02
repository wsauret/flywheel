import { Log } from "../../../infra/log.js"
import type { NotificationEpisodeInput } from "../../../infra/notification-episode.js"
import type { ProjectNotificationJournal } from "./journal.js"

const log = Log.create({ service: "project-notification-sink" })

type SinkJournal = Pick<ProjectNotificationJournal, "raise" | "resolve" | "activeSourceIds">

export interface ProjectNotificationSink {
  /** Admits one seam input onto the ordered append lane and answers once the
   *  journal has applied it. Rejects after admission closes. */
  apply(input: NotificationEpisodeInput): Promise<void>
  closeAdmission(): void
  settled(): Promise<void>
}

/** Owns ordered notification journal appends accepted by one runtime
 *  generation. Every input is applied in admission order, so a raise and the
 *  resolve that follows it cannot land reversed, and a failure is contained
 *  to its own input. */
export function createProjectNotificationSink(input: { readonly journal: SinkJournal }): ProjectNotificationSink {
  let accepting = true
  let tail = Promise.resolve()
  let settle = (): void => {}
  const settlement = new Promise<void>((resolve) => { settle = resolve })

  const resolveIfActive = async (sourceId: string): Promise<void> => {
    if ((await input.journal.activeSourceIds()).has(sourceId)) await input.journal.resolve(sourceId)
  }

  const applyInput = async (episode: NotificationEpisodeInput): Promise<void> => {
    if (episode.type === "raise") {
      await input.journal.raise(episode.occurrence)
      return
    }
    if (episode.type === "resolve") {
      await resolveIfActive(episode.sourceId)
      return
    }
    const desired = new Map(episode.desired.map((occurrence) => [occurrence.sourceId, occurrence]))
    const keep = episode.keep ?? []
    for (const sourceId of await input.journal.activeSourceIds()) {
      if (!sourceId.startsWith(episode.prefix) || desired.has(sourceId) || keep.some((prefix) => sourceId.startsWith(prefix))) continue
      await input.journal.resolve(sourceId)
    }
    for (const occurrence of desired.values()) await input.journal.raise(occurrence)
  }

  const apply = (episode: NotificationEpisodeInput): Promise<void> => {
    if (!accepting) {
      log.warn("notification append rejected after admission closed", { operation: episode.type })
      return Promise.reject(new Error("notification admission is closed"))
    }
    const pending = tail.then(() => applyInput(episode))
    tail = pending.catch(() => {
      log.warn("notification journal append failed", { operation: episode.type })
    })
    return pending
  }

  const closeAdmission = (): void => {
    if (!accepting) return
    accepting = false
    void tail.then(settle)
  }

  return {
    apply,
    closeAdmission,
    settled: () => { closeAdmission(); return settlement },
  }
}
