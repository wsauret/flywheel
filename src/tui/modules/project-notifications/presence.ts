import { createEffect, on, untrack } from "solid-js"
import { projectNotificationsDomain, visibleNotifications, type ProjectNotificationEpisode } from "../../../protocol/modules/project-notifications.js"
import type { ToastInput } from "../../context/toast.js"
import type { TuiPresenceProps } from "../../tui-module.js"

/** Presents one startup summary once the view first lands, then one toast per
 *  episode that appears after it. The view is the sole source: an episode is
 *  new when its id was not held before, whether a patch or a resnapshot
 *  brought it, and the toast reads the current row so a resolution or a
 *  dismissal changes or clears it in place. */
export function presentProjectNotifications(props: TuiPresenceProps): void {
  const view = () => props.read(projectNotificationsDomain)
  let held: ReadonlySet<string> | undefined

  createEffect(on(view, (episodes) => {
    if (episodes === undefined) return
    const ids = new Set(episodes.map((row) => row.id))
    // The toast's content is a live reading of the same view, so a
    // resolution or a dismissal after the toast appears changes or clears it.
    const visible = (): readonly ProjectNotificationEpisode[] => visibleNotifications(view() ?? [], Date.now())
    untrack(() => {
      if (held === undefined) {
        if (episodes.length > 0) props.showToast(summaryToast(visible))
      } else {
        const previous = held
        const newest = episodes.find((row) => !previous.has(row.id) && row.dismissedAt === undefined)
        if (newest) props.showToast(episodeToast(visible, newest.id))
      }
    })
    held = ids
  }))
}

function summaryToast(visible: () => readonly ProjectNotificationEpisode[]): ToastInput {
  return () => {
    const count = visible().length
    return count > 0 ? { message: `${count} project notification${count === 1 ? "" : "s"} available`, variant: "info" } : null
  }
}

function episodeToast(visible: () => readonly ProjectNotificationEpisode[], id: string): ToastInput {
  return () => {
    const current = visible().find((row) => row.id === id)
    if (!current) return null
    const resolved = current.resolvedAt !== undefined
    return {
      message: `${resolved ? "Resolved: " : ""}${current.title}: ${current.message}`,
      variant: resolved ? "info" : current.severity === "alert" ? "error" : "warning",
      duration: 7000,
    }
  }
}
