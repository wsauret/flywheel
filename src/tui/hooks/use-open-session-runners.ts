import { createEffect, onCleanup, untrack, type Accessor } from "solid-js"
import type { OpenSessionKeeper } from "../../protocol/client/open-session-keeper.js"
import type { TabInfo } from "./create-tabs.js"

/** Waits for the shown view's reactive readiness. Disposal releases pending
 *  waits, so a keeper cannot retain this shell after it closes. */
export function createFocusedSessionReadiness(ready: Accessor<boolean>): () => Promise<void> {
  const waiters = new Set<() => void>()
  const release = (): void => {
    for (const resolve of waiters) resolve()
    waiters.clear()
  }
  createEffect(() => { if (ready()) release() })
  onCleanup(release)
  return () => ready() ? Promise.resolve() : new Promise<void>((resolve) => { waiters.add(resolve) })
}

/** Binds the open chat tabs to the session keeper: a tab that opens has its
 *  runner attached, a tab that closes releases its claim, and the keeper owns
 *  reattachment after the lane breaks. Claims start only once the shell is
 *  ready, so attaching never competes with the first frame. A pending tab
 *  names no session yet, so it takes no runner. The foreground tab names the
 *  keeper's focus, so a tab switch promotes a waiting activation at once. */
export function useOpenSessionRunners(deps: {
  readonly tabs: Accessor<readonly TabInfo[]>
  readonly ready: Accessor<boolean>
  readonly keeper: OpenSessionKeeper
}): void {
  const held = new Set<string>()
  createEffect(() => {
    if (!deps.ready()) return
    const tabs = deps.tabs()
    untrack(() => {
      const wanted = new Set(tabs.flatMap((tab) => (tab.kind === "session" ? [tab.id] : [])))
      for (const id of held) {
        if (wanted.has(id)) continue
        held.delete(id)
        deps.keeper.close(id)
      }
      for (const id of wanted) {
        if (held.has(id)) continue
        held.add(id)
        deps.keeper.open(id)
      }
      deps.keeper.focus(tabs.find((tab) => tab.kind === "session" && tab.isForeground)?.id)
    })
  })
  onCleanup(() => deps.keeper.dispose())
}
