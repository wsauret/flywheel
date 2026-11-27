import { createEffect, onCleanup, type Accessor } from "solid-js"
import { notifyDesktop } from "../../../infra/substrate/output/notify/desktop-notify.js"
import { Log } from "../../../infra/diagnostics/log.js"
import type { AttachedRuntimeClient, SessionRow } from "../../../protocol/runtime/app-service-types.js"
import { createDesktopPages } from "../../../protocol/client/chat/desktop-pages.js"

const log = Log.create({ service: "desktop-pages" })

/** Pages the terminal while desktop notifications are on, once for each
 *  question any session starts to wait on, a workflow agent or a subagent
 *  that no view shows among them, and once for each chat that stops for the
 *  person unread. Questions that wait and chats that stopped when paging
 *  turns on are a baseline. */
export function useDesktopPages(deps: {
  readonly client: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
  /** The catalog row the terminal holds for a session, which names a notice
   *  without a read. */
  readonly row: (sessionId: string) => Pick<SessionRow, "title"> | undefined
  readonly enabled: Accessor<boolean>
  readonly notify?: (title: string, body: string) => void
}): void {
  const notify = deps.notify ?? notifyDesktop
  createEffect(() => {
    if (!deps.enabled()) return
    onCleanup(createDesktopPages({
      client: deps.client,
      heldRow: deps.row,
      show: (notice) => { notify(notice.title, notice.body) },
      // At most one record for each question or stop: about ten stops a day.
      decided: ({ decision, sessionId, kind }) => { log.info(decision === "shown" ? "desktop page shown" : "desktop page suppressed", { sessionId, kind }) },
    }))
  })
}
