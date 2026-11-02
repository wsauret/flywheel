import { createEffect, createMemo, createSignal, onCleanup, type Accessor } from "solid-js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createQuestionPages } from "../../../src/protocol/client/question-pages.js"
import { desktopNotificationsOn, type WorkspaceSettings } from "./session-settings.js"
import type { RuntimeSession } from "./session.js"

/** Pages this browser while the browser allows it and desktop notifications
 *  are on, once for each question any session starts to wait on, a workflow
 *  agent or a subagent that the page does not show among them. Questions
 *  that wait when paging turns on are a baseline. A click on a notice calls
 *  `attend` with the session that asks. */
export function createQuestionPager(options: {
  readonly state: Accessor<{ readonly settings?: WorkspaceSettings }>
  readonly session: Pick<RuntimeSession, "desktopNotifier" | "row">
  readonly connection: Pick<RuntimeConnection, "query" | "subscribe">
  readonly attend: (sessionId: string) => void
}): void {
  const notifier = options.session.desktopNotifier
  // The browser changes its answer without a change to the session.
  const [permission, setPermission] = createSignal(notifier.permission())
  onCleanup(notifier.onChange(() => setPermission(notifier.permission())))
  const paging = createMemo(() => permission() === "granted" && desktopNotificationsOn(options.state().settings))
  createEffect(() => {
    if (!paging()) return
    onCleanup(createQuestionPages({ client: options.connection, heldRow: options.session.row, show: (notice) => { notifier.show(notice) } }))
  })
  onCleanup(notifier.onOpen(options.attend))
}
