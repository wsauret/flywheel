import { NOTIFICATIONS_COMMAND, NOTIFICATIONS_COMMAND_NAME, NOTIFICATIONS_SURFACE, projectNotificationsProtocol } from "../../../protocol/modules/project-notifications.js"
import { moduleProtocol } from "../../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../../modules.js"
import { createProjectNotificationsProtocol } from "./protocol.js"
import { createProjectNotificationsService, projectNotificationsService } from "./service.js"
import { recoverProjectNotificationHistory } from "./recovery.js"

/** Durable project notifications (ARCH-SUBSTRATE-041, ARCH-STRUCTURE-034): the journal every producer's
 *  episode lands in through the notify seam, the workspace domain both
 *  clients fold, the `/notifications` command, and the desktop paging row. */
export const projectNotificationsModule = {
  id: "project-notifications",
  host: "control",
  dependencies: [],
  availability: { kind: "available" },
  service: { handle: projectNotificationsService, create: createProjectNotificationsService },
  protocol: moduleProtocol({ contract: projectNotificationsProtocol, create: createProjectNotificationsProtocol }),
  facts: { prefixes: ["project.notification."] },
  workspaceMigrations: [{
    phase: "startup-recovery",
    order: 100,
    label: "project notification history",
    requiresExclusiveOwner: true,
    run: ({ dbFile }) => { recoverProjectNotificationHistory(dbFile) },
  }],
  contributions: [
    { domain: "commands", id: NOTIFICATIONS_COMMAND, value: {
      id: NOTIFICATIONS_COMMAND,
      title: NOTIFICATIONS_COMMAND_NAME,
      description: "View project notifications",
      aliases: [],
      menu: { group: "top", rank: 60 },
      opens: NOTIFICATIONS_SURFACE,
    } },
    { domain: "settings", id: "project-notifications", value: { control: "binary", group: "Interface", label: "Notifications", description: "Keep what the runtime needs you to know, across restarts" } },
    { domain: "settings", id: "project-notifications-desktop", value: { control: "config-boolean", setting: "notificationsDesktop", group: "Interface", label: "Desktop notifications", description: "Show a desktop notification when a session asks you a question", host: "browser" } },
  ],
  observers: [{
    seam: "notify",
    observer: (episode, modules) => modules.get(projectNotificationsService)?.sink.apply(episode),
  }],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
