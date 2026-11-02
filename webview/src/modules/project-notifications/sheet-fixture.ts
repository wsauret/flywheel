import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import { notificationAction, type ProjectNotificationEpisode } from "../../../../src/protocol/modules/project-notifications.js"
import { ClientContext, type ClientContextValue } from "../../app/client-context.js"
import { fakeClient, fakeClientActions, fakeViewState } from "../../app/client-context-fixture.js"
import { ToolbarBadges } from "../../app/toolbar-badges.js"
import { projectNotificationsWeb } from "./index.js"
import { NotificationsSheet, openNotificationTarget } from "./sheet.js"

/** The idle frame carrying `notifications` as the module's view. */
function notificationsFrame(notifications: readonly ProjectNotificationEpisode[] | null | undefined) {
  const idle = fakeViewState()
  const modules = { ...idle.modules, project_notifications: notifications ?? null }
  const view = { ...idle, modules }
  return () => view
}

export function renderNotifications(notifications: readonly ProjectNotificationEpisode[] | null | undefined): string {
  const client = fakeClient({ state: notificationsFrame(notifications) })
  return renderToString(() => createComponent(ClientContext.Provider, {
    value: client,
    get children() { return createComponent(NotificationsSheet, {}) },
  }))
}

/** The module's toolbar badge over the same view the sheet reads. */
export function renderBadge(notifications: readonly ProjectNotificationEpisode[]): string {
  const client = fakeClient({ state: notificationsFrame(notifications), actions: fakeClientActions({ invokeCommand: () => {} }) })
  return renderToString(() => createComponent(ClientContext.Provider, {
    value: client,
    get children() { return createComponent(ToolbarBadges, { modules: [projectNotificationsWeb], report: () => {} }) },
  }))
}

/** Every sheet or surface the action opened, in order: a sheet call with its
 *  arguments, or a surface call with the surface name alone. */
export function runNotificationAction(action: NonNullable<ProjectNotificationEpisode["action"]>): (Parameters<ClientContextValue["openSheet"]> | [string])[] {
  const calls: (Parameters<ClientContextValue["openSheet"]> | [string])[] = []
  const client = fakeClient({
    openSheet: (...args) => { calls.push(args) },
    openSurface: (surface) => { calls.push([surface]) },
  })
  openNotificationTarget(client, notificationAction(action).open)
  return calls
}
