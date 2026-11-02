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

/** Closes a tab. The tab removal itself is pure UI intent and structurally
 *  unrefusable: it happens first, synchronously, no matter how broken the
 *  session behind it is. The runtime close that follows is durable cleanup --
 *  its failure surfaces as a toast, never as a tab that refuses to close. It
 *  ends no work: the chat closes when its turn comes to rest (PI-INTERACTION-082).
 *  When the foreground closes, falls back to the adjacent tab or a fresh chat. */
export function createTabCloser(deps: TabCloserDeps): (tabId: string) => void {
  return function closeTab(tabId: string): void {
    const list = deps.tabs()
    const idx = list.findIndex((t) => t.id === tabId)
    const target = list[idx]
    if (!target) return
    if (target.kind === "session" && list.length === 1 && target.title === "New Chat" && !target.isBusy && !target.isBlocked) return
    const fallback = list[idx + 1] ?? list[idx - 1]
    const toastError = (err: Error): void => { deps.showToast({ message: errorMessage(err), variant: "error" }) }
    // Foreground fallback and runtime close are independent chains: neither
    // failing may prevent the other, and neither may resurrect the tab.
    batch(() => {
      if (target.kind === "pending") deps.removePendingTab(tabId)
      else deps.closeSessionTab(tabId)
      if (target.isForeground) {
        void (fallback ? deps.switchForeground(fallback.id) : deps.startChat()).catch((err) => toastError(err instanceof Error ? err : new Error(String(err))))
      }
    })
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
    void cleanup().catch((err) => toastError(err instanceof Error ? err : new Error(String(err))))
  }
}
