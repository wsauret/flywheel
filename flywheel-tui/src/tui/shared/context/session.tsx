/** @jsxImportSource @opentui/solid */

import { createSignal } from "solid-js"
import { createSimpleContext } from "./helper.js"
import type { SessionManager, SessionSummary } from "../../../orchestration/session/manager.js"

// Context value type

interface SessionContextValue {
  /** The underlying SessionManager instance. */
  manager: SessionManager

  /** Reactive signal: the cached session list. */
  sessions: () => SessionSummary[]
}

// Provider

export const { use: useSession, provider: SessionProvider } = createSimpleContext<
  SessionContextValue,
  { manager: SessionManager }
>({
  name: "Session",
  init: (props) => {
    const [sessions, setSessions] = createSignal<SessionSummary[]>([])

    // Load initial session list (crash recovery already ran in app.tsx before mount)
    const initialResult = props.manager.list()
    setSessions(initialResult.sessions)

    const refreshList = () => {
      const result = props.manager.list()
      setSessions(result.sessions)
    }

    props.manager.onChange = refreshList

    return {
      manager: props.manager,
      sessions,
    }
  },
})
