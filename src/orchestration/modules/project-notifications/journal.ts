import { capturedFacts, type AsyncEventReadSurface, type AsyncGuardedEventAppender, type StoredFact } from "../../../infra/event-store-types.js"
import type { NotificationOccurrence } from "../../../infra/notification-episode.js"
import type { ProjectNotificationEpisode, ProjectNotificationProjection } from "../../../protocol/modules/project-notifications.js"
import {
  emptyProjectNotificationProjectionState,
  materializeProjectNotificationProjection,
  PROJECT_NOTIFICATION_AGGREGATE_ID,
  PROJECT_NOTIFICATION_LIFETIME_MS,
  reduceProjectNotificationProjection,
} from "./projection.js"

export interface ProjectNotificationJournal {
  /** Records one occurrence, or answers the active one for an already raised source. */
  raise(input: NotificationOccurrence): Promise<ProjectNotificationEpisode>
  resolve(sourceId: string): Promise<void>
  dismiss(sourceId: string, episodeId?: string): Promise<void>
  /** Folds what other connections committed since the last read and answers the facts it applied. */
  reconcile(): Promise<readonly StoredFact[]>
  /** Folds a committed batch pushed by this connection's store. */
  observe(events: readonly StoredFact[]): Promise<readonly StoredFact[]>
  activeEpisode(sourceId: string): Promise<ProjectNotificationEpisode | undefined>
  activeSourceIds(): Promise<ReadonlySet<string>>
  projection(): ProjectNotificationProjection
}

interface ProjectNotificationJournalDeps {
  readonly reader: AsyncEventReadSurface
  readonly writer: AsyncGuardedEventAppender
  readonly sessionId: string
  readonly now?: () => number
}

/** Owns strict replay, guarded appends, and the only mutable in-memory projection of the project notification aggregate. */
export function createProjectNotificationJournal(deps: ProjectNotificationJournalDeps): ProjectNotificationJournal {
  const now = deps.now ?? Date.now
  let state = emptyProjectNotificationProjectionState()
  const reader = deps.reader
  let position = 0
  let replay = Promise.resolve<readonly StoredFact[]>([])

  const fold = (events: readonly StoredFact[]): StoredFact[] => {
    const applied: StoredFact[] = []
    for (const event of events) {
      if (event.aggregateId !== PROJECT_NOTIFICATION_AGGREGATE_ID || event.seq <= state.lastSeq) continue
      state = reduceProjectNotificationProjection(state, event)
      applied.push(event)
    }
    return applied
  }

  const reconcile = (): Promise<readonly StoredFact[]> => {
    const next = replay.then(async () => {
      const upper = await reader.capturePosition()
      const applied: StoredFact[] = []
      for await (const item of capturedFacts(reader, { aggregateId: PROJECT_NOTIFICATION_AGGREGATE_ID }, { upperPosition: upper, afterPosition: position })) {
        applied.push(...fold([item]))
      }
      position = upper
      return applied
    })
    replay = next.catch(() => [])
    return next
  }

  const append = async (type: "project.notification.resolved" | "project.notification.dismissed", sourceId: string, episodeId?: string): Promise<void> => {
    for (;;) {
      await reconcile()
      const activeEpisodeId = state.activeSources.get(sourceId)
      const targetEpisodeId = episodeId ?? activeEpisodeId ?? [...state.episodes.values()].findLast((episode) => episode.sourceId === sourceId)?.id
      const existing = targetEpisodeId === undefined ? undefined : state.episodes.get(targetEpisodeId)
      if (!existing || existing.sourceId !== sourceId) throw new Error(`Unknown project notification source: ${sourceId}`)
      if (episodeId !== undefined && existing.id !== episodeId) return
      if (type === "project.notification.resolved" ? existing.resolvedAt !== undefined : existing.dismissedAt !== undefined) return
      const result = await deps.writer.appendGuarded({
          aggregateId: PROJECT_NOTIFICATION_AGGREGATE_ID,
          type,
          version: 1,
          timestamp: now(),
          actor: "system",
          sessionId: deps.sessionId,
          payload: { sourceId, episodeId: existing.id },
          expectedSeq: state.lastSeq + 1,
      })
      if (result.kind === "stored") {
        const stored = result.events[0]
        if (!stored) throw new Error("Stored project notification resolution returned no fact")
        fold([stored])
        return
      }
    }
  }

  return {
    async raise(input) {
      for (;;) {
        await reconcile()
        const activeEpisodeId = state.activeSources.get(input.sourceId)
        const existing = activeEpisodeId === undefined ? undefined : state.episodes.get(activeEpisodeId)
        if (existing) return existing
        const createdAt = now()
        const result = await deps.writer.appendGuarded({
            aggregateId: PROJECT_NOTIFICATION_AGGREGATE_ID,
            type: "project.notification.raised",
            version: 1,
            timestamp: createdAt,
            actor: "system",
            sessionId: deps.sessionId,
            payload: { ...input, createdAt, expiresAt: createdAt + PROJECT_NOTIFICATION_LIFETIME_MS },
            expectedSeq: state.lastSeq + 1,
        })
        if (result.kind === "stored") {
          const stored = result.events[0]
          if (!stored) throw new Error("Stored project notification returned no fact")
          fold([stored])
          const raised = state.episodes.get(stored.id)
          if (!raised) throw new Error(`Stored project notification did not project: ${input.sourceId}`)
          return raised
        }
      }
    },
    resolve: (sourceId) => append("project.notification.resolved", sourceId),
    dismiss: (sourceId, episodeId) => append("project.notification.dismissed", sourceId, episodeId),
    reconcile,
    observe: async (events) => {
      const relevant = events.filter((event) => event.aggregateId === PROJECT_NOTIFICATION_AGGREGATE_ID)
      const applied = relevant.some((event) => event.seq > state.lastSeq + 1) ? [...await reconcile()] : []
      applied.push(...fold(relevant.toSorted((left, right) => left.seq - right.seq)))
      return [...applied, ...relevant.filter((event) => !applied.some((fact) => fact.id === event.id))]
    },
    activeEpisode: async (sourceId) => {
      await reconcile()
      const episodeId = state.activeSources.get(sourceId)
      return episodeId === undefined ? undefined : state.episodes.get(episodeId)
    },
    activeSourceIds: async () => {
      await reconcile()
      return new Set(state.activeSources.keys())
    },
    projection: () => materializeProjectNotificationProjection(state, now()),
  }
}
