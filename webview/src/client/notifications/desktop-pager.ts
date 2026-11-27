import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { RuntimeConnection } from "../../../../src/protocol/client/runtime/connection.js"
import { createDesktopPages } from "../../../../src/protocol/client/chat/desktop-pages.js"
import { desktopNotificationsOn, type WorkspaceSettings } from "../session-settings.js"
import type { SessionRow } from "../../../../src/protocol/runtime/app-service-types.js"
import type { DesktopNotifier } from "./desktop-notifier.js"

/** Pages this browser while the browser allows it and desktop notifications
 *  are on, once for each question any session starts to wait on, a workflow
 *  agent or a subagent that the page does not show among them, and once for
 *  each chat that stops for the person unread. Questions that wait and chats
 *  that stopped when paging turns on are a baseline. A click on a notice
 *  calls `attend` with the session it names. */
export function createDesktopPager(options: {
  readonly state: Accessor<{ readonly settings?: WorkspaceSettings }>
  readonly notifier: DesktopNotifier
  /** The row the page holds for a session, which names a notice without a read. */
  readonly row: (sessionId: string) => Pick<SessionRow, "title"> | undefined
  readonly connection: Pick<RuntimeConnection, "query" | "subscribe" | "onLane">
  readonly attend: (sessionId: string) => void
}): void {
  const { notifier } = options
  // The browser changes its answer without a change to the session.
  const [permission, setPermission] = createSignal(notifier.permission())
  onCleanup(notifier.onChange(() => setPermission(notifier.permission())))
  const paging = createMemo(() => permission() === "granted" && desktopNotificationsOn(options.state().settings))
  createEffect(() => {
    if (!paging()) return
    onCleanup(createDesktopPages({ client: options.connection, heldRow: options.row, show: (notice) => { notifier.show(notice) } }))
  })
  onCleanup(notifier.onOpen(options.attend))
}
