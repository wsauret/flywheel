import { createEffect, onCleanup, type Accessor } from "solid-js"
import { notifyDesktop } from "../../infra/desktop-notify.js"
import type { RuntimeClient, SessionRow } from "../../protocol/app-service-types.js"
import { createQuestionPages } from "../../protocol/client/question-pages.js"

/** Pages the terminal while desktop notifications are on, once for each
 *  question any session starts to wait on, a workflow agent or a subagent
 *  that no view shows among them. Questions that wait when paging turns on
 *  are a baseline. */
export function useQuestionPages(deps: {
  readonly client: Pick<RuntimeClient, "query" | "subscribe">
  /** The catalog row the terminal holds for a session, which names a notice
   *  without a read. */
  readonly row: (sessionId: string) => Pick<SessionRow, "title"> | undefined
  readonly enabled: Accessor<boolean>
  readonly notify?: (title: string, body: string) => void
}): void {
  const notify = deps.notify ?? notifyDesktop
  createEffect(() => {
    if (!deps.enabled()) return
    onCleanup(createQuestionPages({ client: deps.client, heldRow: deps.row, show: (notice) => { notify(notice.title, notice.body) } }))
  })
}
