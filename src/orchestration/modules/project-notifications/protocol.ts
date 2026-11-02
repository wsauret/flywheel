import { projectNotificationsCursor, projectNotificationsProtocol } from "../../../protocol/modules/project-notifications.js"
import type { ModuleProtocolRuntime, AccountModuleProtocolServices } from "../../app-service/module-protocol-host.js"
import { projectNotificationsService } from "./service.js"

/** The module's protocol runtime. The snapshot reconciles other connections'
 *  commits before the cursor position is read, so the position covers what
 *  it answers. While the module is off, whether from composition or a live
 *  toggle, the snapshot is empty and a dismiss is refused: a client shows no
 *  episode from its next snapshot. */
export function createProjectNotificationsProtocol(services: AccountModuleProtocolServices): ModuleProtocolRuntime<typeof projectNotificationsProtocol> {
  const service = () => (services.enabled() ? services.modules.get(projectNotificationsService) : undefined)
  return {
    serve: {
      projectNotificationSnapshot: async () => {
        const current = service()
        await current?.publisher.reconcile()
        return { notifications: current?.journal.projection().visible ?? [], snapshotPosition: services.snapshotPosition({ kind: "cursor", cursor: projectNotificationsCursor() }) }
      },
    },
    mutate: {
      "project_notifications.dismiss": async (mutation) => {
        const current = service()
        if (!current) return { ok: false, error: "Project notifications are off" }
        await current.journal.dismiss(mutation.sourceId, mutation.episodeId)
        return { ok: true }
      },
    },
    dispose() {},
  }
}
