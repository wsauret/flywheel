import type { Accessor } from "solid-js"
import { batch } from "solid-js"
import { errorMessage } from "../../infra/error-message.js"
import type { RuntimeClient, SessionCatalogRow } from "../../protocol/app-service-types.js"

import type { ShellServices } from "./shell-state.js"
import type { TabInfo } from "./create-tabs.js"
import type { DraftCache } from "./create-draft-cache.js"

interface TabCloserDeps {
  tabs: Accessor<readonly TabInfo[]>
  appService: Pick<RuntimeClient, "dispatch">
  switchForeground: (tabKey: string) => Promise<void>
  startChat: () => Promise<{ readonly kind: string }>
  closeSessionTab: (sessionId: string) => void
  removePendingTab: (key: string) => void
  draftCache: Pick<DraftCache, "clear">
  seedSessionCatalogRow: (row: SessionCatalogRow) => void
  showToast: ShellServices["showToast"]
}

export interface TabCloser {
  /** Closes a tab as the person asks: removes it, then closes its chat at rest. */
  closeTab(tabId: string): void
  /** Close chat: ends the chat's work now (PI-INTERACTION-082), then removes
   *  the tab that shows it, if one does. Rejects with the runtime's refusal,
   *  and then keeps the tab. */
  closeChat(sessionId: string): Promise<void>
}

/** Closes tabs and chats. The removal of a closed tab itself is pure UI intent and
 *  structurally unrefusable: it happens first, synchronously, no matter how
 *  broken the session behind it is. When the foreground goes, it falls back to
 *  the adjacent tab or a fresh chat. The runtime close that a tab close adds is
 *  durable cleanup -- its failure surfaces as a toast, never as a tab that
 *  refuses to close. It ends no work: the chat closes when its turn comes to
 *  rest (PI-INTERACTION-082). */
export function createTabCloser(deps: TabCloserDeps): TabCloser {
  const toastError = (err: unknown): void => { deps.showToast({ message: errorMessage(err), variant: "error" }) }

  /** Removes the tab, if this shell shows one, and answers the removed tab. */
  function remove(tabId: string): TabInfo | undefined {
    const list = deps.tabs()
    const idx = list.findIndex((t) => t.id === tabId)
    const target = list[idx]
    if (!target) return undefined
    const fallback = list[idx + 1] ?? list[idx - 1]
    // Foreground fallback and runtime close are independent chains: neither
    // failing may prevent the other, and neither may resurrect the tab.
    batch(() => {
      if (target.kind === "pending") deps.removePendingTab(tabId)
      else deps.closeSessionTab(tabId)
      if (target.isForeground) void (fallback ? deps.switchForeground(fallback.id) : deps.startChat()).catch(toastError)
    })
    return target
  }

  function closeTab(tabId: string): void {
    const list = deps.tabs()
    const only = list.length === 1 ? list[0] : undefined
    if (only?.id === tabId && only.kind === "session" && only.title === "New Chat" && !only.isBusy && !only.isBlocked) return
    const target = remove(tabId)
    if (!target) return
    if (target.kind === "pending") {
      // Focus changes flush the old composer buffer; clear its retired key last.
      deps.draftCache.clear(tabId)
      return
    }
    const cleanup = async () => {
      const result = await deps.appService.dispatch({ type: "session.close", sessionId: tabId, atRest: true })
      if (!result.ok) throw new Error(result.error)
      if (result.sessionCatalogRow) deps.seedSessionCatalogRow(result.sessionCatalogRow)
    }
    void cleanup().catch(toastError)
  }

  async function closeChat(sessionId: string): Promise<void> {
    const result = await deps.appService.dispatch({ type: "session.close", sessionId })
    if (!result.ok) throw new Error(result.error)
    if (result.sessionCatalogRow) deps.seedSessionCatalogRow(result.sessionCatalogRow)
    // Even a sole idle New Chat tab goes: Close chat removes an empty chat.
    remove(sessionId)
  }

  return { closeTab, closeChat }
}
