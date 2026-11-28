import { Log } from "../../../infra/diagnostics/log.js"
import { moduleServiceHandle } from "../../../infra/definitions/modules/module-service.js"
import { authStatusCursor } from "../../../protocol/auth/auth-status-protocol-types.js"
import { projectNotificationsCursor, type ProjectNotificationEpisode, type ProjectNotificationPatchPayload } from "../../../protocol/modules/project-notifications.js"
import { cursorKey } from "../../../protocol/runtime/runtime-ui-protocol-types.js"
import type { ModuleServiceInstance } from "../../app-service/executor/execution/module-service-host.js"
import type { ControlModuleServices } from "../../app-service/account/projects/account-module-services.js"
import { createProjectNotificationJournal } from "./journal.js"
import { holdProfileNotificationJournal, type ProfileNotificationLease } from "./profile-journals.js"
import { newestNotificationFirst, PROJECT_NOTIFICATION_AGGREGATE_ID } from "./projection.js"
import { createProjectNotificationPublisher } from "./publisher.js"
import { createProjectNotificationSink, type ProjectNotificationSink } from "./sink.js"

/** The session id the journal signs its facts with: the aggregate is project-wide, not one session's. */
const JOURNAL_SESSION_ID = "project-notifications"

/** The module's one process-scoped service: the project's journal, the
 *  journals of the auth profiles it states conditions of, the ordered sink
 *  the notify observer feeds them through, and the publication of what the
 *  project shows. A project shows its own episodes and those of its active
 *  auth profile (ARCH-PROTOCOL-044). The protocol runtime reads it through
 *  this handle; nothing outside the module holds it. */
export interface ProjectNotificationsService extends ModuleServiceInstance {
  /** Folds what other connections committed, then answers every episode the
   *  project shows, newest first, with `anchor` read in the same turn as the
   *  list, so no publication falls between the two. */
  snapshot<Anchor>(anchor: () => Anchor): Promise<{ readonly notifications: readonly ProjectNotificationEpisode[]; readonly anchor: Anchor }>
  /** Dismisses one exact episode in the journal that holds it. */
  dismiss(sourceId: string, episodeId: string): Promise<void>
  readonly sink: ProjectNotificationSink
}

export const projectNotificationsService = moduleServiceHandle<ProjectNotificationsService>("project-notifications")

const log = Log.create({ service: "project-notifications-service" })

