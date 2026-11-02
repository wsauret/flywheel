import type { Accessor } from "solid-js"
import type { SessionCatalogRow } from "../../protocol/app-service-types.js"
import type { ShellSignals } from "./shell-state.js"
import type { TabInfo } from "./create-tabs.js"

interface ForegroundSwitcherDeps {
  signals: Pick<ShellSignals, "setForegroundId" | "setForegroundTarget">
  sessions: Accessor<readonly SessionCatalogRow[]>
  tabs: Accessor<readonly TabInfo[]>
}

/**
 * Selects a local tab key or a known durable session. Pending keys stay local;
 * shell-state loads a runtime view only for a durable foreground.
 */
export function createForegroundSwitcher(deps: ForegroundSwitcherDeps): (tabKey: string) => Promise<void> {
  const { signals, sessions } = deps

  return async function switchForeground(tabKey: string): Promise<void> {
    const tab = deps.tabs().find((row) => row.id === tabKey)
    if (tab?.kind === "pending") {
      signals.setForegroundTarget({ kind: "pending", key: tab.id })
      return
    }
    if (tab?.kind !== "session" && !sessions().some((s) => s.id === tabKey)) return
    signals.setForegroundId(tabKey)
  }
}
