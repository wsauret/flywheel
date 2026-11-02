import { NOTIFICATIONS_SURFACE } from "../../../protocol/modules/project-notifications.js"
import type { TuiModule } from "../../tui-module.js"
import { notificationKeys, resetNotificationCursor } from "./list.js"
import { presentProjectNotifications } from "./presence.js"

export const projectNotificationsTui = {
  id: "project-notifications",
  surfaces: [{
    id: NOTIFICATIONS_SURFACE,
    title: "Notifications",
    width: 72,
    controls: ["enter open · ↑↓ navigate · d dismiss · esc close"],
    load: async () => {
      resetNotificationCursor()
      return (await import("./modal.js")).NotificationsModal
    },
    onKey: notificationKeys,
  }],
  present: presentProjectNotifications,
} as const satisfies TuiModule