export function createProjectNotificationsService(services: ControlModuleServices): ProjectNotificationsService {
  const journal = createProjectNotificationJournal({
    reader: services.projectionReader,
    writer: services.eventWriter,
    aggregateId: PROJECT_NOTIFICATION_AGGREGATE_ID,
    sessionId: JOURNAL_SESSION_ID,
  })
  const publisher = createProjectNotificationPublisher({ journal, onStored: services.onStored })
  let publishing = true
  const publish = (payload: ProjectNotificationPatchPayload): void => {
    if (publishing) services.publish({ cursor: projectNotificationsCursor(), payload })
  }
  const unsubscribeProject = publisher.subscribe(publish)

  // A source has one scope. A project episode of a source that a profile
  // now names was recorded before its producer declared the profile, so the
  // profile's episodes replace it: the copy resolves and leaves the list.
  const projectCopies = (sourceId: string): readonly ProjectNotificationEpisode[] => {
    const now = Date.now()
    return journal.episodesOf(sourceId).filter((episode) => episode.dismissedAt === undefined && now < episode.expiresAt)
  }
  const retireProjectCopies = async (sourceIds: Iterable<string>): Promise<void> => {
    for (const sourceId of sourceIds) {
      for (const copy of projectCopies(sourceId)) {
        if (copy.resolvedAt === undefined) await journal.resolve(sourceId)
        await journal.dismiss(sourceId, copy.id)
      }
    }
  }

  // Each profile this project states a condition of, or shows, stays held
  // until the service is disposed.
  const leases = new Map<string, ProfileNotificationLease>()
  const profileLease = (profileId: string): ProfileNotificationLease => {
    let lease = leases.get(profileId)
    if (lease === undefined) {
      lease = holdProfileNotificationJournal(services.profileStore, profileId)
      leases.set(profileId, lease)
    }
    return lease
  }

  // A profile's raise reaches a client after the dismissal of this project's
  // copy of its source, the same rule the snapshot applies durably, so a
  // client never holds both rows.
  const forwardProfile = (payload: ProjectNotificationPatchPayload): void => {
    if (payload.kind === "project_notifications.raised") {
      const { sourceId } = payload.episode
      const copies = projectCopies(sourceId)
      for (const copy of copies) publish({ kind: "project_notifications.dismissed", sourceId, episodeId: copy.id, dismissedAt: payload.episode.createdAt })
      if (copies.length > 0) void retireProjectCopies([sourceId]).catch((error: unknown) => {
        log.warn("project copy of a profile notification did not retire", { errorType: error instanceof Error ? error.name : typeof error })
      })
    }
    publish(payload)
  }

  // The active profile is read when a client first needs it, after auth
  // composition, and then follows the workspace auth view.
  let shown: { readonly profileId: string; readonly lease: ProfileNotificationLease; readonly unsubscribe: () => void } | undefined
  const show = (profileId: string): NonNullable<typeof shown> => {
    if (shown?.profileId === profileId) return shown
    shown?.unsubscribe()
    const lease = profileLease(profileId)
    shown = { profileId, lease, unsubscribe: lease.publisher.subscribe(forwardProfile) }
    return shown
  }
  const active = (): NonNullable<typeof shown> => shown ?? show(services.authProfileId())
  const defaultsAuth = cursorKey(authStatusCursor())
  const unsubscribeAuth = services.onFrontendEvent((event) => {
    if (event.type !== "patch" || event.patch.payload.kind !== "auth.changed" || cursorKey(event.patch.cursor) !== defaultsAuth) return
    const profileId = event.patch.payload.auth.profile.id
    if (shown === undefined || shown.profileId === profileId || !publishing) return
    show(profileId)
    // The list a client holds shows the earlier profile's episodes, so it
    // reads the new list whole.
    services.publish({ cursor: projectNotificationsCursor(), payload: { kind: "runtime.invalidate", reason: "rebase" } })
  })

  const sink = createProjectNotificationSink({ journal, profileJournal: (profileId) => profileLease(profileId).journal, retireProjectCopies })
  const closeAdmission = (): void => {
    if (!publishing) return
    publishing = false
    unsubscribeAuth()
    unsubscribeProject()
    shown?.unsubscribe()
    publisher.closeAdmission()
  }
  return {
    async snapshot(anchor) {
      for (;;) {
        const viewed = active()
        await Promise.all([publisher.reconcile(), viewed.lease.publisher.reconcile()])
        const profileJournal = viewed.lease.journal
        await retireProjectCopies(journal.projection().visible.flatMap((episode) => profileJournal.episodesOf(episode.sourceId).length > 0 ? [episode.sourceId] : []))
        // A profile switch while the reads ran published a rebase that this
        // list must cover, so it reads again under the new profile.
        if (active() !== viewed) continue
        const notifications = [...journal.projection().visible, ...profileJournal.projection().visible].sort(newestNotificationFirst)
        return { notifications, anchor: anchor() }
      }
    },
    async dismiss(sourceId, episodeId) {
      await (journal.episode(episodeId) === undefined ? active().lease.journal : journal).dismiss(sourceId, episodeId)
    },
    sink,
    // The sink stays open until disposal: runners that stop after shutdown
    // begins still state their conditions through the seam, and disposal runs
    // in the durable flush, after they stopped (ARCH-RUNTIME-052).
    closeAdmission,
    async dispose() {
      closeAdmission()
      // Every hold ends whatever the settlements answer, so a failed
      // publication never keeps a profile's journal and its poll alive.
      const outcomes = await Promise.allSettled([sink.settled(), publisher.settled()])
      const releases = await Promise.allSettled([...leases.values()].map((lease) => lease.release()))
      const failures = [...outcomes, ...releases].flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : [])
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, "Project notifications failed to settle")
    },
  }
}
