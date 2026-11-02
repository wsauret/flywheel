import { Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import { formatDateTime } from "../../../../src/protocol/client/format.js"
import { notificationAction, projectNotificationsDomain, visibleNotifications, type NotificationActionView, type ProjectNotificationEpisode, NOTIFICATIONS_COMMAND_NAME } from "../../../../src/protocol/modules/project-notifications.js"
import { actionKey } from "../../client/action-key.js"
import { describeFailure } from "../../client/failure-message.js"
import { useClient } from "../../app/client-context.js"
import { Sheet, SheetEmpty, SheetLoading } from "../../app/sheets/sheet.js"
import "./sheet.css"

/** Project notifications: what the runtime needs the person to know, each with
 *  an optional action that addresses it and a way to dismiss it for good. The
 *  action vocabulary is closed (ARCH-BOUNDARIES-015): auth, usage, or settings. */

/** Opens, in this client, where a notice's action points. */
export function openNotificationTarget(client: ReturnType<typeof useClient>, open: NotificationActionView["open"]): void {
  if (open.type === "openSurface") client.openSurface(open.surface)
  else client.openSheet(open.sheet, open.focus)
}

export function NotificationsSheet() {
  const client = useClient()
  const episodes = () => {
    const view = client.state().modules[projectNotificationsDomain.domain] ?? undefined
    return view === undefined ? undefined : visibleNotifications(view, Date.now())
  }

  const dismissKey = (episode: ProjectNotificationEpisode) => actionKey("project-notifications.dismiss", episode.sourceId, episode.id)
  const dismiss = (episode: ProjectNotificationEpisode) => {
    void client.actions.run(dismissKey(episode), () => client.connection.dispatch({ type: "project_notifications.dismiss", sourceId: episode.sourceId, episodeId: episode.id }),
      (cause) => client.report("warning", `Flywheel could not dismiss that notification: ${describeFailure(cause)}`))
  }

  return (
    <Sheet title={NOTIFICATIONS_COMMAND_NAME} onClose={client.closeSheet}>
      <Show when={episodes()} fallback={<SheetLoading />}>{(rows) =>
      <Show when={rows().length > 0} fallback={<SheetEmpty>Nothing needs your attention.</SheetEmpty>}>
        <Key each={rows()} by={(episode) => JSON.stringify([episode.sourceId, episode.id])}>
          {(episode) => {
            return (
              <article class="notification" classList={{ [`notification-${episode().severity}`]: episode().resolvedAt === undefined, "notification-resolved": episode().resolvedAt !== undefined }}>
                <div class="notification-head">
                  <span class="notification-severity">{episode().resolvedAt === undefined ? episode().severity : "resolved"}</span>
                  <span class="notification-title">{episode().title}</span>
                  <time class="notification-time" datetime={new Date(episode().createdAt).toISOString()}>{formatDateTime(episode().createdAt)}</time>
                </div>
                <p class="notification-message">{episode().message}</p>
                <div class="notification-actions">
                  <Show when={episode().action}>{(action) => (
                    <button class="primary" onClick={() => { client.closeSheet(); openNotificationTarget(client, notificationAction(action()).open) }}>{notificationAction(action()).label}</button>
                  )}</Show>
                  <button class="ghost-text" aria-busy={client.actions.working(dismissKey(episode())) || undefined} onClick={() => dismiss(episode())}>Dismiss</button>
                </div>
              </article>
            )
          }}
        </Key>
      </Show>
      }</Show>
    </Sheet>
  )
}
