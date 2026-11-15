import { createEffect, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { OpenSessionKeeper } from "../../protocol/client/open-session-keeper.js"
import type { TabInfo } from "./create-tabs.js"

const log = Log.create({ service: "session-shows" })

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

/** Shows a chat outside its tab, as a view over another tab does. */
export interface SessionShows {
  /** Holds the chat's runner as a tab does while the view shows it, and answers the end of the view. The end closes
   *  the chat once its turn is at rest, as a closed tab does (PI-INTERACTION-082), unless a tab shows the chat or
   *  `toTab` says that a tab opens it now. */
  show(sessionId: string): (toTab?: boolean) => void
}

/** Binds the open chat tabs and the views that show chats outside a tab to the session keeper: a chat that opens has
 *  its runner attached, a chat that no tab or view shows any more releases its claim, and the keeper owns
 *  reattachment after the lane breaks. Claims start only once the shell is ready, so attaching never competes with
 *  the first frame. A pending tab names no session yet, so it takes no runner. The foreground tab names the
 *  keeper's focus, so a tab switch promotes a waiting activation at once. */
export function useOpenSessionRunners(deps: {
  readonly tabs: Accessor<readonly TabInfo[]>
  readonly ready: Accessor<boolean>
  readonly keeper: OpenSessionKeeper
  readonly client: Pick<RuntimeClient, "dispatch">
}): SessionShows {
  const held = new Set<string>()
  // How many views show each chat outside a tab.
  const [views, setViews] = createSignal<ReadonlyMap<string, number>>(new Map())
  const tabSessions = (): Set<string> => new Set(deps.tabs().flatMap((tab) => (tab.kind === "session" ? [tab.id] : [])))
  createEffect(() => {
    if (!deps.ready()) return
    const tabs = deps.tabs()
    const wanted = new Set([...tabSessions(), ...views().keys()])
    untrack(() => {
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
  const count = (sessionId: string, by: 1 | -1): void => {
    setViews((current) => {
      const next = new Map(current)
      const shown = (next.get(sessionId) ?? 0) + by
      if (shown > 0) next.set(sessionId, shown)
      else next.delete(sessionId)
      return next
    })
  }
  return {
    show(sessionId) {
      count(sessionId, 1)
      let ended = false
      return (toTab = false) => {
        if (ended) return
        ended = true
        count(sessionId, -1)
        if (toTab || untrack(views).has(sessionId) || untrack(tabSessions).has(sessionId)) return
        void deps.client.dispatch({ type: "session.close", sessionId, atRest: true }).then((result) => {
          if (!result.ok) log.warn("a chat that a view showed could not close at rest", { sessionId, error: result.error })
        }, (cause: unknown) => { log.warn("a chat that a view showed could not close at rest", { sessionId, error: errorMessage(cause) }) })
      }
    },
  }
}
