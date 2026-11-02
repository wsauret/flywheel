import { createKeyedListSelection } from "../../hooks/create-keyed-list-selection.js"
import type { DomainReader } from "../../../protocol/protocol-module.js"
import { projectNotificationsDomain, type ProjectNotificationAction, type ProjectNotificationEpisode, visibleNotifications } from "../../../protocol/modules/project-notifications.js"
import type { ListModalKeyEvent } from "../../components/modal-list-keys.js"
import type { TuiSurfaceHost } from "../../tui-module.js"

/** The list state the modal and its key handler share: one cursor over the
 *  visible episodes of the session's view. Module-scoped because the host
 *  binds the key handler once and the modal mounts per open; both read the
 *  same reader, so neither holds a copy of the rows. */
const selection = createKeyedListSelection()
export const notificationNavigationRevision = selection.revision

export function visibleRows(read: DomainReader): readonly ProjectNotificationEpisode[] | undefined {
  const view = read(projectNotificationsDomain)
  return view === undefined ? undefined : visibleNotifications(view, Date.now())
}

/** The cursor clamped to the rows that exist now. */
export function notificationCursor(read: DomainReader): number {
  selection.reconcile(visibleRows(read)?.map((row) => row.id) ?? [])
  return selection.cursor()
}

export function selectNotificationRow(rowIndex: number): void {
  selection.select(Math.max(0, rowIndex))
}

/** Each closed action sends the person to one kernel destination. */
function openNotificationAction(action: ProjectNotificationAction, navigate: TuiSurfaceHost["navigate"]): void {
  switch (action.kind) {
    case "open-auth":
      void navigate.openSettings("providerId" in action
        ? { kind: "auth-account", providerId: action.providerId, accountCorrelationId: action.accountCorrelationId, envelopeId: action.envelopeId }
        : { kind: "auth" })
      return
    case "open-auth-provider":
      void navigate.openSettings({ kind: "auth-provider", providerId: action.providerId })
      return
    case "open-usage":
      navigate.openSurface("usage")
      return
    case "open-settings":
      void navigate.openSettings({ kind: "root" })
  }
}

export function dismissNotificationRow(host: Pick<TuiSurfaceHost, "read" | "client">, rowIndex: number): void {
  const row = visibleRows(host.read)?.[rowIndex]
  if (row) void host.client.dispatch({ type: "project_notifications.dismiss", sourceId: row.sourceId, episodeId: row.id })
}

export function activateNotificationRow(host: Pick<TuiSurfaceHost, "read" | "navigate">, rowIndex: number): void {
  const row = visibleRows(host.read)?.[rowIndex]
  if (row?.action) openNotificationAction(row.action, host.navigate)
}

/** Arrows and j/k move, return opens, d dismisses; everything else is the host's. */
export function notificationKeys(event: ListModalKeyEvent, host: TuiSurfaceHost): boolean {
  const key = event.name.toLowerCase()
  const rows = visibleRows(host.read) ?? []
  if (key === "up" || key === "k" || key === "down" || key === "j") {
    event.preventDefault?.()
    if (rows.length === 0) return true
    const current = notificationCursor(host.read)
    selection.select((current + (key === "up" || key === "k" ? rows.length - 1 : 1)) % rows.length)
    return true
  }
  if (key === "return" || key === "enter") {
    event.preventDefault?.()
    activateNotificationRow(host, notificationCursor(host.read))
    return true
  }
  if (key === "d") {
    event.preventDefault?.()
    dismissNotificationRow(host, notificationCursor(host.read))
    return true
  }
  return false
}

export function resetNotificationCursor(): void {
  selection.reconcile([])
  selection.select(0)
}
