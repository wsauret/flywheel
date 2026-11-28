import { Log } from "../../../infra/diagnostics/log.js"
import type { NotificationEpisodeInput } from "../../../infra/substrate/events/notification-episode.js"
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
 *  to its own input. An input that names an auth profile lands in that
 *  profile's journal; any other lands in the project's. */
export function createProjectNotificationSink(input: {
  readonly journal: SinkJournal
  readonly profileJournal: (profileId: string) => SinkJournal
  /** Retires the project's own episodes of sources a profile now names. */
  readonly retireProjectCopies: (sourceIds: Iterable<string>) => Promise<void>
}): ProjectNotificationSink {
  let accepting = true
  let tail = Promise.resolve()
  let settle = (): void => {}
  const settlement = new Promise<void>((resolve) => { settle = resolve })

  const resolveIfActive = async (journal: SinkJournal, sourceId: string): Promise<void> => {
    if ((await journal.activeSourceIds()).has(sourceId)) await journal.resolve(sourceId)
  }

  const applyTo = async (journal: SinkJournal, episode: NotificationEpisodeInput): Promise<void> => {
    if (episode.type === "raise") {
      await journal.raise(episode.occurrence)
      return
    }
    if (episode.type === "resolve") {
      await resolveIfActive(journal, episode.sourceId)
      return
    }
    const desired = new Map(episode.desired.map((occurrence) => [occurrence.sourceId, occurrence]))
    const keep = episode.keep ?? []
    for (const sourceId of await journal.activeSourceIds()) {
      if (!sourceId.startsWith(episode.prefix) || desired.has(sourceId) || keep.some((prefix) => sourceId.startsWith(prefix))) continue
      await journal.resolve(sourceId)
    }
    for (const occurrence of desired.values()) await journal.raise(occurrence)
  }

  /** The sources a profile statement names. Of a reconcile, these are the
   *  ones it states and the project's active ones under its prefix. */
  const namedSources = async (episode: NotificationEpisodeInput): Promise<readonly string[]> => {
    if (episode.type === "raise") return [episode.occurrence.sourceId]
    if (episode.type === "resolve") return [episode.sourceId]
    const active = [...await input.journal.activeSourceIds()].filter((sourceId) => sourceId.startsWith(episode.prefix) && !(episode.keep ?? []).some((prefix) => sourceId.startsWith(prefix)))
    return [...new Set([...episode.desired.map((occurrence) => occurrence.sourceId), ...active])]
  }

  const applyInput = async (episode: NotificationEpisodeInput): Promise<void> => {
    if (episode.profileId === undefined) {
      await applyTo(input.journal, episode)
      return
    }
    await applyTo(input.profileJournal(episode.profileId), episode)
    await input.retireProjectCopies(await namedSources(episode))
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
