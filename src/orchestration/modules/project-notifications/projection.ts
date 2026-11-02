import type { StoredFact } from "../../../infra/event-store-types.js"
import type { ProjectNotificationEpisode, ProjectNotificationProjection } from "../../../protocol/modules/project-notifications.js"
import { visibleNotifications } from "../../../protocol/modules/project-notifications.js"
import { parseProjectNotificationFact } from "./facts.js"

export const PROJECT_NOTIFICATION_AGGREGATE_ID = "project:notifications"
export const PROJECT_NOTIFICATION_LIFETIME_MS = 48 * 60 * 60 * 1_000

export interface ProjectNotificationProjectionState {
  readonly episodes: ReadonlyMap<string, ProjectNotificationEpisode>
  readonly activeSources: ReadonlyMap<string, string>
  readonly lastSeq: number
}

export function emptyProjectNotificationProjectionState(): ProjectNotificationProjectionState {
  return { episodes: new Map(), activeSources: new Map(), lastSeq: -1 }
}

/** One strict step of the aggregate fold (ARCH-SUBSTRATE-041). Every check throws, so a
 *  malformed history stops replay instead of projecting a partial truth. */
export function reduceProjectNotificationProjection(state: ProjectNotificationProjectionState, event: StoredFact): ProjectNotificationProjectionState {
  if (event.aggregateId !== PROJECT_NOTIFICATION_AGGREGATE_ID) throw new Error(`Project notification fact must target ${PROJECT_NOTIFICATION_AGGREGATE_ID}`)
  if (event.seq !== state.lastSeq + 1) throw new Error(`Project notification sequence must be contiguous after ${state.lastSeq}; received ${event.seq}`)
  const fact = parseProjectNotificationFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
  const episodes = new Map(state.episodes)
  const activeSources = new Map(state.activeSources)

  if (fact.type === "project.notification.raised") {
    if (episodes.has(event.id)) throw new Error(`Duplicate project notification occurrence: ${event.id}`)
    if (activeSources.has(fact.payload.sourceId)) throw new Error(`Duplicate project notification source while active: ${fact.payload.sourceId}`)
    if (fact.payload.createdAt !== event.timestamp) throw new Error("Project notification createdAt must equal its fact timestamp")
    if (fact.payload.expiresAt - fact.payload.createdAt !== PROJECT_NOTIFICATION_LIFETIME_MS) {
      throw new Error("Project notification lifetime must be exactly 48 hours")
    }
    episodes.set(event.id, { id: event.id, ...fact.payload })
    activeSources.set(fact.payload.sourceId, event.id)
  } else {
    const existing = episodes.get(fact.payload.episodeId)
    if (!existing) {
      if ([...episodes.values()].some((episode) => episode.sourceId === fact.payload.sourceId)) throw new Error(`Transition targets wrong episode for project notification: ${fact.payload.sourceId}`)
      throw new Error(`Transition targets unknown project notification: ${fact.payload.sourceId}`)
    }
    if (existing.sourceId !== fact.payload.sourceId) throw new Error(`Transition targets wrong episode for project notification: ${fact.payload.sourceId}`)
    const transitionAt = event.timestamp
    if (fact.type === "project.notification.resolved") {
      if (existing.resolvedAt === undefined) episodes.set(existing.id, { ...existing, resolvedAt: transitionAt })
      if (activeSources.get(existing.sourceId) === existing.id) activeSources.delete(existing.sourceId)
    } else if (existing.dismissedAt === undefined) {
      episodes.set(existing.id, { ...existing, dismissedAt: transitionAt })
    }
  }

  return { episodes, activeSources, lastSeq: event.seq }
}

export function projectProjectNotifications(events: readonly StoredFact[], now: number): ProjectNotificationProjection {
  const state = events.reduce(reduceProjectNotificationProjection, emptyProjectNotificationProjectionState())
  return materializeProjectNotificationProjection(state, now)
}

export function materializeProjectNotificationProjection(state: ProjectNotificationProjectionState, now: number): ProjectNotificationProjection {
  const episodes = [...state.episodes.values()].sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
  return { episodes, visible: visibleNotifications(episodes, now), lastSeq: state.lastSeq }
}
