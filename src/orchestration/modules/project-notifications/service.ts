import { moduleServiceHandle } from "../../../infra/module-service.js"
import { requireGuardedEventAppender } from "../../../infra/event-store-types.js"
import type { ControlModuleServices, ModuleServiceInstance } from "../../app-service/module-service-host.js"
import { createProjectNotificationJournal, type ProjectNotificationJournal } from "./journal.js"
import { createProjectNotificationPublisher, type ProjectNotificationPublisher } from "./publisher.js"
import { createProjectNotificationSink, type ProjectNotificationSink } from "./sink.js"

/** The session id the journal signs its facts with: the aggregate is project-wide, not one session's. */
const JOURNAL_SESSION_ID = "project-notifications"

/** The module's one process-scoped service: the journal over the durable
 *  aggregate, the ordered sink the notify observer feeds it through, and the
 *  publisher that turns committed facts into patches. The protocol runtime
 *  reads the journal through this handle; nothing outside the module holds it. */
export interface ProjectNotificationsService extends ModuleServiceInstance {
  readonly journal: ProjectNotificationJournal
  readonly sink: ProjectNotificationSink
  readonly publisher: ProjectNotificationPublisher
}

export const projectNotificationsService = moduleServiceHandle<ProjectNotificationsService>("project-notifications")

export function createProjectNotificationsService(services: ControlModuleServices): ProjectNotificationsService {
  const journal = createProjectNotificationJournal({
    reader: services.projectionReader,
    writer: requireGuardedEventAppender(services.eventWriter, "Project notifications require guarded append authority"),
    sessionId: JOURNAL_SESSION_ID,
  })
  const sink = createProjectNotificationSink({ journal })
  const publisher = createProjectNotificationPublisher({ journal, onStored: services.onStored, publish: services.publish })
  return {
    journal,
    sink,
    publisher,
    // The sink stays open until disposal: runners that stop after shutdown
    // begins still state their conditions through the seam, and disposal runs
    // in the durable flush, after they stopped (ARCH-RUNTIME-052).
    closeAdmission() {
      publisher.closeAdmission()
    },
    async dispose() {
      publisher.closeAdmission()
      await sink.settled()
      await publisher.settled()
    },
  }
}
