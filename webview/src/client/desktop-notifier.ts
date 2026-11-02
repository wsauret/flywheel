import type { DesktopNotice } from "../../../src/protocol/client/question-pages.js"
import type { InlineSettingAction, SettingOutcome } from "./settings-actions.js"

/** Whether this page may show operating-system notifications: the browser's
 *  own answer, or `unsupported` where the page has no Notification API, such
 *  as an editor webview or a phone browser tab. */
export type DesktopPermission = "granted" | "denied" | "default" | "unsupported"

/** The browser's notification surface, behind one seam so tests and hosts
 *  without the API supply their own. */
export interface DesktopNotifier {
  permission(): DesktopPermission
  /** Asks the browser once. The browser shows its prompt only while the
   *  answer is `default`; after that it answers at once. */
  request(): Promise<DesktopPermission>
  show(notice: DesktopNotice): void
  onChange(listener: () => void): () => void
  /** Calls `listener` with the session a notice names when the person
   *  clicks the notice, so the page opens the session that asks. */
  onOpen(listener: (sessionId: string) => void): () => void
}

/** True for the setting that turns desktop notifications on in every client. */
export function isDesktopNotificationsSetting(setting: { readonly control: string; readonly setting?: string }): boolean {
  return setting.control === "config-boolean" && setting.setting === "notificationsDesktop"
}

/** Asks the browser for its permission when `action` turns desktop
 *  notifications on, and answers the refusal when the browser does not
 *  allow them, so nothing is written and the switch stays off. A browser
 *  without notifications still turns the shared setting on: the terminal
 *  pages the person. */
export function desktopPermissionRefusal(action: InlineSettingAction, notifier: DesktopNotifier): Promise<SettingOutcome | undefined> | undefined {
  if (action.kind !== "set-module-setting" || !action.on || !isDesktopNotificationsSetting(action.setting)) return undefined
  return notifier.request().then((permission): SettingOutcome | undefined => {
    if (permission === "denied") return { kind: "notice", severity: "warning", message: "Desktop notifications stay off: this browser blocks them for this page." }
    if (permission === "default") return { kind: "notice", severity: "info", message: "Desktop notifications stay off: the browser did not allow them. Turn them on again to ask again." }
    return undefined
  })
}

/** Whether the page's switch shows desktop notifications on: the shared
 *  setting is on and this browser lets the page notify. The setting is on by
 *  default, so a page that has not asked the browser yet shows the switch off,
 *  and the person's turning it on is what makes the browser ask. A browser
 *  without notifications shows the shared setting, which the terminal reads. */
export function desktopSwitchOn(setting: boolean, permission: DesktopPermission): boolean {
  return setting && (permission === "granted" || permission === "unsupported")
}

/** The row's words while the browser keeps the page from notifying, or
 *  undefined when the setting's own description applies. */
export function desktopPermissionDetail(permission: DesktopPermission): string | undefined {
  switch (permission) {
    case "granted":
    case "default": return undefined
    case "denied": return "This browser blocks notifications from this page. To allow them, open the browser's site settings for this address and set Notifications to Allow."
    case "unsupported": return "This browser cannot show notifications. When this is on, the terminal still notifies you."
  }
}

interface NotificationApi {
  readonly permission: NotificationPermission
  requestPermission(): Promise<NotificationPermission>
  new (title: string, options?: NotificationOptions): Notification
}

interface PermissionsScope {
  readonly Notification?: NotificationApi
  readonly focus?: () => void
  readonly navigator?: { readonly permissions?: { query(descriptor: { readonly name: "notifications" }): Promise<EventTarget> } }
}

/** The browser's Notification API, read from `scope` when it has one. */
export function browserDesktopNotifier(scope: PermissionsScope = globalThis): DesktopNotifier {
  const api = scope.Notification
  const listeners = new Set<() => void>()
  const openers = new Set<(sessionId: string) => void>()
  const permission = (): DesktopPermission => api === undefined ? "unsupported" : api.permission
  // A person who allows or blocks the page in the browser's site settings
  // changes the answer with no call from the page; the browser says so here.
  // A browser without the Permissions API is read again at the next change.
  if (api !== undefined) {
    void scope.navigator?.permissions?.query({ name: "notifications" }).then(
      (status) => { status.addEventListener("change", () => { for (const listener of listeners) listener() }) },
      () => undefined,
    )
  }
  return {
    permission,
    async request() {
      if (api === undefined) return "unsupported"
      const before = api.permission
      const answer = before === "default" ? await api.requestPermission() : before
      if (answer !== before) for (const listener of listeners) listener()
      return answer
    },
    show(notice) {
      if (api === undefined || api.permission !== "granted") return
      // One notice for each question: every open page of the project that
      // pages for the same question shows one notice, and a later question
      // alerts again instead of replacing the earlier notice in silence.
      const shown = new api(notice.title, { body: notice.body, tag: `flywheel-question:${notice.questionId}` })
      // A click brings the page that paged the person to the front and
      // opens the session that asks.
      shown.addEventListener("click", () => {
        scope.focus?.()
        for (const open of openers) open(notice.sessionId)
      })
    },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onOpen(listener) {
      openers.add(listener)
      return () => { openers.delete(listener) }
    },
  }
}
