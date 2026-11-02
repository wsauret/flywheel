import { NOTIFICATIONS_SURFACE, projectNotificationsDomain, unresolvedNotifications } from "../../../../src/protocol/modules/project-notifications.js"
import type { WebModule } from "../../web-module.js"
import { NotificationsSheet } from "./sheet.js"

/** The toolbar badge counts the shown episodes that still need attention, and opens the sheet. */
export const projectNotificationsWeb = {
  id: "project-notifications",
  surfaces: [{ id: NOTIFICATIONS_SURFACE, sheet: NotificationsSheet }],
  toolbar: (read) => {
    const count = unresolvedNotifications(read(projectNotificationsDomain) ?? [], Date.now()).length
    return count === 0 ? undefined : { id: NOTIFICATIONS_SURFACE, label: count === 1 ? "notification" : "notifications", count, tone: "warning", action: { kind: "surface", id: NOTIFICATIONS_SURFACE } }
  },
} as const satisfies WebModule
