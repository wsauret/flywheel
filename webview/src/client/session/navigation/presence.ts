import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"

import type { RuntimeConnection } from "../../../../../src/protocol/client/runtime/connection.js"
import { RuntimeLaneLost } from "../../../../../src/protocol/client/runtime/connection-failures.js"
import type { ClientHost, HostAttention } from "../../../host.js"

/** Reports the chat that the person is at for as long as the owner lives:
 *  `selected` names the chat the pane shows, or none, and `covered` says
 *  that something in front hides its transcript, such as the phone's list or
 *  a full workflow card. The person is at the selected chat while it is not
 *  covered and the host or the document says they are at the client.
 *  A host that knows better than the document, such as the editor with its
 *  window and view, gives its own attention. */
export function followPresence(deps: {
  readonly host: Pick<ClientHost, "capabilities">
  readonly connection: Pick<RuntimeConnection, "dispatch" | "onLane">
  readonly selected: () => string | undefined
  readonly covered: () => boolean
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- diagnostic sink: callers pass any caught value for logging
  readonly onDiagnostic: (message: string, detail?: unknown) => void
}): void {
  const attention = deps.host.capabilities.attention ?? documentAttention({ document, window })
  const [present, setPresent] = createSignal(attention.present())
  onCleanup(attention.onChange(() => setPresent(attention.present())))
  const presence = createPresenceReport(deps)
  onCleanup(presence.dispose)
  const at = createMemo(() => (present() && !deps.covered() ? deps.selected() : undefined))
  createEffect(() => presence.report(at()))
}

/** Whether the person is at this page, from the document: the page shows
 *  and has focus. A page that shows without focus, such as a browser window
 *  behind another window, does not count (PI-INTERACTION-187). */
export function documentAttention(page: {
  readonly document: Pick<Document, "visibilityState" | "hasFocus" | "addEventListener" | "removeEventListener">
  readonly window: Pick<Window, "addEventListener" | "removeEventListener">
}): HostAttention {
  const { document, window } = page
  return {
    present: () => document.visibilityState === "visible" && document.hasFocus(),
    onChange(listener) {
      document.addEventListener("visibilitychange", listener)
      window.addEventListener("focus", listener)
      window.addEventListener("blur", listener)
      return () => {
        document.removeEventListener("visibilitychange", listener)
        window.removeEventListener("focus", listener)
        window.removeEventListener("blur", listener)
      }
    },
  }
}

interface PresenceReport {
  /** Names the chat the person is at now, or none. */
  report(sessionId: string | undefined): void
  dispose(): void
}

/** Tells the account service which chat the person is at on this
 *  connection, or none (ARCH-SESSIONS-052). It sends only a change. The
 *  runtime forgets a presence when its connection ends, so each new lane
 *  hears the current one again. A report never moves anything on screen. */
export function createPresenceReport(deps: {
  readonly connection: Pick<RuntimeConnection, "dispatch" | "onLane">
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- diagnostic sink: callers pass any caught value for logging
  readonly onDiagnostic: (message: string, detail?: unknown) => void
}): PresenceReport {
  let current: string | undefined
  const send = (sessionId: string | undefined): void => {
    deps.connection.dispatch({ type: "chat.presence", ...(sessionId === undefined ? {} : { sessionId }) }).catch((cause: unknown) => {
      // A report that waited for a lane that broke is sent again on the next one.
      if (!(cause instanceof RuntimeLaneLost)) deps.onDiagnostic("the chat the person is at could not be reported", cause)
    })
  }
  const stopLanes = deps.connection.onLane(() => { if (current !== undefined) send(current) })
  return {
    report(sessionId) {
      if (sessionId === current) return
      current = sessionId
      send(sessionId)
    },
    dispose: stopLanes,
  }
}
