import type { StoredFact } from "../../../infra/substrate/store/event-store-types.js"
import type { ProjectNotificationEpisode, ProjectNotificationProjection } from "../../../protocol/modules/project-notifications.js"
import { visibleNotifications } from "../../../protocol/modules/project-notifications.js"
import { parseProjectNotificationFact } from "./facts.js"

export const PROJECT_NOTIFICATION_AGGREGATE_ID = "project:notifications"
export const PROJECT_NOTIFICATION_LIFETIME_MS = 48 * 60 * 60 * 1_000

/** The aggregate that keeps the notifications of one auth profile in the
 *  store the host keeps profile state in (ARCH-SUBSTRATE-041). */
export function profileNotificationAggregateId(profileId: string): string {
  return `profile:${profileId}:notifications`
}

/** The fold of one notification aggregate. Each fact touches only its own
 *  episode and source entries, so a change costs the same however long the
 *  retained history is (ARCH-SUBSTRATE-017). */
export interface ProjectNotificationFold {
  readonly aggregateId: string
  readonly episodes: Map<string, ProjectNotificationEpisode>
  /** The active episode id of each source. */
  readonly activeSources: Map<string, string>
  /** Every episode id of each source, oldest first. */
  readonly sourceEpisodes: Map<string, string[]>
  lastSeq: number
}

export function emptyProjectNotificationFold(aggregateId: string): ProjectNotificationFold {
  return { aggregateId, episodes: new Map(), activeSources: new Map(), sourceEpisodes: new Map(), lastSeq: -1 }
}

/** One strict step of the aggregate fold (ARCH-SUBSTRATE-041). Every check
 *  throws before the fold changes, so a malformed history stops replay
 *  instead of projecting a partial truth. */
export function applyProjectNotificationFact(fold: ProjectNotificationFold, event: StoredFact): void {
  if (event.aggregateId !== fold.aggregateId) throw new Error(`Project notification fact must target ${fold.aggregateId}`)
  if (event.seq !== fold.lastSeq + 1) throw new Error(`Project notification sequence must be contiguous after ${fold.lastSeq}; received ${event.seq}`)
  const fact = parseProjectNotificationFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })

  if (fact.type === "project.notification.raised") {
    if (fold.episodes.has(event.id)) throw new Error(`Duplicate project notification occurrence: ${event.id}`)
    if (fold.activeSources.has(fact.payload.sourceId)) throw new Error(`Duplicate project notification source while active: ${fact.payload.sourceId}`)
    if (fact.payload.createdAt !== event.timestamp) throw new Error("Project notification createdAt must equal its fact timestamp")
    if (fact.payload.expiresAt - fact.payload.createdAt !== PROJECT_NOTIFICATION_LIFETIME_MS) {
      throw new Error("Project notification lifetime must be exactly 48 hours")
    }
    fold.episodes.set(event.id, { id: event.id, ...fact.payload })
    fold.activeSources.set(fact.payload.sourceId, event.id)
    const ids = fold.sourceEpisodes.get(fact.payload.sourceId)
    if (ids) ids.push(event.id)
    else fold.sourceEpisodes.set(fact.payload.sourceId, [event.id])
  } else {
    const existing = fold.episodes.get(fact.payload.episodeId)
    if (!existing) {
      if (fold.sourceEpisodes.has(fact.payload.sourceId)) throw new Error(`Transition targets wrong episode for project notification: ${fact.payload.sourceId}`)
      throw new Error(`Transition targets unknown project notification: ${fact.payload.sourceId}`)
    }
    if (existing.sourceId !== fact.payload.sourceId) throw new Error(`Transition targets wrong episode for project notification: ${fact.payload.sourceId}`)
    const transitionAt = event.timestamp
    if (fact.type === "project.notification.resolved") {
      if (existing.resolvedAt === undefined) fold.episodes.set(existing.id, { ...existing, resolvedAt: transitionAt })
      if (fold.activeSources.get(existing.sourceId) === existing.id) fold.activeSources.delete(existing.sourceId)
    } else if (existing.dismissedAt === undefined) {
      fold.episodes.set(existing.id, { ...existing, dismissedAt: transitionAt })
    }
  }
  fold.lastSeq = event.seq
}

/** Replays one aggregate's complete history strictly, as recovery does. */
export function projectProjectNotifications(events: readonly StoredFact[], now: number, aggregateId: string): ProjectNotificationProjection {
  const fold = emptyProjectNotificationFold(aggregateId)
  for (const event of events) applyProjectNotificationFact(fold, event)
  return materializeProjectNotificationProjection(fold, now)
}

/** The order every notification list holds: newest first, ties by episode id. */
export function newestNotificationFirst(left: ProjectNotificationEpisode, right: ProjectNotificationEpisode): number {
  return right.createdAt - left.createdAt || right.id.localeCompare(left.id)
}

export function materializeProjectNotificationProjection(state: ProjectNotificationFold, now: number): ProjectNotificationProjection {
  const episodes = [...state.episodes.values()].sort(newestNotificationFirst)
  return { episodes, visible: visibleNotifications(episodes, now), lastSeq: state.lastSeq }
}
