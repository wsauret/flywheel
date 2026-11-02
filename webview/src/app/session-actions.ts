import { summaryOf } from "../client/view-state.js"
import { useClient } from "./client-context.js"
import { copySessionId } from "./session-copy.js"
import type { SessionListActions } from "./session-list.js"
import { effectiveSessionShortTitle, SHORT_TITLE_MAX_CHARS, type SessionTitlePatch } from "../../../src/protocol/app-service-types.js"
import type { ClientContextValue } from "./client-context.js"
import { createSignal } from "solid-js"

/** Edit the stored pair and dispatch only the fields the person changed. */
export async function promptSessionRename(client: ClientContextValue, sessionId: string): Promise<void> {
  const row = summaryOf(client.state(), sessionId)
  if (row === undefined) return
  const originalTitle = row.subtitle ?? row.title
  const originalShortTitle = effectiveSessionShortTitle(originalTitle, row.shortTitle)
  const [shortTitle, setShortTitle] = createSignal(originalShortTitle)
  const title = await client.prompt({
    title: "Rename chat",
    label: "Description",
    initialValue: originalTitle,
    secondaryField: { label: `Tab title (${SHORT_TITLE_MAX_CHARS} characters)`, initialValue: originalShortTitle, maxLength: SHORT_TITLE_MAX_CHARS, onChange: (value) => setShortTitle(value.slice(0, SHORT_TITLE_MAX_CHARS)), validate: () => shortTitle().trim().length === 0 ? "A tab title cannot be empty." : undefined },
    confirmLabel: "Rename",
    validate: (value) => value.trim().length === 0 ? "A description cannot be empty." : undefined,
  })
  if (title === undefined) return
  const patch: SessionTitlePatch = {
    ...(title !== originalTitle ? { title: title.trim() } : {}),
    ...(shortTitle() !== originalShortTitle ? { shortTitle: shortTitle().trim() } : {}),
  }
  if (patch.title !== undefined || patch.shortTitle !== undefined) client.actions.renameSession(sessionId, patch)
}

/** The session list's actions, with the confirmations and prompts they need.
 *  Shared by the rail and the sessions sheet so deleting a chat asks the same
 *  question in the same words wherever the list is drawn. */
export function useSessionActions(): SessionListActions {
  const client = useClient()
  const writeClipboardText = client.host.capabilities.writeClipboardText
  const titleOf = (sessionId: string) => summaryOf(client.state(), sessionId)?.title ?? sessionId
  return {
    onSelect: (sessionId) => {
      // A listed row's title is already the destination's name, so the pane
      // names it from the catalog without a label.
      if (client.stack) client.stack.openChat(sessionId)
      else client.actions.selectSession(sessionId)
      client.closeSheet()
    },
    ...(writeClipboardText === undefined ? {} : {
      onCopy: (sessionId: string) => { void copySessionId(writeClipboardText, client.report, sessionId) },
    }),
    working: (sessionId) => client.actions.sessionWorking(sessionId),
    onClose: (sessionId) => client.actions.closeSession(sessionId),
    onDelete: async (sessionId) => {
      // Modal and destructive-styled, because the runtime tombstones the
      // session and there is nothing to undo afterwards.
      const confirmed = await client.confirm({
        title: `Delete "${titleOf(sessionId)}"?`,
        detail: "The conversation and its history are removed. This cannot be undone. Files it changed on disk are not touched.",
        confirmLabel: "Delete",
        destructive: true,
      })
      if (confirmed) client.actions.removeSession(sessionId)
    },
    onRename: (sessionId) => promptSessionRename(client, sessionId),
  }
}
